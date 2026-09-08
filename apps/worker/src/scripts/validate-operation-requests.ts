/**
 * Fase 3C — validación de integración: submission confirmada → operación PENDING.
 *
 * Corre contra el Supabase enlazado, con el pipeline REAL: arma queue items
 * como el webhook de AutoResponder y llama processMessage(), igual que
 * validate-submission-flow.ts. La confirmación pasa por la RPC transaccional
 * de verdad, no por un mock.
 *
 * Cubre §25 A–T y el recorrido del §26.
 *
 * Usage:  pnpm --filter @orderflow/worker validate:operations
 * Env:    DEMO_TENANT_ID (requerido)
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { randomUUID, randomBytes, randomInt } from 'node:crypto'
import { createClient } from '../lib/supabase'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import { hashDeviceToken } from '../lib/device-token'
import { processMessage } from '../processor'
import { executeEscalateToHuman } from '../tools/escalate-to-human'
import { handoffModeForProvider } from '../lib/human-handoff'
import { getSubmissionMessages } from '../lib/submission-messages'
import { AUTORESPONDER_APP_PACKAGE, WHATSAPP_BUSINESS_PACKAGE } from '../providers/autoresponder/inbound'
import type { Database } from '@orderflow/types'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }

const SYNC_TIMEOUT_MS = Number(process.env.AUTORESPONDER_SYNC_TIMEOUT_MS ?? 20_000)
const MSG = getSubmissionMessages('es')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newReference = () => {
  let c = ''
  for (let i = 0; i < 6; i++) c += ALPHABET[randomInt(0, ALPHABET.length)]
  return `SUB-${c}`
}

function queueRowFor(tenantId: string, accountId: string, payload: unknown): QueueRow {
  const now = new Date().toISOString()
  return {
    id: randomUUID(), tenant_id: tenantId, whatsapp_account_id: accountId,
    raw_payload: payload as QueueRow['raw_payload'], status: 'processing', attempts: 0,
    last_error: null, processed_at: null, processing_started_at: now, scheduled_at: now,
    created_at: now, updated_at: now,
  }
}

function arPayload(sender: string, message: string) {
  return {
    appPackageName: AUTORESPONDER_APP_PACKAGE, messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
    provider: 'autoresponder' as const, _internal_event_id: randomUUID(),
    query: { sender, message, isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false },
  }
}

// Los 7 intents con un payload válido para cada uno, y el kind que debe salir.
const INTENTS: Array<{ intent: string; kind: string; payload: Record<string, unknown> }> = [
  { intent: 'temporary_rental', kind: 'reservation_request',
    payload: { name: 'Ana Gómez', check_in: '2026-10-15', check_out: '2026-10-20', adults: 2, children: 1, has_pets: false } },
  { intent: 'property_visit', kind: 'visit_request',
    payload: { name: 'Bruno Díaz', preferred_date: '2026-12-10', preferred_time_range: 'morning' } },
  { intent: 'property_inquiry', kind: 'inquiry',
    payload: { name: 'Carla Ruiz', message: '¿Sigue disponible?' } },
  { intent: 'monthly_rental_inquiry', kind: 'inquiry',
    payload: { name: 'Diego Paz', move_in_date: '2026-11-01', occupants: 3 } },
  { intent: 'table_reservation', kind: 'table_request',
    payload: { name: 'Elena Vera', date: '2026-12-20', time: '21:30', people: 4 } },
  { intent: 'general_inquiry', kind: 'inquiry',
    payload: { name: 'Fabián Toro', message: '¿Tienen opciones sin TACC?' } },
  { intent: 'food_order', kind: 'order_request',
    payload: { name: 'Gabi Sosa', fulfillment: 'delivery', address: 'Calle Falsa 123', payment_method: 'cash' } },
]

async function main(): Promise<void> {
  console.log(HR)
  console.log('  Fase 3C — submission confirmada → operación PENDING (DB real, pipeline real)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const tenantId = process.env.DEMO_TENANT_ID ?? ''
  if (!tenantId) { nok('Tenant', 'DEMO_TENANT_ID es obligatorio'); process.exitCode = 1; return }

  const supabase = createClient()
  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('id', tenantId).maybeSingle()
  if (!tenant) { nok('Tenant', `${tenantId} no existe`); process.exitCode = 1; return }
  console.log(`  tenant: ${tenantId} (${tenant.name})`)
  console.log(`  target: ${(process.env.SUPABASE_URL ?? '').trim()}\n`)

  const accountIds: string[] = [], convIds: string[] = [], contactIds: string[] = []
  const subIds: string[] = [], tenantIds: string[] = []

  let n = 0
  const base = 4_300_000_000 + Math.floor(Math.random() * 600_000_000)
  const nextPhone = () => '549' + String(base + (++n)).padStart(10, '0')

  async function mkSubmission(o: {
    tenantId?: string; intent?: string; payload?: Record<string, unknown>
    status?: string; expiresAt?: string; contactId?: string | null
  } = {}) {
    const reference = newReference()
    const { data, error } = await supabase.from('form_submissions').insert({
      tenant_id: o.tenantId ?? tenantId,
      reference,
      intent: o.intent ?? 'temporary_rental',
      status: o.status ?? 'submitted',
      source: 'public_site',
      payload: (o.payload ?? INTENTS[0]!.payload) as never,
      idempotency_key: randomUUID(),
      contact_id: o.contactId ?? null,
      expires_at: o.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
    }).select('id, reference').single()
    if (error || !data) throw new Error(`submission: ${error?.message}`)
    subIds.push(data.id)
    return data
  }

  async function track(phone: string) {
    const { data: c } = await supabase.from('contacts').select('id')
      .eq('tenant_id', tenantId).eq('phone', phone).maybeSingle()
    if (!c) return
    if (!contactIds.includes(c.id)) contactIds.push(c.id)
    const { data: cs } = await supabase.from('conversations').select('id')
      .eq('tenant_id', tenantId).eq('contact_id', c.id)
    for (const x of cs ?? []) if (!convIds.includes(x.id)) convIds.push(x.id)
  }

  // Manda la referencia y después "sí". Devuelve el texto de la confirmación.
  async function confirmFlow(accountId: string, phone: string, reference: string) {
    await processMessage(queueRowFor(tenantId, accountId, arPayload(phone, `Referencia: ${reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS })
    await track(phone)
    const res = await processMessage(queueRowFor(tenantId, accountId, arPayload(phone, 'sí')),
      { timeoutMs: SYNC_TIMEOUT_MS })
    return res?.replyText ?? null
  }

  try {
    const { data: account, error: aErr } = await supabase.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: nextPhone(),
      inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), active: true,
    }).select('id').single()
    if (aErr || !account) { nok('Setup', aErr?.message); throw new Error('sin cuenta') }
    accountIds.push(account.id)
    ok('Setup: cuenta AutoResponder descartable')

    // ══ A–G. Los 7 intents producen una operación pending del kind correcto ══
    for (const spec of INTENTS) {
      const phone = nextPhone()
      const sub = await mkSubmission({ intent: spec.intent, payload: spec.payload })
      const reply = await confirmFlow(account.id, phone, sub.reference)

      if (reply !== MSG.confirmed) {
        nok(`${spec.intent}: la confirmación no respondió lo esperado`, JSON.stringify(reply).slice(0, 160))
        continue
      }

      const { data: ops } = await supabase.from('operation_requests')
        .select('id, kind, status, intent, contact_id, payload_snapshot, customer_confirmed_at, requested_date, requested_end_date, requested_time, decided_at')
        .eq('source_submission_id', sub.id)

      if ((ops ?? []).length !== 1) {
        nok(`${spec.intent}: se esperaba 1 operación`, `hay ${ops?.length ?? 0}`)
        continue
      }
      const op = ops![0]!

      if (op.kind === spec.kind && op.status === 'pending' && op.intent === spec.intent) {
        ok(`${spec.intent} → ${op.kind} (pending)`)
      } else {
        nok(`${spec.intent}: kind/status incorrectos`, JSON.stringify({ kind: op.kind, status: op.status }))
      }

      if (op.decided_at === null) ok(`${spec.intent}: nace sin decisión (decided_at NULL)`)
      else nok(`${spec.intent}: nació decidida`, String(op.decided_at))

      // El snapshot tiene que ser el payload, no una versión recortada.
      const snap = op.payload_snapshot as Record<string, unknown>
      const igual = Object.entries(spec.payload).every(([k, v]) => JSON.stringify(snap[k]) === JSON.stringify(v))
      if (igual) ok(`${spec.intent}: payload_snapshot completo`)
      else nok(`${spec.intent}: snapshot no coincide`, JSON.stringify(snap))
    }

    // ── Campos operativos extraídos ────────────────────────────────────────
    {
      const { data: rental } = await supabase.from('operation_requests')
        .select('requested_date, requested_end_date').eq('tenant_id', tenantId)
        .eq('intent', 'temporary_rental').order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (rental?.requested_date === '2026-10-15' && rental.requested_end_date === '2026-10-20') {
        ok('temporary_rental: check_in/check_out extraídos a requested_date/end_date')
      } else {
        nok('temporary_rental: fechas mal extraídas', JSON.stringify(rental))
      }

      const { data: table } = await supabase.from('operation_requests')
        .select('requested_date, requested_time').eq('tenant_id', tenantId)
        .eq('intent', 'table_reservation').order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (table?.requested_date === '2026-12-20' && String(table.requested_time).startsWith('21:30')) {
        ok('table_reservation: date/time extraídos')
      } else {
        nok('table_reservation: date/time mal extraídos', JSON.stringify(table))
      }
    }

    // ══ H/I. source_submission_id único · doble confirmación no duplica ═════
    {
      const phone = nextPhone()
      const sub = await mkSubmission()
      await confirmFlow(account.id, phone, sub.reference)

      const { data: opBefore } = await supabase.from('operation_requests')
        .select('id, created_at').eq('source_submission_id', sub.id).maybeSingle()

      // Segundo "sí" (evento nuevo) y reenvío de la referencia.
      await processMessage(queueRowFor(tenantId, account.id, arPayload(phone, 'sí')), { timeoutMs: SYNC_TIMEOUT_MS })
      await processMessage(queueRowFor(tenantId, account.id, arPayload(phone, `Referencia: ${sub.reference}`)), { timeoutMs: SYNC_TIMEOUT_MS })

      const { data: opsAfter } = await supabase.from('operation_requests')
        .select('id, created_at').eq('source_submission_id', sub.id)

      if ((opsAfter ?? []).length === 1 && opsAfter![0]!.id === opBefore?.id) {
        ok('I. reconfirmar no duplica ni recrea la operación')
      } else {
        nok('I. se duplicó la operación', `${opsAfter?.length} filas`)
      }

      // H — la garantía dura: el UNIQUE de la DB.
      const { error: dupErr } = await supabase.from('operation_requests').insert({
        tenant_id: tenantId, contact_id: contactIds[0]!, source_submission_id: sub.id,
        kind: 'inquiry', intent: 'general_inquiry', status: 'pending',
        payload_snapshot: {} as never, customer_confirmed_at: new Date().toISOString(),
      })
      if (dupErr?.code === '23505') ok('H. la DB rechaza una segunda operación para la misma submission (UNIQUE)')
      else nok('H. el UNIQUE no frenó el duplicado', dupErr?.message ?? 'insert exitoso')
    }

    // ══ J. Dos confirmaciones CONCURRENTES ══════════════════════════════════
    {
      const phone = nextPhone()
      const sub = await mkSubmission()
      await processMessage(queueRowFor(tenantId, account.id, arPayload(phone, `Referencia: ${sub.reference}`)),
        { timeoutMs: SYNC_TIMEOUT_MS })
      await track(phone)

      // Dos "sí" en paralelo, eventos distintos: el dedupe de mensajes no los
      // tapa, así que la carrera llega de verdad a la RPC.
      await Promise.all([
        processMessage(queueRowFor(tenantId, account.id, arPayload(phone, 'sí')), { timeoutMs: SYNC_TIMEOUT_MS }).catch(() => undefined),
        processMessage(queueRowFor(tenantId, account.id, arPayload(phone, 'si')), { timeoutMs: SYNC_TIMEOUT_MS }).catch(() => undefined),
      ])

      const { data: ops } = await supabase.from('operation_requests').select('id').eq('source_submission_id', sub.id)
      if ((ops ?? []).length === 1) ok('J. dos confirmaciones concurrentes → UNA sola operación')
      else nok('J. la carrera creó filas de más', `${ops?.length} operaciones`)

      const { data: s } = await supabase.from('form_submissions').select('status').eq('id', sub.id).maybeSingle()
      if (s?.status === 'confirmed') ok('J. la submission quedó confirmed exactamente una vez')
      else nok('J. estado inesperado tras la carrera', String(s?.status))
    }

    // ══ K. Aislamiento entre tenants ════════════════════════════════════════
    {
      const { data: other } = await supabase.from('tenants').insert({
        name: `[TEST] 3C otro ${Date.now()}`, slug: `test-3c-otro-${Date.now()}`, status: 'active',
      }).select('id').single()
      if (other) tenantIds.push(other.id)
      const sub = await mkSubmission({ tenantId: other!.id })

      // Acá NO se usa confirmFlow: ese helper devuelve la respuesta al "sí", y
      // en este caso el "sí" nunca llega al flujo de submissions (la referencia
      // ajena no deja pendiente), así que cae al pipeline de IA normal y la
      // respuesta es de DeepSeek. Lo que hay que mirar es la respuesta a la
      // REFERENCIA, que es donde vive la decisión de no-disclosure.
      const phone = nextPhone()
      const res = await processMessage(
        queueRowFor(tenantId, account.id, arPayload(phone, `Referencia: ${sub.reference}`)),
        { timeoutMs: SYNC_TIMEOUT_MS })
      await track(phone)

      const { data: ops } = await supabase.from('operation_requests').select('id').eq('source_submission_id', sub.id)
      if ((ops ?? []).length === 0) ok('K. una referencia de otro tenant NO crea operación')
      else nok('K. se creó una operación cruzando tenant', JSON.stringify(ops))
      if (res?.replyText === MSG.notFound) ok('K. y responde genérico, sin disclosure')
      else nok('K. respuesta inesperada a la referencia ajena', JSON.stringify(res?.replyText).slice(0, 160))

      const { data: s } = await supabase.from('form_submissions').select('status').eq('id', sub.id).maybeSingle()
      if (s?.status === 'submitted') ok('K. la submission del otro tenant quedó intacta')
      else nok('K. se tocó una submission de otro tenant', String(s?.status))
    }

    // ══ L. El contacto de la operación es el correcto ═══════════════════════
    {
      const phone = nextPhone()
      const sub = await mkSubmission()
      await confirmFlow(account.id, phone, sub.reference)

      const { data: c } = await supabase.from('contacts').select('id')
        .eq('tenant_id', tenantId).eq('phone', phone).maybeSingle()
      const { data: op } = await supabase.from('operation_requests')
        .select('contact_id, conversation_id').eq('source_submission_id', sub.id).maybeSingle()

      if (op?.contact_id === c?.id) ok('L. la operación quedó atada al contacto real')
      else nok('L. contact_id incorrecto', `${op?.contact_id} vs ${c?.id}`)
      if (op?.conversation_id) ok('L. y a la conversación de origen')
      else nok('L. conversation_id vacío')
    }

    // ══ M. Submission vencida no crea operación ═════════════════════════════
    {
      const phone = nextPhone()
      const sub = await mkSubmission({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      const r = await processMessage(queueRowFor(tenantId, account.id, arPayload(phone, `Referencia: ${sub.reference}`)),
        { timeoutMs: SYNC_TIMEOUT_MS })
      await track(phone)

      const { data: ops } = await supabase.from('operation_requests').select('id').eq('source_submission_id', sub.id)
      if ((ops ?? []).length === 0 && r?.replyText === MSG.expired) ok('M. vencida → sin operación, y avisa que venció')
      else nok('M. una vencida generó algo', `${ops?.length} ops · ${JSON.stringify(r?.replyText).slice(0, 120)}`)
    }

    // ══ N. Submission de otro contacto no crea operación ════════════════════
    {
      const phoneA = nextPhone(), phoneB = nextPhone()
      const sub = await mkSubmission()
      await processMessage(queueRowFor(tenantId, account.id, arPayload(phoneA, `Referencia: ${sub.reference}`)),
        { timeoutMs: SYNC_TIMEOUT_MS })
      await track(phoneA)

      const r = await processMessage(queueRowFor(tenantId, account.id, arPayload(phoneB, `Referencia: ${sub.reference}`)),
        { timeoutMs: SYNC_TIMEOUT_MS })
      await track(phoneB)

      const { data: ops } = await supabase.from('operation_requests').select('id').eq('source_submission_id', sub.id)
      if ((ops ?? []).length === 0 && r?.replyText === MSG.notFound) ok('N. otro contacto no puede confirmarla ni generar operación')
      else nok('N. un contacto ajeno avanzó', `${ops?.length} ops`)
    }

    // ══ O. Estados cancelled / confirmed no crean ═══════════════════════════
    {
      const phone = nextPhone()
      const sub = await mkSubmission({ status: 'cancelled' })
      const r = await processMessage(queueRowFor(tenantId, account.id, arPayload(phone, `Referencia: ${sub.reference}`)),
        { timeoutMs: SYNC_TIMEOUT_MS })
      await track(phone)

      const { data: ops } = await supabase.from('operation_requests').select('id').eq('source_submission_id', sub.id)
      if ((ops ?? []).length === 0 && r?.replyText === MSG.cancelled) ok('O. una submission cancelada no genera operación')
      else nok('O. una cancelada generó algo', `${ops?.length} ops`)
    }

    // ══ P/Q. Fail-safe: sin operación no hay confirmed ni pendiente limpia ══
    // Se fuerza el fallo con un intent que la DB acepta pero la RPC no mapea:
    // la RPC levanta excepción y revierte TODO.
    {
      const phone = nextPhone()
      const sub = await mkSubmission()
      await processMessage(queueRowFor(tenantId, account.id, arPayload(phone, `Referencia: ${sub.reference}`)),
        { timeoutMs: SYNC_TIMEOUT_MS })
      await track(phone)

      // Se llama la RPC directamente con un tenant que no corresponde: es la
      // forma limpia de ejercitar el camino "no se pudo crear la operación"
      // sin romper el schema a propósito. Lo que se verifica es que ese
      // desenlace NO deje la submission a medio confirmar.
      const { data: bad } = await supabase.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub.id, p_tenant_id: randomUUID(),
        p_contact_id: contactIds[0]!, p_conversation_id: undefined,
      })
      const outcome = (bad as { outcome?: string } | null)?.outcome
      if (outcome === 'not_found') ok('P. la RPC con tenant equivocado devuelve not_found y no escribe')
      else nok('P. outcome inesperado', String(outcome))

      const { data: s } = await supabase.from('form_submissions').select('status, confirmed_at').eq('id', sub.id).maybeSingle()
      if (s?.status === 'submitted' && s.confirmed_at === null) ok('P. la submission quedó intacta (submitted, sin confirmed_at)')
      else nok('P. la submission se tocó igual', JSON.stringify(s))

      const { data: c } = await supabase.from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', phone).maybeSingle()
      const { data: cv } = await supabase.from('conversations').select('pending_submission_id')
        .eq('tenant_id', tenantId).eq('contact_id', c!.id).maybeSingle()
      if (cv?.pending_submission_id === sub.id) ok('Q. la pendiente sigue viva: el cliente puede reintentar')
      else nok('Q. se perdió la pendiente sin éxito', String(cv?.pending_submission_id))
    }

    // ══ R. HUMAN sigue teniendo prioridad ═══════════════════════════════════
    {
      const phone = nextPhone()
      const sub = await mkSubmission()
      await processMessage(queueRowFor(tenantId, account.id, arPayload(phone, 'hola')), { timeoutMs: SYNC_TIMEOUT_MS })
      await track(phone)

      const { data: c } = await supabase.from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', phone).maybeSingle()
      const { data: cv } = await supabase.from('conversations').select('id')
        .eq('tenant_id', tenantId).eq('contact_id', c!.id).maybeSingle()
      await executeEscalateToHuman(tenantId, cv!.id, 'human_requested', handoffModeForProvider('autoresponder'))

      const r = await processMessage(queueRowFor(tenantId, account.id, arPayload(phone, `Referencia: ${sub.reference}`)),
        { timeoutMs: SYNC_TIMEOUT_MS })

      const { data: ops } = await supabase.from('operation_requests').select('id').eq('source_submission_id', sub.id)
      if (r?.replyText === null && (ops ?? []).length === 0) ok('R. durante HUMAN: silencio y ninguna operación')
      else nok('R. HUMAN no tuvo prioridad', `reply=${JSON.stringify(r?.replyText)} ops=${ops?.length}`)
    }

    // ══ S. Meta sin regresión ═══════════════════════════════════════════════
    {
      const { data: meta, error: mErr } = await supabase.from('whatsapp_accounts').insert({
        tenant_id: tenantId, provider: 'meta', phone_number: nextPhone(),
        business_account_id: `test-3c-${Date.now()}`,
        access_token_encrypted: `test-3c-token-${randomUUID()}`,
        webhook_secret: `test-3c-secret-${randomUUID()}`, active: true,
      }).select('id').single()

      if (mErr || !meta) { nok('S. no se pudo crear la cuenta Meta', mErr?.message) }
      else {
        accountIds.push(meta.id)
        const sub = await mkSubmission()
        const phone = nextPhone()
        await processMessage(queueRowFor(tenantId, meta.id, {
          object: 'whatsapp_business_account',
          entry: [{ id: 't', changes: [{ field: 'messages', value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '000', phone_number_id: 't' },
            contacts: [{ profile: { name: 'Meta 3C' }, wa_id: phone }],
            messages: [{ from: phone, id: `wamid.test3c.${randomUUID()}`,
              timestamp: String(Math.floor(Date.now() / 1000)), type: 'text',
              text: { body: `Referencia: ${sub.reference}` } }],
          } }] }],
        }), { timeoutMs: SYNC_TIMEOUT_MS })
        await track(phone)

        const { data: ops } = await supabase.from('operation_requests').select('id').eq('source_submission_id', sub.id)
        const { data: s } = await supabase.from('form_submissions').select('status').eq('id', sub.id).maybeSingle()
        if ((ops ?? []).length === 0 && s?.status === 'submitted') ok('S. Meta sin regresión: no entra al flujo ni crea operaciones')
        else nok('S. Meta entró al flujo 3C', `ops=${ops?.length} status=${s?.status}`)
      }
    }

    // ══ T. messaging_outbox intacto ═════════════════════════════════════════
    {
      const { data: outbox } = await supabase.from('messaging_outbox').select('id')
        .eq('tenant_id', tenantId).gte('created_at', new Date(Date.now() - 1_800_000).toISOString())
      if ((outbox ?? []).length === 0) ok('T. cero filas en messaging_outbox')
      else nok('T. se escribió en messaging_outbox', `${outbox!.length}`)
    }

    // ══ §I. PENDING no toca disponibilidad ══════════════════════════════════
    {
      const { count: reservas } = await supabase.from('reservations')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
        .gte('created_at', new Date(Date.now() - 1_800_000).toISOString())
      const { count: blocksA } = await supabase.from('availability_blocks')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
      const { count: blocksB } = await supabase.from('property_availability_blocks')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)

      if ((reservas ?? 0) === 0) ok('§I. no se creó ninguna reservation')
      else nok('§I. se creó una reservation', `${reservas}`)
      if ((blocksA ?? 0) === 0 && (blocksB ?? 0) === 0) ok('§I. cero bloqueos de disponibilidad')
      else nok('§I. se bloquearon fechas', `${blocksA} + ${blocksB}`)
    }

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of subIds) {
      try { await supabase.from('operation_requests').delete().eq('source_submission_id', id) } catch { /* noop */ }
    }
    for (const id of convIds) {
      try { await supabase.from('ai_usage_log').delete().eq('conversation_id', id) } catch { /* noop */ }
      try { await supabase.from('messages').delete().eq('conversation_id', id) } catch { /* noop */ }
      const { error } = await supabase.from('conversations').delete().eq('id', id)
      if (error) console.warn(`  ⚠ conversación ${id}: ${error.message}`)
    }
    for (const id of subIds) {
      const { error } = await supabase.from('form_submissions').delete().eq('id', id)
      if (error) console.warn(`  ⚠ submission ${id}: ${error.message}`)
    }
    for (const id of contactIds) {
      try { await supabase.from('contacts').delete().eq('id', id) } catch { /* noop */ }
    }
    for (const id of accountIds) {
      const { error } = await supabase.from('whatsapp_accounts').delete().eq('id', id)
      if (error) console.warn(`  ⚠ cuenta ${id}: ${error.message}`)
    }
    for (const id of tenantIds) {
      try { await supabase.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      try { await supabase.from('tenants').delete().eq('id', id) } catch { /* noop */ }
    }
    console.log(`  submissions: ${subIds.length} · conversaciones: ${convIds.length} · contactos: ${contactIds.length} · cuentas: ${accountIds.length} · tenants: ${tenantIds.length}`)
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => { console.error('[validate-operation-requests] fatal:', e instanceof Error ? e.message : String(e)); process.exit(1) })

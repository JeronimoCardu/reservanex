/**
 * Fase 3B — validación de integración del flujo
 * formulario → WhatsApp → recuperación → confirmación.
 *
 * Corre el pipeline REAL contra el Supabase enlazado: arma un queue item como
 * lo haría el webhook de AutoResponder y llama processMessage(item,
 * { timeoutMs }), igual que validate-autoresponder.ts. No hay mocks del
 * processor: lo que se prueba es el camino de producción.
 *
 * Las submissions se crean acá con el service role, que es exactamente lo que
 * hace el endpoint público por dentro. El camino HTTP del formulario
 * (validación por intent, idempotencia, referencia única) ya está cubierto por
 * `pnpm --filter @orderflow/web validate:forms`; acá lo que importa es lo que
 * pasa DESPUÉS, cuando la referencia llega por WhatsApp.
 *
 * Cubre §26 B–F, O–V y el recorrido completo del §27.
 *
 * Usage:  pnpm --filter @orderflow/worker validate:submissions
 * Env:    DEMO_TENANT_ID (requerido — correr `pnpm seed:demo` primero)
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

const HR   = '─'.repeat(78)
const PASS = '  ✓'
const FAIL = '  ✗'

let passed = 0
let failed = 0
function ok(label: string): void { console.log(`${PASS} ${label}`); passed++ }
function nok(label: string, detail?: string): void {
  console.error(`${FAIL} ${label}`)
  if (detail) console.error(`       ${detail}`)
  failed++
}

const SYNC_TIMEOUT_MS = Number(process.env.AUTORESPONDER_SYNC_TIMEOUT_MS ?? 20_000)
const MSG = getSubmissionMessages('es')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function newReference(): string {
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

function autoResponderPayload(sender: string, message: string) {
  return {
    appPackageName:       AUTORESPONDER_APP_PACKAGE,
    messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
    provider:             'autoresponder' as const,
    _internal_event_id:   randomUUID(),
    query: { sender, message, isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false },
  }
}

async function main(): Promise<void> {
  console.log(HR)
  console.log('  Fase 3B — formulario → WhatsApp → confirmación (DB real, pipeline real)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const tenantId = process.env.DEMO_TENANT_ID ?? ''
  if (!tenantId) {
    nok('Tenant', 'DEMO_TENANT_ID es obligatorio. Corré `pnpm seed:demo` primero.')
    process.exitCode = 1
    return
  }

  const supabase = createClient()
  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('id', tenantId).maybeSingle()
  if (!tenant) {
    nok('Tenant', `DEMO_TENANT_ID=${tenantId} no existe en este proyecto.`)
    process.exitCode = 1
    return
  }
  console.log(`  tenant: ${tenantId} (${tenant.name})`)
  console.log(`  target: ${(process.env.SUPABASE_URL ?? '').trim()}\n`)

  const createdAccountIds:      string[] = []
  const createdConversationIds: string[] = []
  const createdContactIds:      string[] = []
  const createdSubmissionIds:   string[] = []
  const createdTenantIds:       string[] = []

  let phoneCounter = 0
  const phoneBase = 4_100_000_000 + Math.floor(Math.random() * 800_000_000)
  const nextPhone = () => '549' + String(phoneBase + (++phoneCounter)).padStart(10, '0')

  async function createSubmission(opts: {
    tenantId:   string
    intent?:    string
    payload?:   Record<string, unknown>
    status?:    string
    expiresAt?: string
    contactId?: string | null
  }): Promise<{ id: string; reference: string }> {
    const reference = newReference()
    const { data, error } = await supabase
      .from('form_submissions')
      .insert({
        tenant_id:       opts.tenantId,
        reference,
        intent:          opts.intent  ?? 'temporary_rental',
        status:          opts.status  ?? 'submitted',
        source:          'public_site',
        payload:         (opts.payload ?? {
          name: 'Juan Pérez', check_in: '2026-10-15', check_out: '2026-10-20',
          adults: 2, children: 1, has_pets: false,
        }) as never,
        idempotency_key: randomUUID(),
        contact_id:      opts.contactId ?? null,
        expires_at:      opts.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
      })
      .select('id, reference')
      .single()
    if (error || !data) throw new Error(`no se pudo crear la submission: ${error?.message}`)
    createdSubmissionIds.push(data.id)
    return data
  }

  async function trackConversation(phone: string): Promise<void> {
    const { data: contact } = await supabase
      .from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', phone).maybeSingle()
    if (!contact) return
    if (!createdContactIds.includes(contact.id)) createdContactIds.push(contact.id)
    const { data: convs } = await supabase
      .from('conversations').select('id').eq('tenant_id', tenantId).eq('contact_id', contact.id)
    for (const c of convs ?? []) if (!createdConversationIds.includes(c.id)) createdConversationIds.push(c.id)
  }

  try {
    // ── Setup ────────────────────────────────────────────────────────────────
    const { data: account, error: acctErr } = await supabase
      .from('whatsapp_accounts')
      .insert({
        tenant_id: tenantId, provider: 'autoresponder', phone_number: nextPhone(),
        inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), active: true,
      })
      .select('id').single()
    if (acctErr || !account) { nok('Setup: cuenta AutoResponder', acctErr?.message); throw new Error('sin cuenta') }
    createdAccountIds.push(account.id)
    ok('Setup: cuenta AutoResponder descartable creada')

    // ══ B. Referencia válida + tenant correcto → resumen exacto ══════════════
    const phoneA = nextPhone()
    const subB   = await createSubmission({ tenantId })
    const resB = await processMessage(
      queueRowFor(tenantId, account.id,
        autoResponderPayload(phoneA, `Hola, completé el formulario en ReservaNex.\nReferencia: ${subB.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneA)
    const replyB = resB?.replyText ?? ''

    if (replyB.includes('Recibí estos datos') && replyB.includes('¿Es correcto?')) {
      ok('B. referencia válida del tenant correcto → resumen + pregunta de confirmación')
    } else {
      nok('B. no se devolvió el resumen', JSON.stringify(replyB).slice(0, 300))
    }

    // §27 punto 4 — el resumen tiene que ser EXACTO.
    const esperado = [
      'Tu nombre: Juan Pérez', 'Check-in: 15/10/2026', 'Check-out: 20/10/2026',
      'Adultos: 2', 'Niños: 1', '¿Viajás con mascotas?: No',
    ]
    const faltantes = esperado.filter((l) => !replyB.includes(l))
    if (faltantes.length === 0) ok('B. el resumen contiene exactamente los datos cargados')
    else nok('B. el resumen no coincide', `faltan: ${faltantes.join(' | ')}`)

    if (!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(replyB)) ok('B. el resumen no filtra ningún UUID')
    else nok('B. el resumen contiene un UUID', replyB.slice(0, 200))

    // ══ D. Contact binding en el primer uso ═════════════════════════════════
    const { data: boundRow } = await supabase
      .from('form_submissions').select('contact_id').eq('id', subB.id).maybeSingle()
    const { data: contactA } = await supabase
      .from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', phoneA).maybeSingle()

    if (boundRow?.contact_id && contactA && boundRow.contact_id === contactA.id) {
      ok('D. la submission quedó vinculada al contacto que mandó la referencia')
    } else {
      nok('D. binding de contacto incorrecto', `contact_id=${boundRow?.contact_id} esperado=${contactA?.id}`)
    }

    // ── pending_submission_id quedó apuntando a la submission ───────────────
    const { data: convA } = await supabase
      .from('conversations').select('id, pending_submission_id')
      .eq('tenant_id', tenantId).eq('contact_id', contactA!.id).maybeSingle()
    if (convA?.pending_submission_id === subB.id) {
      ok('E(state). conversation.pending_submission_id apunta a la submission correcta')
    } else {
      nok('E(state). pending_submission_id incorrecto', String(convA?.pending_submission_id))
    }

    // ══ E. Otro teléfono NO puede usar esa referencia ════════════════════════
    const phoneB = nextPhone()
    const resE = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneB, `Referencia: ${subB.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneB)

    if (resE?.replyText === MSG.notFound) {
      ok('E. un segundo teléfono recibe la respuesta genérica (sin disclosure)')
    } else {
      nok('E. un segundo teléfono no fue bloqueado', JSON.stringify(resE?.replyText).slice(0, 250))
    }
    if (!(resE?.replyText ?? '').includes('Juan Pérez')) {
      ok('E. no se filtró ningún dato del payload al segundo teléfono')
    } else {
      nok('E. FUGA: el payload llegó a otro contacto')
    }

    const { data: stillBound } = await supabase
      .from('form_submissions').select('contact_id').eq('id', subB.id).maybeSingle()
    if (stillBound?.contact_id === contactA!.id) ok('E. el binding original NO fue reasignado')
    else nok('E. el binding se reasignó', String(stillBound?.contact_id))

    // ══ C. Referencia de OTRO tenant ════════════════════════════════════════
    const { data: otherTenant } = await supabase.from('tenants').insert({
      name: `[TEST] 3B otro ${Date.now()}`, slug: `test-3b-otro-${Date.now()}`, status: 'active',
    }).select('id').single()
    if (otherTenant) createdTenantIds.push(otherTenant.id)
    const subOther = await createSubmission({ tenantId: otherTenant!.id })

    const phoneC = nextPhone()
    const resC = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneC, `Referencia: ${subOther.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneC)

    if (resC?.replyText === MSG.notFound) {
      ok('C. una referencia de OTRO tenant devuelve la respuesta genérica')
    } else {
      nok('C. cruce de tenant no bloqueado', JSON.stringify(resC?.replyText).slice(0, 250))
    }
    if (!(resC?.replyText ?? '').toLowerCase().includes('otro')) {
      ok('C. la respuesta no revela que la referencia exista en otro tenant')
    } else {
      nok('C. la respuesta revela información del otro tenant')
    }

    // ══ F. Submission vencida ═══════════════════════════════════════════════
    const phoneD = nextPhone()
    const subExp = await createSubmission({
      tenantId, expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const resF = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneD, `Referencia: ${subExp.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneD)

    if (resF?.replyText === MSG.expired) ok('F. una submission vencida responde "ya venció" y no muestra datos')
    else nok('F. la expiración no se respetó', JSON.stringify(resF?.replyText).slice(0, 250))

    const { data: expiredRow } = await supabase
      .from('form_submissions').select('status').eq('id', subExp.id).maybeSingle()
    if (expiredRow?.status === 'expired') ok('F. transición lazy a status=expired (sin cron)')
    else nok('F. no se marcó como expirada', String(expiredRow?.status))

    // ══ §27 / J. Confirmación con "sí" ══════════════════════════════════════
    const resJ = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneA, 'sí')),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    if (resJ?.replyText === MSG.confirmed) ok('§27. "sí" confirma y devuelve el mensaje controlado')
    else nok('§27. la confirmación no respondió lo esperado', JSON.stringify(resJ?.replyText).slice(0, 250))

    const { data: confirmedRow } = await supabase
      .from('form_submissions').select('status, confirmed_at, contact_id').eq('id', subB.id).maybeSingle()

    if (confirmedRow?.status === 'confirmed') ok('§27. DB: status = confirmed')
    else nok('§27. DB: status incorrecto', String(confirmedRow?.status))

    if (confirmedRow?.confirmed_at) ok(`§27. DB: confirmed_at seteado (${confirmedRow.confirmed_at})`)
    else nok('§27. DB: confirmed_at quedó null')

    if (confirmedRow?.contact_id === contactA!.id) ok('§27. DB: contact_id correcto')
    else nok('§27. DB: contact_id incorrecto', String(confirmedRow?.contact_id))

    const { data: convCleared } = await supabase
      .from('conversations').select('pending_submission_id').eq('id', convA!.id).maybeSingle()
    if (convCleared?.pending_submission_id === null) ok('§27. DB: pending_submission_id quedó NULL')
    else nok('§27. DB: pending_submission_id no se limpió', String(convCleared?.pending_submission_id))

    // El mensaje NO debe decir que hay una reserva confirmada (§14).
    const conf = resJ?.replyText ?? ''
    if (!/reserva (confirmada|realizada)|pedido confirmado/i.test(conf)) {
      ok('§14. el mensaje NO afirma que exista una reserva/pedido confirmado')
    } else {
      nok('§14. el mensaje confunde submission con reserva', conf)
    }

    // Y no se creó ninguna operación (§14 / §27).
    const { count: reservationCount } = await supabase
      .from('reservations').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).gte('created_at', new Date(Date.now() - 600_000).toISOString())
    if ((reservationCount ?? 0) === 0) ok('§14. no se creó ninguna reservation')
    else nok('§14. se creó una reservation, no debía', `count=${reservationCount}`)

    // ══ O / Q. Idempotencia y reenvío de una referencia ya confirmada ═══════
    //
    // Teléfono y submission PROPIOS a propósito. Reusar la conversación de
    // phoneA hacía que estos dos casos dependieran de cuántas auto-respuestas
    // le quedaban: un "sí" sin pendiente cae al pipeline de IA normal, consume
    // un slot de claim_ai_auto_reply_slot y, al llegar al límite, la
    // conversación pasa a HUMAN — con lo cual el siguiente inbound se
    // silencia (correctamente, §5) y el test fallaba por una razón que no
    // tenía nada que ver con lo que quería probar.
    const phoneO = nextPhone()
    const subO   = await createSubmission({ tenantId })
    await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneO, `Referencia: ${subO.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneO)

    // El MISMO inbound (mismo _internal_event_id) procesado dos veces.
    const dupPayload = autoResponderPayload(phoneO, 'sí')
    await processMessage(queueRowFor(tenantId, account.id, dupPayload), { timeoutMs: SYNC_TIMEOUT_MS })
    const { data: afterFirst } = await supabase
      .from('form_submissions').select('status, confirmed_at').eq('id', subO.id).maybeSingle()

    await processMessage(queueRowFor(tenantId, account.id, dupPayload), { timeoutMs: SYNC_TIMEOUT_MS })
    const { data: afterDup } = await supabase
      .from('form_submissions').select('status, confirmed_at').eq('id', subO.id).maybeSingle()

    if (afterFirst?.status === 'confirmed' &&
        afterDup?.status === 'confirmed' &&
        afterDup.confirmed_at === afterFirst.confirmed_at) {
      ok('O. reprocesar el mismo inbound no vuelve a confirmar ni pisa confirmed_at')
    } else {
      nok('O. la confirmación no fue idempotente',
        `antes=${afterFirst?.confirmed_at} después=${afterDup?.confirmed_at}`)
    }

    const { count: aiRepliesForDup } = await supabase
      .from('messages').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('sender_type', 'ai')
      .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', dupPayload._internal_event_id)
    if (aiRepliesForDup === 1) ok('O. el inbound duplicado generó UNA sola respuesta AI persistida')
    else nok('O. se duplicaron mensajes AI', `count=${aiRepliesForDup}`)

    // ══ Q. Reenviar una referencia ya confirmada ════════════════════════════
    const resQ = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneO, `Referencia: ${subO.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    if (resQ?.replyText === MSG.alreadyConfirmed) ok('Q. una referencia ya confirmada responde "ya fueron confirmados"')
    else nok('Q. no se detectó la submission ya confirmada', JSON.stringify(resQ?.replyText).slice(0, 250))

    // ══ M. Rechazo ══════════════════════════════════════════════════════════
    const phoneR = nextPhone()
    const subR = await createSubmission({ tenantId })
    await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneR, `Referencia: ${subR.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneR)
    const resM = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneR, 'no, está mal')),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    if (resM?.replyText === MSG.rejected) ok('M. el rechazo responde el mensaje controlado')
    else nok('M. el rechazo no respondió lo esperado', JSON.stringify(resM?.replyText).slice(0, 250))

    const { data: rejectedRow } = await supabase
      .from('form_submissions').select('status, confirmed_at').eq('id', subR.id).maybeSingle()
    if (rejectedRow?.status === 'submitted' && rejectedRow.confirmed_at === null) {
      ok('M. tras el rechazo la submission sigue en submitted, sin confirmed_at')
    } else {
      nok('M. el rechazo cambió el estado', JSON.stringify(rejectedRow))
    }

    // ══ N. Ambigua ══════════════════════════════════════════════════════════
    const phoneN = nextPhone()
    const subN = await createSubmission({ tenantId })
    await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneN, `Referencia: ${subN.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneN)
    const resN = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneN, '¿me confirmás el precio?')),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    if (resN?.replyText === MSG.ambiguous) ok('N. una respuesta ambigua vuelve a preguntar Sí/No')
    else nok('N. la ambigüedad no se manejó', JSON.stringify(resN?.replyText).slice(0, 250))

    const { data: subNRow } = await supabase
      .from('form_submissions').select('status').eq('id', subN.id).maybeSingle()
    if (subNRow?.status === 'submitted') ok('N. la ambigüedad NO confirmó nada')
    else nok('N. una respuesta ambigua cambió el estado', String(subNRow?.status))

    const { data: contactN } = await supabase
      .from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', phoneN).maybeSingle()
    const { data: convN } = await supabase
      .from('conversations').select('pending_submission_id')
      .eq('tenant_id', tenantId).eq('contact_id', contactN!.id).maybeSingle()
    if (convN?.pending_submission_id === subN.id) ok('N. la pendiente se mantiene tras una respuesta ambigua')
    else nok('N. se perdió la pendiente', String(convN?.pending_submission_id))

    // ══ P. Una referencia nueva reemplaza la pendiente ══════════════════════
    const subP = await createSubmission({ tenantId, intent: 'property_visit', payload: {
      name: 'Bruno Díaz', preferred_date: '2026-12-10', preferred_time_range: 'morning',
    } })
    const resP = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneN, `Referencia: ${subP.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    const { data: convP } = await supabase
      .from('conversations').select('pending_submission_id')
      .eq('tenant_id', tenantId).eq('contact_id', contactN!.id).maybeSingle()

    if (convP?.pending_submission_id === subP.id) ok('P. la referencia nueva reemplaza pending_submission_id')
    else nok('P. no se actualizó la pendiente', String(convP?.pending_submission_id))

    if ((resP?.replyText ?? '').includes('Horario preferido: Mañana (9 a 12)')) {
      ok('P. el resumen del nuevo intent usa la etiqueta legible del select')
    } else {
      nok('P. resumen del nuevo intent incorrecto', JSON.stringify(resP?.replyText).slice(0, 250))
    }

    const { data: subNAfter } = await supabase
      .from('form_submissions').select('status').eq('id', subN.id).maybeSingle()
    if (subNAfter?.status === 'submitted') ok('P. la submission anterior sigue en submitted (no se cancela)')
    else nok('P. la anterior cambió de estado', String(subNAfter?.status))

    // ══ R / S. HUMAN tiene prioridad ════════════════════════════════════════
    const phoneH = nextPhone()
    const subH = await createSubmission({ tenantId })
    await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneH, 'hola')),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneH)

    const { data: contactH } = await supabase
      .from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', phoneH).maybeSingle()
    const { data: convH } = await supabase
      .from('conversations').select('id').eq('tenant_id', tenantId).eq('contact_id', contactH!.id).maybeSingle()

    // Mismo mecanismo estructurado que usa la IA, con la semántica temporal de
    // AutoResponder (ventana deslizante) — igual que validate-autoresponder.ts.
    await executeEscalateToHuman(
      tenantId, convH!.id, 'human_requested', handoffModeForProvider('autoresponder'),
    )

    const resR = await processMessage(
      queueRowFor(tenantId, account.id, autoResponderPayload(phoneH, `Referencia: ${subH.reference}`)),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )

    if (resR?.replyText === null) ok('R. durante HUMAN una referencia produce silencio (replies: [])')
    else nok('R. HUMAN no tuvo prioridad', JSON.stringify(resR?.replyText).slice(0, 250))

    const { data: subHRow } = await supabase
      .from('form_submissions').select('status, contact_id').eq('id', subH.id).maybeSingle()
    if (subHRow?.status === 'submitted' && subHRow.contact_id === null) {
      ok('S. durante HUMAN la submission NO se toca (sin binding, sin cambio de estado)')
    } else {
      nok('S. la submission se modificó durante HUMAN', JSON.stringify(subHRow))
    }

    const { data: convHRow } = await supabase
      .from('conversations').select('pending_submission_id').eq('id', convH!.id).maybeSingle()
    if (convHRow?.pending_submission_id === null) ok('S. durante HUMAN no se setea pending_submission_id')
    else nok('S. se seteó la pendiente durante HUMAN', String(convHRow?.pending_submission_id))

    // ══ T. Sin referencia ni pendiente → pipeline normal ════════════════════
    const phoneT = nextPhone()
    const resT = await processMessage(
      queueRowFor(tenantId, account.id,
        autoResponderPayload(phoneT, 'Hola, tenés algo para 4 personas en enero?')),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    await trackConversation(phoneT)

    const replyT = resT?.replyText ?? ''
    if (replyT.length > 0 && !replyT.includes('Recibí estos datos') && replyT !== MSG.notFound) {
      ok(`T. sin referencia el pipeline de IA normal sigue funcionando (${replyT.length} chars de DeepSeek)`)
    } else {
      nok('T. el pipeline normal se rompió', JSON.stringify(replyT).slice(0, 250))
    }

    // ══ U. messaging_outbox intacto ═════════════════════════════════════════
    const { data: outbox } = await supabase
      .from('messaging_outbox').select('id').eq('tenant_id', tenantId)
      .gte('created_at', new Date(Date.now() - 900_000).toISOString())
    if ((outbox ?? []).length === 0) ok('U. cero filas en messaging_outbox en todo el flujo')
    else nok('U. se escribió en messaging_outbox', `${outbox!.length} fila(s)`)

    const { data: mediaEvents } = await supabase
      .from('media_events').select('id').eq('tenant_id', tenantId)
      .gte('created_at', new Date(Date.now() - 900_000).toISOString())
    if ((mediaEvents ?? []).length === 0) ok('U. cero filas en media_events')
    else nok('U. se escribió en media_events', `${mediaEvents!.length} fila(s)`)

    // ══ V. Meta sin regresión ═══════════════════════════════════════════════
    // El flujo de submissions sale por 'skip' si el provider no es
    // autoresponder, así que un inbound de Meta con una referencia válida
    // debe seguir por el pipeline de siempre — no por este.
    const { data: metaAccount, error: metaErr } = await supabase
      .from('whatsapp_accounts')
      .insert({
        tenant_id: tenantId, provider: 'meta', phone_number: nextPhone(),
        // whatsapp_accounts_provider_fields_check exige los tres para 'meta'.
        // Son valores de prueba y NUNCA se usan: este caso manda solo texto, y
        // el token de Meta solo se lee para descargar media.
        business_account_id:    `test-3b-${Date.now()}`,
        access_token_encrypted: `test-3b-token-${randomUUID()}`,
        webhook_secret:         `test-3b-secret-${randomUUID()}`,
        active: true,
      })
      .select('id').single()

    if (metaErr || !metaAccount) {
      nok('V. no se pudo crear la cuenta Meta de prueba', metaErr?.message)
    } else {
      createdAccountIds.push(metaAccount.id)
      const subV = await createSubmission({ tenantId })
      const phoneV = nextPhone()
      const metaPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'test', changes: [{
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '000', phone_number_id: 'test' },
              contacts: [{ profile: { name: 'Meta Test' }, wa_id: phoneV }],
              messages: [{
                from: phoneV, id: `wamid.test3b.${randomUUID()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text', text: { body: `Referencia: ${subV.reference}` },
              }],
            },
          }],
        }],
      }

      await processMessage(queueRowFor(tenantId, metaAccount.id, metaPayload), { timeoutMs: SYNC_TIMEOUT_MS })
      await trackConversation(phoneV)

      const { data: subVRow } = await supabase
        .from('form_submissions').select('status, contact_id').eq('id', subV.id).maybeSingle()

      if (subVRow?.status === 'submitted' && subVRow.contact_id === null) {
        ok('V. Meta sin regresión: el flujo de submissions no se activa para Meta')
      } else {
        nok('V. Meta entró al flujo de submissions', JSON.stringify(subVRow))
      }
    }

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)

    // Fase 3C — las operaciones se borran ANTES que nada: operation_requests
    // referencia conversations, contacts Y form_submissions, las tres sin
    // CASCADE. Con cualquier otro orden, el DELETE de la conversación falla
    // por FK y arrastra el de la cuenta.
    for (const id of createdSubmissionIds) {
      const { error } = await supabase.from('operation_requests').delete().eq('source_submission_id', id)
      if (error) console.warn(`  ⚠ no se pudo borrar la operación de ${id}: ${error.message}`)
    }

    for (const id of createdConversationIds) {
      // ai_usage_log también referencia conversations: cada llamada a DeepSeek
      // deja una fila ahí. Si no se borra primero, el DELETE de la
      // conversación falla por FK y arrastra el de la cuenta.
      try { await supabase.from('ai_usage_log').delete().eq('conversation_id', id) } catch { /* noop */ }
      try { await supabase.from('messages').delete().eq('conversation_id', id) } catch { /* noop */ }
      const { error: convErr } = await supabase.from('conversations').delete().eq('id', id)
      if (convErr) console.warn(`  ⚠ no se pudo borrar la conversación ${id}: ${convErr.message}`)
    }
    for (const id of createdSubmissionIds) {
      // Fase 3C: operation_requests.source_submission_id referencia
      // form_submissions sin CASCADE, así que la operación se borra primero o
      // el DELETE de la submission falla por FK.
      try { await supabase.from('operation_requests').delete().eq('source_submission_id', id) } catch { /* noop */ }
      const { error: subErr } = await supabase.from('form_submissions').delete().eq('id', id)
      if (subErr) console.warn(`  ⚠ no se pudo borrar la submission ${id}: ${subErr.message}`)
    }
    for (const id of createdContactIds) {
      try { await supabase.from('contacts').delete().eq('id', id) } catch { /* noop */ }
    }
    for (const id of createdAccountIds) {
      // Se reporta el error en vez de tragárselo: una cuenta de prueba que
      // sobrevive queda compitiendo con la real en
      // getTenantAutoResponderWhatsApp() y ensucia el tenant de QA.
      const { error: acctErr } = await supabase.from('whatsapp_accounts').delete().eq('id', id)
      if (acctErr) console.warn(`  ⚠ no se pudo borrar la cuenta ${id}: ${acctErr.message}`)
    }
    for (const id of createdTenantIds) {
      try { await supabase.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      try { await supabase.from('tenants').delete().eq('id', id) } catch { /* noop */ }
    }
    console.log(`  conversaciones: ${createdConversationIds.length} · submissions: ${createdSubmissionIds.length} · contactos: ${createdContactIds.length} · cuentas: ${createdAccountIds.length} · tenants: ${createdTenantIds.length}`)
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('[validate-submission-flow] error fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})

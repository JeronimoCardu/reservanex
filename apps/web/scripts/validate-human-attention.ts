/**
 * Atención humana V2 — validador físico.
 *
 * Crea tenants [TEST] aislados con owner/receptionists reales (logins de
 * verdad, RLS de verdad) y conversaciones en cada estado del ciclo, y
 * comprueba contra la base:
 *
 *   §1-6   qué aparece en la bandeja y para quién (owner / receptionist / otro tenant)
 *   §8-9   "Marcar como atendido" y su interacción con el gate de IA
 *   §4     la reactivación automática NO resuelve la atención humana
 *   §10-17 el recordatorio de las 2 h: claim, idempotencia, ciclos, concurrencia,
 *          release ante fallo del proveedor, sin owner, tenant suspendido
 *   paridad: la columna generada human_attention_pending == isHumanAttentionPending()
 *
 * NUNCA manda un email real: el runner recibe un sender que registra en
 * memoria. Todo se purga en `finally`.
 *
 * Usage:  pnpm --filter @orderflow/web validate:human-attention
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import {
  humanAttentionAttendedPatch,
  isHumanAttentionPending,
} from '../src/lib/human-attention/semantics'
import { runHumanAttentionReminders } from '../src/lib/human-attention/reminders'
import type { EmailSender, OutgoingEmail, SendEmailResult } from '../src/lib/email/send-email'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }
function check(cond: boolean, label: string, detail?: string) { if (cond) ok(label); else nok(label, detail) }

const H = 60 * 60 * 1000
const ATTENTION_URL = 'https://reservanex.test/dashboard/attention'

/** Sender de prueba: registra, nunca manda. Puede fallar a pedido. */
function fakeSender(): EmailSender & { sent: OutgoingEmail[]; failNext: number } {
  const s = {
    sent: [] as OutgoingEmail[],
    failNext: 0,
    async send(email: OutgoingEmail): Promise<SendEmailResult> {
      if (s.failNext > 0) { s.failNext--; return { ok: false, reason: 'provider_error', detail: 'simulado' } }
      s.sent.push(email)
      return { ok: true, id: `fake-${s.sent.length}` }
    },
  }
  return s
}

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const RUN     = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Atención humana V2')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authIds:   string[] = []

  const anonClient = () => createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // ── Fixtures ─────────────────────────────────────────────────────────────
    async function buildTenant(label: string, opts: { status?: string; owners: number; receptionists: number }) {
      const { data: t, error } = await admin.from('tenants')
        .insert({
          name: `[TEST] ATT ${label} ${RUN}`,
          slug: `test-att-${label.toLowerCase()}-${RUN}`,
          status: opts.status ?? 'trial', vertical: 'food_service', timezone: 'America/Argentina/Buenos_Aires',
          primary_owner_email: `prospecto-${label.toLowerCase()}-${RUN}@example.test`,
        } as never).select('id').single()
      if (error || !t) throw new Error(`tenant: ${error?.message}`)
      tenantIds.push(t.id)

      async function mkUser(kind: string, role: 'owner' | 'receptionist', active = true) {
        const password = randomBytes(18).toString('hex')
        const email    = `${kind}-att-${label.toLowerCase()}-${RUN}@example.test`
        const { data: au, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
        if (e || !au.user) throw new Error(`user: ${e?.message}`)
        authIds.push(au.user.id)
        const { error: tu } = await admin.from('tenant_users').insert({
          id: au.user.id, tenant_id: t!.id, name: `${kind} ${label}`, email, role, active,
        } as never)
        if (tu) throw new Error(`tenant_users: ${tu.message}`)
        return { id: au.user.id, email, password }
      }

      // idx_one_active_owner_per_tenant: la base admite UN solo owner activo por
      // tenant. El segundo owner (si se pide) se crea INACTIVO para probar que
      // no recibe el email.
      const owners = [] as { id: string; email: string; password: string }[]
      for (let i = 0; i < opts.owners; i++) owners.push(await mkUser(`owner${i}`, 'owner', i === 0))
      const receps = [] as { id: string; email: string; password: string }[]
      for (let i = 0; i < opts.receptionists; i++) receps.push(await mkUser(`recep${i}`, 'receptionist'))

      const { data: contact } = await admin.from('contacts')
        // Sólo dígitos: RUN trae un guion y el href de WhatsApp se compara literal.
        .insert({ tenant_id: t.id, phone: `5491${label.charCodeAt(0)}${RUN.replace(/\D/g, '').slice(-8)}`, name: `Cliente ${label}` })
        .select('id, phone').single()
      if (!contact) throw new Error('contact')

      return { id: t.id, owners, receps, contactId: contact.id, contactPhone: contact.phone! }
    }

    const A = await buildTenant('A', { owners: 2, receptionists: 2 })
    const B = await buildTenant('B', { owners: 1, receptionists: 0 })
    const C = await buildTenant('C', { owners: 0, receptionists: 1 })
    const D = await buildTenant('D', { status: 'suspended', owners: 1, receptionists: 0 })
    ok('Fixture: A (1 owner activo + 1 inactivo, 2 receps) · B (aislamiento) · C (sin owner) · D (suspended)')

    const now   = new Date()
    const nowMs = now.getTime()
    const iso   = (ms: number) => new Date(ms).toISOString()

    async function conv(tenantId: string, contactId: string, patch: Record<string, unknown>) {
      const { data, error } = await admin.from('conversations')
        .insert({ tenant_id: tenantId, contact_id: contactId, ...patch } as never)
        .select('id').single()
      if (error || !data) throw new Error(`conversation: ${error?.message}`)
      return data.id as string
    }

    // Tenant A — un caso por estado del ciclo.
    const a1 = await conv(A.id, A.contactId, {   // handoff real, 3 h, IA en pausa
      ai_mode: 'manual', needs_human_attention: true, ai_handoff_reason: 'human_requested',
      human_attention_requested_at: iso(nowMs - 3 * H), human_until: iso(nowMs - 2 * H),
      last_message_content: 'Quiero hablar con una persona', last_message_sender_type: 'customer', last_message_at: iso(nowMs - 3 * H),
    })
    const a2 = await conv(A.id, A.contactId, { ai_mode: 'autonomous' })                 // nunca pidió humano
    const a3 = await conv(A.id, A.contactId, {                                          // resuelto después del pedido
      ai_mode: 'autonomous', human_attention_requested_at: iso(nowMs - 1 * H),
      human_attention_resolved_at: iso(nowMs - 30 * 60_000), human_attention_resolved_by: A.owners[0]!.id,
    })
    const a4 = await conv(A.id, A.contactId, {                                          // IA reactivada por expiración: sigue pendiente
      ai_mode: 'autonomous', needs_human_attention: false, ai_handoff_reason: null, ai_handoff_at: null, human_until: null,
      human_attention_requested_at: iso(nowMs - 3 * H),
    })
    const a5 = await conv(A.id, A.contactId, {                                          // pendiente pero < 2 h
      ai_mode: 'manual', needs_human_attention: true, ai_handoff_reason: 'auto_reply_limit',
      human_attention_requested_at: iso(nowMs - 30 * 60_000),
    })
    const a6 = await conv(A.id, A.contactId, {                                          // asignado a recep1 → recep0 no lo ve
      ai_mode: 'manual', needs_human_attention: true, ai_handoff_reason: 'human_requested',
      human_attention_requested_at: iso(nowMs - 3 * H), assigned_user_id: A.receps[1]!.id,
    })
    const a7 = await conv(A.id, A.contactId, {                                          // cerrada
      ai_mode: 'manual', status: 'closed', closed_at: iso(nowMs), human_attention_requested_at: iso(nowMs - 3 * H),
    })
    const b1 = await conv(B.id, B.contactId, {
      ai_mode: 'manual', needs_human_attention: true, ai_handoff_reason: 'human_requested',
      human_attention_requested_at: iso(nowMs - 3 * H),
    })
    const c1 = await conv(C.id, C.contactId, {
      ai_mode: 'manual', needs_human_attention: true, human_attention_requested_at: iso(nowMs - 3 * H),
    })
    const d1 = await conv(D.id, D.contactId, {
      ai_mode: 'manual', needs_human_attention: true, human_attention_requested_at: iso(nowMs - 3 * H),
    })
    ok('Fixture: 7 conversaciones en A + 1 en B, C y D')

    // ── Paridad columna generada ↔ función pura ──────────────────────────────
    {
      const { data } = await admin.from('conversations')
        .select('id, status, human_attention_requested_at, human_attention_resolved_at, human_attention_email_sent_at, human_attention_pending')
        .in('tenant_id', [A.id, B.id, C.id, D.id])
      const rows = data ?? []
      const mismatch = rows.filter((r) => (r.human_attention_pending === true) !== isHumanAttentionPending(r))
      check(rows.length === 10 && mismatch.length === 0,
        `paridad: human_attention_pending (DB) == isHumanAttentionPending() en ${rows.length} filas`,
        mismatch.map((m) => m.id).join(', '))
      const esperado: Record<string, boolean> = { [a1]: true, [a2]: false, [a3]: false, [a4]: true, [a5]: true, [a6]: true, [a7]: false, [b1]: true, [c1]: true, [d1]: true }
      const byId = new Map(rows.map((r) => [r.id, r.human_attention_pending === true]))
      const malos = Object.entries(esperado).filter(([id, v]) => byId.get(id) !== v)
      check(malos.length === 0, '1-3. pendiente sólo los ciclos abiertos y no resueltos después (a1,a4,a5,a6; no a2,a3,a7)', malos.map(([id]) => id).join(', '))
      check(byId.get(a4) === true, '4. IA reactivada por expiración (autonomous, needs=false) → SIGUE pendiente')
    }

    // ── RLS: la bandeja de cada rol ──────────────────────────────────────────
    async function login(u: { email: string; password: string }): Promise<SupabaseClient<Database>> {
      const c = anonClient()
      const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password })
      if (error) throw new Error(`login ${u.email}: ${error.message}`)
      return c
    }
    // Misma query que listPendingHumanAttention (repo usa el cliente del usuario).
    async function bandeja(c: SupabaseClient<Database>, tenantId: string) {
      const { data, error } = await c.from('conversations').select('id, assigned_user_id')
        .eq('tenant_id', tenantId).eq('human_attention_pending', true).order('human_attention_requested_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []).map((r) => r.id)
    }
    async function badge(c: SupabaseClient<Database>, tenantId: string) {
      const { count } = await c.from('conversations').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('human_attention_pending', true)
      return count ?? 0
    }

    const asOwnerA  = await login(A.owners[0]!)
    const asRecep0A = await login(A.receps[0]!)
    const asRecep1A = await login(A.receps[1]!)
    const asOwnerB  = await login(B.owners[0]!)
    ok('Logins reales: owner A, recep0 A, recep1 A, owner B')

    {
      const o = await bandeja(asOwnerA, A.id)
      check(o.length === 4 && o[0] === a1 && o.includes(a4) && o.includes(a5) && o.includes(a6),
        '5. owner A ve sus 4 casos, más antiguo primero', o.join(','))
      check(await badge(asOwnerA, A.id) === 4, 'badge owner A = 4 (casos, no mensajes)')

      const r0 = await bandeja(asRecep0A, A.id)
      check(r0.length === 3 && !r0.includes(a6), '6. recep0 A ve los sin asignar (3) y NO el asignado a recep1', r0.join(','))
      const r1 = await bandeja(asRecep1A, A.id)
      check(r1.length === 4 && r1.includes(a6), '6. recep1 A ve los sin asignar + el suyo (4)', r1.join(','))
      check(await badge(asRecep0A, A.id) === 3 && await badge(asRecep1A, A.id) === 4, 'badge respeta RLS por usuario (3 / 4)')

      const cross = await bandeja(asOwnerB, A.id)
      const ownB  = await bandeja(asOwnerB, B.id)
      check(cross.length === 0 && ownB.length === 1 && ownB[0] === b1, '4. aislamiento multi-tenant: owner B no ve A; ve su b1')
    }

    // ── 8-9. Marcar como atendido (mismo patch que el repositorio, vía RLS) ──
    {
      const t0 = new Date().toISOString()
      const { data: upd, error } = await asOwnerA.from('conversations')
        .update(humanAttentionAttendedPatch(A.owners[0]!.id, t0)).eq('tenant_id', A.id).eq('id', a1)
        .select('ai_mode, needs_human_attention, human_until, ai_handoff_reason, ai_handoff_at, ai_auto_replies_count, ai_reactivated_by, ai_context_reset_at, human_attention_resolved_at, human_attention_resolved_by, human_attention_requested_at, human_attention_pending').single()
      check(!error && !!upd, '8. owner marca a1 como atendido (UPDATE vía RLS)', error?.message)
      if (upd) {
        check(upd.human_attention_pending === false && upd.human_attention_resolved_by === A.owners[0]!.id && upd.human_attention_resolved_at !== null,
          '8. a1 sale de la bandeja; resolved_at/by registrados')
        check(upd.ai_mode === 'autonomous' && upd.needs_human_attention === false && upd.human_until === null
          && upd.ai_handoff_reason === null && upd.ai_handoff_at === null && upd.ai_auto_replies_count === 0
          && upd.ai_reactivated_by === A.owners[0]!.id && upd.ai_context_reset_at !== null,
          '9. IA reactivada coherente: autonomous, human_until=null, contador 0, contexto reseteado, actor registrado')
        check(upd.human_attention_requested_at !== null, '8. requested_at se conserva como historial')
      }
      const { count: msgs } = await admin.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', a1)
      check((msgs ?? 0) === 0, '8. mensajes intactos (no se tocaron: 0 antes, 0 después)')
      check(await badge(asOwnerA, A.id) === 3, 'badge owner A baja a 3')

      // recep0 no puede marcar el asignado a recep1 (RLS: 0 filas, sin error)
      const { data: ajeno } = await asRecep0A.from('conversations')
        .update(humanAttentionAttendedPatch(A.receps[0]!.id, t0)).eq('tenant_id', A.id).eq('id', a6).select('id')
      const { data: a6row } = await admin.from('conversations').select('human_attention_pending').eq('id', a6).single()
      check((ajeno?.length ?? 0) === 0 && a6row?.human_attention_pending === true, '6. recep0 NO puede marcar un caso asignado a otro (RLS)')
    }

    // ── 4. Simular la reactivación por expiración del worker sobre a5 ───────
    {
      // Mismo UPDATE que processor.ts (human_expired): cambia el gate de IA,
      // no toca resolved_at.
      await admin.from('conversations').update({
        ai_mode: 'autonomous', human_until: null, ai_context_reset_at: new Date().toISOString(),
        needs_human_attention: false, ai_auto_replies_count: 0, ai_handoff_reason: null, ai_handoff_at: null,
      }).eq('id', a5)
      const { data } = await admin.from('conversations').select('human_attention_pending, human_attention_resolved_at').eq('id', a5).single()
      check(data?.human_attention_pending === true && data?.human_attention_resolved_at === null,
        '4. expiry-reactivation (gate de IA) NO resuelve la atención: a5 sigue pendiente, resolved_at null')
    }

    // ── 10-17. Recordatorio de las 2 h ───────────────────────────────────────
    const sender = fakeSender()
    const run = (deps: Partial<Parameters<typeof runHumanAttentionReminders>[0]> = {}, tenantId?: string) =>
      runHumanAttentionReminders({ admin, sender, attentionUrl: ATTENTION_URL, now, tenantId, ...deps })

    {
      const r = await run({}, A.id)
      const sentIds = r.sent.map((s) => s.conversationId).sort()
      check(sentIds.join(',') === [a4, a6].sort().join(','), '11. tick A: envía a4 y a6 (≥2 h, pendientes); no a1 (atendido) ni a5 (<2 h)', JSON.stringify(r))
      check(r.sent.every((s) => s.recipients === 1), 'K. cada email va al ÚNICO owner activo de A (el inactivo no cuenta)', JSON.stringify(r.sent))
      const to = sender.sent.flatMap((e) => e.to)
      check(to.every((e) => e === A.owners[0]!.email) && !to.some((e) => e.includes('prospecto-') || e.startsWith('recep') || e === A.owners[1]!.email),
        'K. destinatario = tenant_users owner ACTIVO; nunca el inactivo, primary_owner_email ni receptionists', to.join(','))
      check(sender.sent.every((e) => /sigue marcada como pendiente en ReservaNex/.test(e.html) && !/sin respuesta|nadie respondi/i.test(e.html)),
        '18. el email enviado no afirma falta de respuesta humana')
      check(sender.sent.some((e) => e.html.includes(`https://wa.me/${A.contactPhone}`) && e.html.includes(ATTENTION_URL)),
        '16. CTAs: wa.me del contacto + /dashboard/attention')

      const { data: a5row } = await admin.from('conversations').select('human_attention_email_sent_at').eq('id', a5).single()
      check(a5row?.human_attention_email_sent_at === null, '10. a5 (<2 h) no fue claimeado')
    }
    {
      const before = sender.sent.length
      const r = await run({}, A.id)
      check(r.sent.length === 0 && sender.sent.length === before && r.skipped.every((s) => s.reason === 'not_due'),
        '12. segundo tick, mismo ciclo: 0 emails (sent_at ≥ requested_at)', JSON.stringify(r))
    }
    {
      // 13. resolver antes de las 2 h → no email cuando pasen
      const t0 = new Date().toISOString()
      await admin.from('conversations').update(humanAttentionAttendedPatch(A.owners[0]!.id, t0)).eq('id', a5)
      const r = await run({ now: new Date(nowMs + 5 * H) }, A.id)
      check(!r.sent.some((s) => s.conversationId === a5), '13. a5 resuelto antes de las 2 h → no recibe email aunque pasen 5 h')
    }
    {
      // 14. nuevo ciclo en a4 (ya emailado): atendido → nuevo handoff → elegible otra vez
      const t1 = new Date(nowMs + 1 * H).toISOString()
      await admin.from('conversations').update(humanAttentionAttendedPatch(A.owners[0]!.id, t1)).eq('id', a4)
      await admin.from('conversations').update({
        ai_mode: 'manual', needs_human_attention: true, ai_handoff_reason: 'human_requested', ai_handoff_at: iso(nowMs + 24 * H),
        human_attention_requested_at: iso(nowMs + 24 * H),
      }).eq('id', a4)
      const r0 = await run({ now: new Date(nowMs + 25 * H) }, A.id)
      check(!r0.sent.some((s) => s.conversationId === a4), '14. segundo handoff, 1 h después → todavía no')
      const r1 = await run({ now: new Date(nowMs + 26 * H) }, A.id)
      check(r1.sent.some((s) => s.conversationId === a4), '14. segundo handoff, 2 h después → NUEVO email (requested_at > sent_at)')
    }
    {
      // 15. concurrencia: dos ticks a la vez sobre un caso nuevo → 1 email
      const a8 = await conv(A.id, A.contactId, {
        ai_mode: 'manual', needs_human_attention: true, ai_handoff_reason: 'human_requested', human_attention_requested_at: iso(nowMs - 3 * H),
      })
      const s1 = fakeSender(), s2 = fakeSender()
      const [r1, r2] = await Promise.all([
        runHumanAttentionReminders({ admin, sender: s1, attentionUrl: ATTENTION_URL, now, tenantId: A.id }),
        runHumanAttentionReminders({ admin, sender: s2, attentionUrl: ATTENTION_URL, now, tenantId: A.id }),
      ])
      const total = [...r1.sent, ...r2.sent].filter((s) => s.conversationId === a8).length
      const lost  = [...r1.skipped, ...r2.skipped].filter((s) => s.conversationId === a8 && s.reason === 'lost_claim').length
      check(total === 1 && lost === 1, '15. dos ticks concurrentes → exactamente 1 email, 1 lost_claim', `sent=${total} lost=${lost}`)
    }
    {
      // fallo del proveedor después del claim → release → reintento OK
      const a9 = await conv(A.id, A.contactId, {
        ai_mode: 'manual', needs_human_attention: true, human_attention_requested_at: iso(nowMs - 3 * H),
      })
      const s = fakeSender(); s.failNext = 1
      const r = await runHumanAttentionReminders({ admin, sender: s, attentionUrl: ATTENTION_URL, now, tenantId: A.id })
      const f = r.failed.find((x) => x.conversationId === a9)
      const { data: row } = await admin.from('conversations').select('human_attention_email_sent_at').eq('id', a9).single()
      check(!!f && f.released && row?.human_attention_email_sent_at === null, 'I. Resend falla tras el claim → claim liberado (sent_at vuelve a NULL)', JSON.stringify(f))
      const r2 = await runHumanAttentionReminders({ admin, sender: s, attentionUrl: ATTENTION_URL, now, tenantId: A.id })
      check(r2.sent.some((x) => x.conversationId === a9), 'I. el próximo tick reintenta y envía')
    }
    {
      // 16. sin owner activo → no claim, no envío, reintentable
      const r = await run({}, C.id)
      const { data: row } = await admin.from('conversations').select('human_attention_email_sent_at').eq('id', c1).single()
      check(r.sent.length === 0 && r.skipped.some((s) => s.conversationId === c1 && s.reason === 'no_recipient') && row?.human_attention_email_sent_at === null,
        '16. tenant sin owner activo → no_recipient, sin claim (se reintenta después)', JSON.stringify(r))
    }
    {
      // 17. tenant suspendido → ni candidato
      const r = await run({}, D.id)
      const { data: row } = await admin.from('conversations').select('human_attention_email_sent_at').eq('id', d1).single()
      check(r.scanned === 0 && r.sent.length === 0 && row?.human_attention_email_sent_at === null, '17. tenant suspended → 0 candidatos, 0 emails', JSON.stringify(r))
    }
    {
      // aislamiento del cron: un tick acotado a B no toca A y viceversa
      const s = fakeSender()
      const r = await runHumanAttentionReminders({ admin, sender: s, attentionUrl: ATTENTION_URL, now, tenantId: B.id })
      check(r.sent.length === 1 && r.sent[0]!.conversationId === b1 && s.sent[0]!.to.length === 1 && s.sent[0]!.to[0] === B.owners[0]!.email,
        'K. tick B: 1 email, sólo al owner de B', JSON.stringify(r))
    }
  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      try { await admin.from('conversations').delete().eq('tenant_id', id) } catch { /* noop */ }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      try { await admin.from('tenants').delete().eq('id', id) } catch { /* noop */ }
    }
    for (const id of authIds) { try { await admin.auth.admin.deleteUser(id) } catch { /* noop */ } }
    const { count } = await admin.from('tenants').select('id', { count: 'exact', head: true }).like('name', '[TEST] ATT %')
    console.log(`  tenants: ${tenantIds.length} · usuarios: ${authIds.length} · [TEST] ATT restantes: ${count ?? '?'}`)
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('[validate-human-attention] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

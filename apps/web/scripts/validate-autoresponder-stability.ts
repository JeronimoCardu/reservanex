/**
 * MVP P0-A — estabilidad de AutoResponder, validada contra la base REAL del
 * laboratorio (reservanex-lab).
 *
 *   pnpm --filter @orderflow/web validate:autoresponder-stability
 *
 * Pasa por el guard anti-producción (scripts/lab/lab-db-target.ts). Ejercita
 * las dos RPCs de la migración 20261013000001 como service_role:
 *
 *   · claim_ai_auto_reply_slot — sesiones de 8 h por inactividad del cliente
 *     (con los created_at reales de messages), 25 respuestas completas por
 *     sesión y el fusible atómico en el intento siguiente;
 *   · claim_next_pollable_message_queue_item — el poller genérico nunca
 *     reclama filas de AutoResponder (y la carrera original, reproducida con
 *     una copia congelada del claim anterior).
 *
 * Datos sintéticos (tenant lab-p0a-*), borrados al final pase lo que pase.
 */

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { requireLabConnection } from './lab/lab-db'

const lab = requireLabConnection()
const RUN = Date.now().toString(36)
const HR = '─'.repeat(78)
const H = 3_600_000

let passed = 0
let failed = 0
function log(text: string) { console.log(lab.redact(text)) }
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { log(`  ✓ ${label}`); passed++ }
  else { console.error(lab.redact(`  ✗ ${label}${detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`}`)); failed++ }
}
function section(title: string) { log(`\n${title}`) }

type Slot = { outcome: string; new_count: number; reply_limit: number; session_reset: boolean }

let main: pg.Client
const workers: pg.Client[] = []
let tenantId: string | null = null

async function asServiceRole<T>(c: pg.Client, run: () => Promise<T>): Promise<T> {
  await c.query('BEGIN')
  try {
    await c.query('SET LOCAL ROLE service_role')
    const value = await run()
    await c.query('COMMIT')
    return value
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function newConversation(): Promise<string> {
  const contactId = randomUUID()
  const conversationId = randomUUID()
  await main.query(`INSERT INTO public.contacts (id, tenant_id, phone, name) VALUES ($1, $2, $3, 'LAB P0-A')`,
    [contactId, tenantId, `54911${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`])
  await main.query(`INSERT INTO public.conversations (id, tenant_id, contact_id, ai_mode) VALUES ($1, $2, $3, 'autonomous')`,
    [conversationId, tenantId, contactId])
  return conversationId
}

/** Inbound del cliente con un created_at controlado (como lo deja buildContext). */
async function inbound(conversationId: string, at: Date): Promise<string> {
  const { rows: [r] } = await main.query<{ id: string }>(
    `INSERT INTO public.messages (tenant_id, conversation_id, sender_type, content, created_at)
     VALUES ($1, $2, 'customer', 'hola', $3) RETURNING id`, [tenantId, conversationId, at.toISOString()])
  return r!.id
}

async function claim(conversationId: string, messageId: string, humanUntil: Date | null = null, c: pg.Client = main): Promise<Slot> {
  return asServiceRole(c, async () => {
    const { rows: [r] } = await c.query<Slot>(
      'SELECT * FROM public.claim_ai_auto_reply_slot($1, $2, $3, $4)',
      [conversationId, tenantId, messageId, humanUntil?.toISOString() ?? null])
    return r!
  })
}

async function conv(conversationId: string) {
  const { rows: [r] } = await main.query<{
    ai_mode: string; ai_auto_replies_count: number; ai_auto_replies_limit: number; needs_human_attention: boolean
    ai_handoff_reason: string | null; human_until: Date | null; ai_session_last_inbound_at: Date | null
  }>(`SELECT ai_mode::text, ai_auto_replies_count, ai_auto_replies_limit, needs_human_attention, ai_handoff_reason,
             human_until, ai_session_last_inbound_at FROM public.conversations WHERE id = $1`, [conversationId])
  return r!
}

/** Corre `n` claims a la vez, cada uno en su conexión, saliendo juntos de una barrera. */
async function concurrentClaims(conversationId: string, messageIds: string[]): Promise<Slot[]> {
  let count = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return Promise.all(messageIds.map(async (messageId, i) => {
    const c = workers[i]!
    await c.query('BEGIN')
    try {
      await c.query('SET LOCAL ROLE service_role')
      if (++count === messageIds.length) release()
      await gate
      const { rows: [r] } = await c.query<Slot>('SELECT * FROM public.claim_ai_auto_reply_slot($1, $2, $3, NULL)', [conversationId, tenantId, messageId])
      await c.query('SELECT pg_sleep(0.2)')
      await c.query('COMMIT')
      return r!
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  }))
}

// ── Sesiones y límite ────────────────────────────────────────────────────────

async function sessions() {
  section('Sesiones de 8 h y límite 25 (claim_ai_auto_reply_slot)')
  const T0 = new Date(Date.now() - 72 * H)

  // A · dentro de < 8 h comparten sesión
  const a = await newConversation()
  const a1 = await claim(a, await inbound(a, T0))
  const a2 = await claim(a, await inbound(a, new Date(T0.getTime() + 1 * H)))
  check('A · primer inbound abre sesión (count 1, session_reset); el siguiente a 1 h la comparte (count 2)',
    a1.outcome === 'claimed' && a1.new_count === 1 && a1.session_reset && a2.outcome === 'claimed' && a2.new_count === 2 && !a2.session_reset, [a1, a2])

  // B · >= 8 h reinicia; 7 h 59 m no
  const b7 = await claim(a, await inbound(a, new Date(T0.getTime() + 1 * H + 7 * H + 59 * 60_000)))
  const b8 = await claim(a, await inbound(a, new Date(T0.getTime() + 1 * H + 7 * H + 59 * 60_000 + 8 * H)))
  check('B · 7 h 59 m después: misma sesión (count 3); 8 h después: sesión nueva (count 1, session_reset)',
    b7.new_count === 3 && !b7.session_reset && b8.new_count === 1 && b8.session_reset, [b7, b8])
  const exact = await newConversation()
  await claim(exact, await inbound(exact, T0))
  const ex = await claim(exact, await inbound(exact, new Date(T0.getTime() + 8 * H)))
  check('B · exactamente 8 h → sesión nueva (>= 8 h)', ex.session_reset && ex.new_count === 1, ex)

  // C / D · 25 completas, el intento 26 dispara el fusible una sola vez
  const cd = await newConversation()
  const results: Slot[] = []
  for (let i = 0; i < 25; i++) results.push(await claim(cd, await inbound(cd, new Date(T0.getTime() + i * 60_000))))
  check('C · 25 respuestas completas permitidas en una sesión (counts 1..25, todas claimed)',
    results.every((r, i) => r.outcome === 'claimed' && r.new_count === i + 1 && r.reply_limit === 25), results.map((r) => `${r.outcome}:${r.new_count}`))
  const humanUntil = new Date(Date.now() + H)
  const fuse = await claim(cd, await inbound(cd, new Date(T0.getTime() + 26 * 60_000)), humanUntil)
  const afterFuse = await conv(cd)
  check('D · el intento 26 → fuse_tripped; la conversación queda en HUMAN (manual, atención, motivo, human_until)',
    fuse.outcome === 'fuse_tripped' && afterFuse.ai_mode === 'manual' && afterFuse.needs_human_attention &&
    afterFuse.ai_handoff_reason === 'auto_reply_limit' && afterFuse.human_until?.getTime() === humanUntil.getTime() &&
    afterFuse.ai_auto_replies_count === 25, { fuse, afterFuse })
  const after = await claim(cd, await inbound(cd, new Date(T0.getTime() + 27 * 60_000)))
  check('D · después del fusible: not_autonomous (sin segundo mensaje de handoff), contador intacto',
    after.outcome === 'not_autonomous' && (await conv(cd)).ai_auto_replies_count === 25, after)

  // E · 9 ayer + 1 hoy (> 8 h) → normal; y una conversación EN el límite también reinicia con sesión nueva
  const e = await newConversation()
  const yesterday = new Date(Date.now() - 30 * H)
  for (let i = 0; i < 9; i++) await claim(e, await inbound(e, new Date(yesterday.getTime() + i * 60_000)))
  const today = await claim(e, await inbound(e, new Date()))
  check('E · 9 respuestas ayer + mensaje hoy (> 8 h) → claimed, count 1, sin handoff',
    today.outcome === 'claimed' && today.new_count === 1 && today.session_reset && (await conv(e)).ai_mode === 'autonomous', today)
  const full = await newConversation()
  for (let i = 0; i < 25; i++) await claim(full, await inbound(full, new Date(yesterday.getTime() + i * 60_000)))
  const fullToday = await claim(full, await inbound(full, new Date()))
  check('E · 25 ayer (en el límite, sin intento 26) + mensaje hoy → sesión nueva, NO fusible',
    fullToday.outcome === 'claimed' && fullToday.new_count === 1, fullToday)

  // I · marcar atendido (mismo patch que humanAttentionAttendedPatch) → la IA retoma con el contador en 0
  await main.query(
    `UPDATE public.conversations SET ai_mode = 'autonomous', ai_auto_replies_count = 0, ai_handoff_reason = NULL,
       ai_handoff_at = NULL, needs_human_attention = false, human_until = NULL, ai_reactivated_at = now(),
       ai_context_reset_at = now(), human_attention_resolved_at = now() WHERE id = $1`, [cd])
  const reactivated = await claim(cd, await inbound(cd, new Date(T0.getTime() + 28 * 60_000)))
  check('I · marcar atendido después del fusible → la IA retoma: claimed, count 1 (misma sesión)',
    reactivated.outcome === 'claimed' && reactivated.new_count === 1 && !reactivated.session_reset, reactivated)

  // J · HUMAN → not_autonomous, contador intacto
  const j = await newConversation()
  await claim(j, await inbound(j, T0))
  await main.query(`UPDATE public.conversations SET ai_mode = 'manual', human_until = now() + interval '1 hour' WHERE id = $1`, [j])
  const human = await claim(j, await inbound(j, new Date(T0.getTime() + 60_000)))
  check('J · conversación en HUMAN → not_autonomous, el contador no se mueve',
    human.outcome === 'not_autonomous' && (await conv(j)).ai_auto_replies_count === 1, human)

  // Fuera de orden: el inbound más nuevo se procesa primero
  const o = await newConversation()
  await claim(o, await inbound(o, T0))
  const m1 = await inbound(o, new Date(T0.getTime() + 9 * H))
  const m2 = await inbound(o, new Date(T0.getTime() + 9 * H + 1_000))
  const first = await claim(o, m2)
  const second = await claim(o, m1)
  const oc = await conv(o)
  check('fuera de orden: el más nuevo primero abre la sesión (1), el anterior la comparte (2); la marca no retrocede',
    first.session_reset && first.new_count === 1 && !second.session_reset && second.new_count === 2 &&
    oc.ai_session_last_inbound_at?.getTime() === T0.getTime() + 9 * H + 1_000, { first, second })

  // Inbound inexistente → reloj de la base (no rompe)
  const ghost = await claim(o, randomUUID())
  check('inbound inexistente → usa now(): claimed sin error', ghost.outcome === 'claimed', ghost)

  // Concurrencia en el borde
  const k = await newConversation()
  for (let i = 0; i < 24; i++) await claim(k, await inbound(k, new Date(Date.now() - 2 * H + i * 1_000)))
  const at24 = await concurrentClaims(k, [await inbound(k, new Date()), await inbound(k, new Date())])
  const outcomes24 = at24.map((r) => r.outcome).sort()
  check('borde: contador 24 + 2 inbounds simultáneos → uno claimed (25) y uno fuse_tripped',
    JSON.stringify(outcomes24) === JSON.stringify(['claimed', 'fuse_tripped']), at24)
  const z = await newConversation()
  for (let i = 0; i < 25; i++) await claim(z, await inbound(z, new Date(Date.now() - 2 * H + i * 1_000)))
  const at25 = await concurrentClaims(z, [await inbound(z, new Date()), await inbound(z, new Date()), await inbound(z, new Date())])
  const tally = at25.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {})
  check('borde: contador 25 + 3 inbounds simultáneos → exactamente 1 fuse_tripped (un solo mensaje de handoff)',
    tally.fuse_tripped === 1 && tally.not_autonomous === 2, tally)

  // Default 25
  const { rows: [d] } = await main.query<{ def: string }>(
    `SELECT column_default AS def FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'ai_auto_replies_limit'`)
  check('default de ai_auto_replies_limit = 25 (y las conversaciones nuevas lo heredan)', d!.def === '25' && (await conv(a)).ai_auto_replies_limit === 25, d)
}

// ── Poller ───────────────────────────────────────────────────────────────────

const AR_PAYLOAD = { query: { sender: '+5491100000000', message: 'hola' }, appPackageName: 'x', provider: 'autoresponder' }
const AR_MARKER_ONLY = { provider: 'autoresponder', note: 'sobre sin query' }
const AR_QUERY_ONLY = { query: { sender: '+5491100000000', message: 'hola' } }
const META_PAYLOAD = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.x' }] } }] }] }

async function enqueue(payload: unknown, opts: { attempts?: number; status?: string; ageSeconds?: number } = {}): Promise<string> {
  const { rows: [r] } = await main.query<{ id: string }>(
    `INSERT INTO public.message_queue (tenant_id, raw_payload, attempts, status, created_at)
     VALUES ($1, $2, $3, $4::queue_status, now() - make_interval(secs => $5)) RETURNING id`,
    [tenantId, JSON.stringify(payload), opts.attempts ?? 0, opts.status ?? 'pending', opts.ageSeconds ?? 0])
  return r!.id
}
async function pollClaim(c: pg.Client = main): Promise<string | null> {
  return asServiceRole(c, async () => (await c.query<{ id: string }>('SELECT id FROM public.claim_next_pollable_message_queue_item()')).rows[0]?.id ?? null)
}
async function statusOf(id: string) {
  return (await main.query<{ status: string; last_error: string | null }>('SELECT status::text, last_error FROM public.message_queue WHERE id = $1', [id])).rows[0]!
}

async function poller() {
  section('Poller genérico (claim_next_pollable_message_queue_item)')
  const { rows: [foreign] } = await main.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.message_queue WHERE status = 'pending' AND tenant_id IS DISTINCT FROM $1`, [tenantId])
  if (foreign!.n > 0) {
    check('el lab no tiene filas pendientes ajenas (si las hay, no se tocan y se saltea esta sección)', false, foreign)
    return
  }

  // Carrera original, reproducida
  const ar = await enqueue(AR_PAYLOAD, { ageSeconds: 30 })
  await main.query('BEGIN')
  const { rows: [old] } = await main.query<{ id: string }>(
    // Copia CONGELADA del claim anterior a P0-A: "la pendiente más vieja" + UPDATE, sin filtro de proveedor.
    `UPDATE public.message_queue SET status = 'processing', processing_started_at = now()
     WHERE id = (SELECT id FROM public.message_queue WHERE status = 'pending' AND attempts < 3 ORDER BY created_at LIMIT 1) AND status = 'pending'
     RETURNING id`)
  await main.query('ROLLBACK')
  check('ANTES: el claim viejo del poller se llevaba la fila AutoResponder recién encolada (la carrera)', old?.id === ar, old)
  check('DESPUÉS: el poller nuevo no la reclama', (await pollClaim()) === null)
  const { rows: [byId] } = await main.query<{ id: string }>(
    // Igual que claimQueueItemById (camino síncrono).
    `UPDATE public.message_queue SET status = 'processing', processing_started_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [ar])
  check('el claim síncrono por id sigue funcionando sobre esa fila', byId?.id === ar)

  // Mezcla
  const arOld = await enqueue(AR_PAYLOAD, { ageSeconds: 60 })
  const arMarker = await enqueue(AR_MARKER_ONLY, { ageSeconds: 50 })
  const arQuery = await enqueue(AR_QUERY_ONLY, { ageSeconds: 40 })
  const metaExhausted = await enqueue(META_PAYLOAD, { ageSeconds: 35, attempts: 3 })
  const meta1 = await enqueue(META_PAYLOAD, { ageSeconds: 20 })
  const meta2 = await enqueue(META_PAYLOAD, { ageSeconds: 10 })
  const got1 = await pollClaim()
  check('mezcla: salta las 3 AutoResponder (payload completo, sólo marca provider, sólo query) y la Meta agotada; toma la Meta más vieja',
    got1 === meta1, { got1, meta1 })
  check('las AutoResponder siguen pending, intactas',
    [(await statusOf(arOld)).status, (await statusOf(arMarker)).status, (await statusOf(arQuery)).status, (await statusOf(metaExhausted)).status].join() === 'pending,pending,pending,pending')

  // SKIP LOCKED: dos pollers a la vez se llevan filas distintas
  const meta3 = await enqueue(META_PAYLOAD, { ageSeconds: 5 })
  const [w0, w1] = [workers[0]!, workers[1]!]
  await w0.query('BEGIN'); await w0.query('SET LOCAL ROLE service_role')
  await w1.query('BEGIN'); await w1.query('SET LOCAL ROLE service_role')
  const p0 = (await w0.query<{ id: string }>('SELECT id FROM public.claim_next_pollable_message_queue_item()')).rows[0]?.id
  const p1 = (await w1.query<{ id: string }>('SELECT id FROM public.claim_next_pollable_message_queue_item()')).rows[0]?.id
  await w0.query('COMMIT'); await w1.query('COMMIT')
  check('SKIP LOCKED: dos pollers concurrentes reclaman filas distintas, sin bloquearse',
    p0 !== undefined && p1 !== undefined && p0 !== p1 && [meta2, meta3].includes(p0!) && [meta2, meta3].includes(p1!), { p0, p1 })
  check('nada más pollable: sólo quedan AutoResponder y la agotada', (await pollClaim()) === null)

  // Falla terminal y diagnosticable
  const failSql = `UPDATE public.message_queue SET status = 'failed', last_error = $2 WHERE id = $1 AND status = 'pending'`
  await main.query(failSql, [arQuery, 'sync_worker_unreachable'])
  await main.query(failSql, [ar, 'sync_worker_timeout']) // ar está 'processing': no se toca
  check('fila AR que el worker no tomó → failed con motivo (no pending eterno)',
    JSON.stringify(await statusOf(arQuery)) === JSON.stringify({ status: 'failed', last_error: 'sync_worker_unreachable' }))
  check('fila AR que el worker sí tomó → el guard no la pisa (sigue processing)', (await statusOf(ar)).status === 'processing')
}

// ── Grants ───────────────────────────────────────────────────────────────────

async function grants() {
  section('Grants')
  const { rows } = await main.query<{ fn: string; anon: boolean; auth: boolean; svc: boolean; public_x: boolean; secdef: boolean; config: string[] | null }>(
    `SELECT p.proname AS fn,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
            EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_x,
            p.prosecdef AS secdef, p.proconfig AS config
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('claim_ai_auto_reply_slot', 'claim_next_pollable_message_queue_item')`)
  check('las dos RPCs: EXECUTE sólo service_role (ni PUBLIC, ni anon, ni authenticated), search_path vacío',
    rows.length === 2 && rows.every((r) => r.svc && !r.anon && !r.auth && !r.public_x && JSON.stringify(r.config) === '["search_path=\\"\\""]'), rows)
  check('claim_ai_auto_reply_slot sigue siendo SECURITY DEFINER; la del poller corre como el invocador',
    rows.find((r) => r.fn === 'claim_ai_auto_reply_slot')?.secdef === true && rows.find((r) => r.fn === 'claim_next_pollable_message_queue_item')?.secdef === false, rows)
  const { rows: [old] } = await main.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'claim_ai_auto_reply_slot' AND pg_get_function_identity_arguments(p.oid) = 'p_conversation_id uuid, p_tenant_id uuid'`)
  check('la firma vieja (2 args, contador de por vida) ya no existe', old!.n === 0)
  for (const role of ['anon', 'authenticated']) {
    let code: string | undefined
    try {
      await main.query('BEGIN'); await main.query(`SET LOCAL ROLE ${role}`)
      await main.query('SELECT * FROM public.claim_next_pollable_message_queue_item()')
    } catch (error) {
      code = (error as { code?: string }).code
    } finally {
      await main.query('ROLLBACK').catch(() => undefined)
    }
    check(`${role}: claim del poller → 42501`, code === '42501', code)
  }
}

async function run() {
  log(HR)
  log('  MVP P0-A — estabilidad de AutoResponder contra reservanex-lab')
  log(HR)
  main = await lab.connect({ applicationName: 'reservanex-lab-p0a-main' })
  for (let i = 0; i < 3; i++) workers.push(await lab.connect({ applicationName: `reservanex-lab-p0a-w${i}` }))
  log('  LAB GUARD — PASS')
  try {
    tenantId = randomUUID()
    await main.query(`INSERT INTO public.tenants (id, name, slug, status, max_properties) VALUES ($1, $2, $3, 'active', NULL)`,
      [tenantId, `[LAB P0-A] ${RUN}`, `lab-p0a-${RUN}`])
    await sessions()
    await poller()
    await grants()
  } catch (error) {
    check('excepción inesperada', false, error instanceof Error ? error.message : String(error))
  } finally {
    section('Limpieza')
    if (tenantId) {
      await main.query('DELETE FROM public.message_queue WHERE tenant_id = $1', [tenantId])
      await main.query('SELECT public.admin_purge_tenant($1)', [tenantId])
    }
    const { rows: [left] } = await main.query<{ tenants: number; queue: number }>(
      `SELECT (SELECT count(*)::int FROM public.tenants WHERE slug LIKE 'lab-p0a-%') AS tenants,
              (SELECT count(*)::int FROM public.message_queue WHERE tenant_id = $1) AS queue`, [tenantId])
    check('sin residuos: 0 tenants lab-p0a, 0 filas de cola sintéticas', left!.tenants === 0 && left!.queue === 0, left)
    await Promise.all([main, ...workers].map((c) => c.end().catch(() => undefined)))
  }
  log(`\n${HR}\n  ${passed} OK · ${failed} FALLOS\n${HR}`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error: unknown) => {
  console.error(lab.redact(`validate-autoresponder-stability falló: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
})

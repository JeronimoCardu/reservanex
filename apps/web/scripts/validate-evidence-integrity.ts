/**
 * Fase 3C — integridad de la evidencia histórica y semántica.
 *
 * Dos brechas distintas, ambas con la misma raíz: RLS restringe FILAS, no
 * COLUMNAS, y un GRANT de UPDATE no distingue entre "corregir un dato" y
 * "fabricar un hecho".
 *
 *   1ª (migración 20260908000005): un owner podía reescribir el payload y las
 *      columnas históricas — qué pidió el cliente.
 *
 *   2ª (migración 20260908000006): aun con eso protegido, seguía pudiendo
 *      escribir status/confirmed_at en form_submissions y
 *      status/decided_at/decided_by en operation_requests. Esas columnas no
 *      son datos: son HECHOS. "confirmed + confirmed_at" significa
 *      literalmente "el cliente confirmó por WhatsApp", y "decided_by"
 *      significa "esta persona decidió". Poder escribirlas directo es poder
 *      fabricar esos hechos.
 *
 * Regla vigente: authenticated (y super admin impersonando) tienen SELECT.
 * NINGÚN UPDATE directo. Los writes legítimos pasan por el backend con service
 * role o por la RPC transaccional.
 *
 * Este script lo verifica con un LOGIN REAL de tenant, no con claims
 * simulados. La impersonación y el service role se cubren en
 * supabase/30-proof-evidence-immutability.sql.
 *
 * Usage:  pnpm --filter @orderflow/web validate:evidence
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes, randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { generateSubmissionReference } from '../src/lib/forms/submission-reference'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }

async function main() {
  assertSafeSupabaseTarget()

  const admin  = createAdminClient()
  const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan las env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3C — integridad de la evidencia (login tenant REAL)')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authUserIds: string[] = []

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    const { data: tenant, error: tErr } = await admin.from('tenants')
      .insert({ name: `[TEST] Evidence ${RUN_ID}`, slug: `test-evidence-${RUN_ID}`, status: 'active' })
      .select('id').single()
    if (tErr || !tenant) throw new Error(`tenant: ${tErr?.message}`)
    tenantIds.push(tenant.id)

    const password = randomBytes(18).toString('hex')
    const email    = `owner-evidence-${RUN_ID}@example.test`
    const { data: au, error: aErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (aErr || !au.user) throw new Error(`user: ${aErr?.message}`)
    authUserIds.push(au.user.id)

    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: au.user.id, tenant_id: tenant.id, name: 'Owner', email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users: ${tuErr.message}`)

    const { data: contact } = await admin.from('contacts')
      .insert({ tenant_id: tenant.id, phone: `54911${RUN_ID.slice(-8)}`, name: 'Cliente Real' })
      .select('id').single()
    const { data: otherContact } = await admin.from('contacts')
      .insert({ tenant_id: tenant.id, phone: `54922${RUN_ID.slice(-8)}`, name: 'Otro' })
      .select('id').single()
    if (!contact || !otherContact) throw new Error('contacts')

    const PAYLOAD = { name: 'Ana Gómez', check_in: '2026-10-15', check_out: '2026-10-20', adults: 2, children: 1 }

    async function mkSubmission(contactId: string | null) {
      const { data, error } = await admin.from('form_submissions').insert({
        tenant_id: tenant!.id, reference: generateSubmissionReference(),
        intent: 'temporary_rental', status: 'submitted', source: 'public_site',
        payload: PAYLOAD as never, idempotency_key: randomUUID(), contact_id: contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).select('id').single()
      if (error || !data) throw new Error(`submission: ${error?.message}`)
      return data.id
    }

    // subForge: se queda en 'submitted' — es sobre la que el owner intentará
    // fabricar la confirmación del cliente.
    const subForgeId = await mkSubmission(contact.id)
    // subBind: nace SIN contacto — para probar que el owner tampoco puede
    // hacer el binding a mano.
    const subBindId  = await mkSubmission(null)
    // subRpc: la confirma la RPC de verdad, y de ahí sale la operación.
    const subRpcId   = await mkSubmission(contact.id)

    // ── Login REAL como owner ────────────────────────────────────────────────
    const client: SupabaseClient<Database> = createSupabaseJsClient<Database>(anonUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: session, error: liErr } = await client.auth.signInWithPassword({ email, password })
    if (liErr || !session.session) { nok('login real', liErr?.message); throw new Error('sin sesión') }
    ok('Login real de owner OK')

    // ══ A. El owner VE sus submissions ══════════════════════════════════════
    {
      const { data } = await client.from('form_submissions').select('id, status').eq('id', subForgeId)
      if ((data ?? []).length === 1) ok('A. el owner puede SELECT su form_submission')
      else nok('A. el owner NO ve su submission — el resto serían falsos verdes', JSON.stringify(data))
    }

    // ── Helper genérico: ¿el UPDATE cambió el valor de verdad? ───────────────
    // Mirar solo el error no alcanza: un UPDATE puede afectar 0 filas sin
    // error y parecer bloqueado. Se compara el VALOR en la base.
    async function noDebeMutar(
      tabla: 'form_submissions' | 'operation_requests',
      id: string,
      etiqueta: string,
      patch: Record<string, unknown>,
      columna: string,
    ) {
      const { data: pre } = await admin.from(tabla).select(columna).eq('id', id).single()
      const antes = (pre as unknown as Record<string, unknown>)[columna]

      const { error } = await client.from(tabla).update(patch as never).eq('id', id)

      const { data: post } = await admin.from(tabla).select(columna).eq('id', id).single()
      const despues = (post as unknown as Record<string, unknown>)[columna]

      if (JSON.stringify(antes) !== JSON.stringify(despues)) {
        nok(etiqueta, `FABRICADO: ${JSON.stringify(antes)} → ${JSON.stringify(despues)}`)
      } else {
        ok(`${etiqueta}${error ? ` (rechazado: ${error.code ?? 'error'})` : ''}`)
      }
    }

    console.log('\n  ── B. form_submissions: el owner no puede fabricar hechos del cliente ──')

    // El caso central: fabricar "el cliente confirmó por WhatsApp".
    await noDebeMutar('form_submissions', subForgeId,
      'B. no puede pasar submitted → confirmed', { status: 'confirmed' }, 'status')
    await noDebeMutar('form_submissions', subForgeId,
      'B. no puede sellar confirmed_at', { confirmed_at: new Date().toISOString() }, 'confirmed_at')
    await noDebeMutar('form_submissions', subForgeId,
      'B. no puede fabricar confirmación completa (status + confirmed_at juntos)',
      { status: 'confirmed', confirmed_at: new Date().toISOString() }, 'status')

    // Binding y reasignación de contacto.
    await noDebeMutar('form_submissions', subBindId,
      'B. no puede hacer el binding de contact_id a mano', { contact_id: contact.id }, 'contact_id')
    await noDebeMutar('form_submissions', subForgeId,
      'B. no puede reasignar contact_id a otro contacto', { contact_id: otherContact.id }, 'contact_id')

    // Cualquier otro cambio de estado tampoco.
    await noDebeMutar('form_submissions', subForgeId,
      'B. no puede cancelar la submission directamente', { status: 'cancelled' }, 'status')
    await noDebeMutar('form_submissions', subForgeId,
      'B. no puede marcarla expirada directamente', { status: 'expired' }, 'status')

    // Y lo histórico sigue protegido (regresión de la 1ª brecha).
    await noDebeMutar('form_submissions', subForgeId,
      'B. sigue sin poder mutar el payload', { payload: { name: 'FALSIFICADO', adults: 99 } }, 'payload')
    await noDebeMutar('form_submissions', subForgeId,
      'B. sigue sin poder cambiar el intent', { intent: 'general_inquiry' }, 'intent')

    // ══ C. El backend/RPC SÍ puede confirmar ════════════════════════════════
    console.log('\n  ── C/G. el camino legítimo sigue funcionando ──')
    let opId = ''
    {
      const { data: rpc, error } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: subRpcId, p_tenant_id: tenant.id, p_contact_id: contact.id,
        p_conversation_id: undefined,
      })
      const out = rpc as { outcome?: string; operation_id?: string } | null

      if (!error && out?.outcome === 'confirmed' && out.operation_id) {
        opId = out.operation_id
        ok('C. la RPC confirma la submission (submitted → confirmed)')
      } else {
        nok('C. la RPC dejó de funcionar', error?.message ?? JSON.stringify(rpc))
        throw new Error('RPC rota')
      }

      const { data: s } = await admin.from('form_submissions')
        .select('status, confirmed_at, contact_id').eq('id', subRpcId).single()
      if (s?.status === 'confirmed' && s.confirmed_at && s.contact_id === contact.id) {
        ok('C. status/confirmed_at/contact_id quedaron correctos por el camino legítimo')
      } else {
        nok('C. la confirmación legítima quedó incompleta', JSON.stringify(s))
      }

      const { data: ops } = await admin.from('operation_requests')
        .select('id, status').eq('source_submission_id', subRpcId)
      if ((ops ?? []).length === 1 && ops![0]!.status === 'pending') {
        ok('G. la RPC creó exactamente UNA operation_request pending')
      } else {
        nok('G. la creación de la operación falló', JSON.stringify(ops))
      }
    }

    // ══ D. El owner VE la operación ═════════════════════════════════════════
    {
      const { data } = await client.from('operation_requests').select('id, status').eq('id', opId)
      if ((data ?? []).length === 1) ok('D. el owner puede SELECT su operation_request')
      else nok('D. el owner NO ve la operación — los rechazos siguientes serían falsos verdes', JSON.stringify(data))
    }

    // ══ E. El owner no puede fabricar la decisión ═══════════════════════════
    console.log('\n  ── E. operation_requests: el owner no puede fabricar la decisión ──')

    await noDebeMutar('operation_requests', opId,
      'E. no puede cambiar status', { status: 'confirmed' }, 'status')
    await noDebeMutar('operation_requests', opId,
      'E. no puede estampar decided_at', { decided_at: new Date().toISOString() }, 'decided_at')
    await noDebeMutar('operation_requests', opId,
      'E. no puede fabricar decided_by', { decided_by: au.user!.id }, 'decided_by')
    await noDebeMutar('operation_requests', opId,
      'E. no puede escribir decision_notes', { decision_notes: 'aprobada por mí' }, 'decision_notes')
    await noDebeMutar('operation_requests', opId,
      'E. no puede fabricar una decisión completa',
      { status: 'rejected', decided_at: new Date().toISOString(), decided_by: au.user!.id }, 'status')

    // Regresión de la 1ª brecha sobre la operación.
    await noDebeMutar('operation_requests', opId,
      'E. sigue sin poder mutar payload_snapshot',
      { payload_snapshot: { name: 'FALSIFICADO' } }, 'payload_snapshot')
    await noDebeMutar('operation_requests', opId,
      'E. sigue sin poder cambiar source_submission_id',
      { source_submission_id: randomUUID() }, 'source_submission_id')

    // ── La operación sigue pending: nada de lo anterior la movió ────────────
    {
      const { data: op } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by, decision_notes').eq('id', opId).single()
      if (op?.status === 'pending' && !op.decided_at && !op.decided_by && !op.decision_notes) {
        ok('E. tras todos los intentos la operación sigue pending y sin decisión')
      } else {
        nok('E. algún intento dejó rastro', JSON.stringify(op))
      }
    }

    await client.auth.signOut().catch(() => {})

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      try { await admin.from('tenants').delete().eq('id', id) } catch { /* noop */ }
    }
    for (const uid of authUserIds) {
      try { await admin.auth.admin.deleteUser(uid) } catch { /* noop */ }
    }
    console.log(`  tenants: ${tenantIds.length} · usuarios: ${authUserIds.length}`)
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('[validate-evidence-integrity] fatal:', e instanceof Error ? e.message : String(e)); process.exit(1) })

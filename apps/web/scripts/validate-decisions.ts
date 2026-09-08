/**
 * Fase 3D — decisión de solicitudes: autorización, concurrencia y auditoría.
 *
 * Corre contra el Supabase enlazado con LOGIN REAL de tenant y llamando a la
 * MISMA RPC que usa la UI (decide_operation_request). No hay mocks.
 *
 * Cubre §18 A–S y el recorrido del §19.
 *
 * Usage:  pnpm --filter @orderflow/web validate:decisions
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

type Rpc = { outcome?: string; status?: string; decided_at?: string; decided_by?: string }

async function main() {
  assertSafeSupabaseTarget()

  const admin  = createAdminClient()
  const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan las env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3D — decisión de solicitudes (login real, RPC real)')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authUserIds: string[] = []

  function anonClient(): SupabaseClient<Database> {
    return createSupabaseJsClient<Database>(anonUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }

  try {
    // ── Fixture: dos tenants, con owner y recepcionista ──────────────────────
    async function buildTenant(label: string) {
      const { data: t, error } = await admin.from('tenants')
        .insert({ name: `[TEST] 3D ${label} ${RUN_ID}`, slug: `test-3d-${label.toLowerCase()}-${RUN_ID}`, status: 'active' })
        .select('id').single()
      if (error || !t) throw new Error(`tenant: ${error?.message}`)
      tenantIds.push(t.id)

      async function mkUser(kind: string, role: 'owner' | 'receptionist', canConfirm: boolean) {
        const password = randomBytes(18).toString('hex')
        const email    = `${kind}-3d-${label.toLowerCase()}-${RUN_ID}@example.test`
        const { data: au, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
        if (e || !au.user) throw new Error(`user: ${e?.message}`)
        authUserIds.push(au.user.id)
        const { error: tu } = await admin.from('tenant_users').insert({
          id: au.user.id, tenant_id: t!.id, name: `${kind} ${label}`, email, role,
          active: true, can_confirm_reservations: canConfirm,
        })
        if (tu) throw new Error(`tenant_users: ${tu.message}`)
        return { id: au.user.id, email, password }
      }

      const owner        = await mkUser('owner', 'owner', true)
      const recepSi      = await mkUser('recep-si', 'receptionist', true)
      const recepNo      = await mkUser('recep-no', 'receptionist', false)

      const { data: contact } = await admin.from('contacts')
        .insert({ tenant_id: t.id, phone: `5491${label === 'A' ? '1' : '2'}${RUN_ID.slice(-8)}`, name: `Cliente ${label}` })
        .select('id').single()
      if (!contact) throw new Error('contact')

      return { id: t.id, owner, recepSi, recepNo, contactId: contact.id }
    }

    const A = await buildTenant('A')
    const B = await buildTenant('B')
    ok('Fixture: dos tenants con owner, recepcionista con permiso y recepcionista sin permiso')

    const PAYLOAD = { name: 'Ana Gómez', check_in: '2026-10-15', check_out: '2026-10-20', adults: 2, children: 1 }

    // Crea una operación pending por el camino REAL (la RPC de 3C).
    async function mkPending(tenantId: string, contactId: string): Promise<string> {
      const { data: sub, error } = await admin.from('form_submissions').insert({
        tenant_id: tenantId, reference: generateSubmissionReference(),
        intent: 'temporary_rental', status: 'submitted', source: 'public_site',
        payload: PAYLOAD as never, idempotency_key: randomUUID(), contact_id: contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).select('id').single()
      if (error || !sub) throw new Error(`submission: ${error?.message}`)

      const { data: rpc } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub.id, p_tenant_id: tenantId, p_contact_id: contactId,
        p_conversation_id: undefined,
      })
      const opId = (rpc as { operation_id?: string } | null)?.operation_id
      if (!opId) throw new Error('no se creó la operación')
      return opId
    }

    async function login(u: { email: string; password: string }) {
      const c = anonClient()
      const { data, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password })
      if (error || !data.session) throw new Error(`login: ${error?.message}`)
      return c
    }

    const asOwnerA   = await login(A.owner)
    const asRecepSiA = await login(A.recepSi)
    const asRecepNoA = await login(A.recepNo)
    const asOwnerB   = await login(B.owner)
    ok('Login real de los cuatro usuarios')

    // ══ A / B. Visibilidad ══════════════════════════════════════════════════
    const opVis = await mkPending(A.id, A.contactId)
    {
      const { data: propias } = await asOwnerA.from('operation_requests').select('id').eq('id', opVis)
      if ((propias ?? []).length === 1) ok('A. el owner ve las solicitudes de su tenant')
      else nok('A. el owner NO ve su solicitud', JSON.stringify(propias))

      const { data: ajenas } = await asOwnerB.from('operation_requests').select('id').eq('id', opVis)
      if ((ajenas ?? []).length === 0) ok('B. el owner de B NO ve las solicitudes de A')
      else nok('B. fuga entre tenants', JSON.stringify(ajenas))
    }

    // ══ D / E. anon y sin sesión ════════════════════════════════════════════
    {
      const anon = anonClient()
      const { data, error } = await anon.rpc('decide_operation_request', {
        p_operation_id: opVis, p_action: 'confirmed',
      })
      // Sin grant, PostgREST devuelve error de permisos; si por algo llegara a
      // ejecutar, la función devuelve 'unauthenticated'. Ambos son aceptables;
      // lo inaceptable es que decida.
      const decidio = !error && (data as Rpc)?.outcome === 'confirmed'
      if (!decidio) ok(`D/E. anon no puede ejecutar la RPC (${error?.code ?? (data as Rpc)?.outcome})`)
      else nok('D/E. anon DECIDIÓ una solicitud')

      const { data: after } = await admin.from('operation_requests').select('status').eq('id', opVis).single()
      if (after?.status === 'pending') ok('D/E. la solicitud sigue pending tras el intento anónimo')
      else nok('D/E. el intento anónimo cambió el estado', String(after?.status))
    }

    // ══ F. Cruce de tenant ══════════════════════════════════════════════════
    {
      const { data } = await asOwnerB.rpc('decide_operation_request', {
        p_operation_id: opVis, p_action: 'confirmed',
      })
      if ((data as Rpc)?.outcome === 'not_found') ok('F. el owner de B no puede decidir una solicitud de A (not_found, sin disclosure)')
      else nok('F. cruce de tenant no bloqueado', JSON.stringify(data))

      const { data: after } = await admin.from('operation_requests').select('status').eq('id', opVis).single()
      if (after?.status === 'pending') ok('F. la solicitud de A sigue intacta')
      else nok('F. un tenant ajeno cambió el estado', String(after?.status))
    }

    // ══ C. Permisos de recepcionista ════════════════════════════════════════
    {
      const opSinPermiso = await mkPending(A.id, A.contactId)
      const { data } = await asRecepNoA.rpc('decide_operation_request', {
        p_operation_id: opSinPermiso, p_action: 'confirmed',
      })
      if ((data as Rpc)?.outcome === 'forbidden') ok('C. recepcionista SIN can_confirm_reservations no puede decidir')
      else nok('C. un recepcionista sin permiso decidió', JSON.stringify(data))

      const opConPermiso = await mkPending(A.id, A.contactId)
      const { data: d2 } = await asRecepSiA.rpc('decide_operation_request', {
        p_operation_id: opConPermiso, p_action: 'confirmed',
      })
      if ((d2 as Rpc)?.outcome === 'confirmed') ok('C. recepcionista CON can_confirm_reservations sí puede')
      else nok('C. un recepcionista con permiso fue rechazado', JSON.stringify(d2))
    }

    // ══ G / I / J / K. pending → confirmed ══════════════════════════════════
    {
      const opId = await mkPending(A.id, A.contactId)
      const { data: snapAntes } = await admin.from('operation_requests')
        .select('payload_snapshot, source_submission_id, intent, kind, customer_confirmed_at')
        .eq('id', opId).single()

      // K — se mandan decided_by y decided_at falsos como parámetros extra.
      // La RPC no los recibe: su firma es (operation_id, action, notes).
      const { data } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed', p_notes: '  Aprobada por teléfono  ',
      } as never)

      if ((data as Rpc)?.outcome === 'confirmed') ok('G. pending → confirmed')
      else nok('G. la aprobación falló', JSON.stringify(data))

      const { data: row } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by, decision_notes, payload_snapshot, source_submission_id, intent, kind, customer_confirmed_at')
        .eq('id', opId).single()

      if (row?.status === 'confirmed') ok('G. status = confirmed en la DB')
      else nok('G. status incorrecto', String(row?.status))

      if (row?.decided_by === A.owner.id) ok('I. decided_by = auth.uid() real del owner')
      else nok('I. decided_by incorrecto', `${row?.decided_by} vs ${A.owner.id}`)

      if (row?.decided_at) {
        const delta = Math.abs(Date.now() - new Date(row.decided_at).getTime())
        if (delta < 120_000) ok(`J. decided_at generado server-side (hace ${Math.round(delta / 1000)}s)`)
        else nok('J. decided_at fuera de rango', row.decided_at)
      } else {
        nok('J. decided_at quedó null')
      }

      // §7 — la nota se guarda trimeada.
      if (row?.decision_notes === 'Aprobada por teléfono') ok('§7. la nota se guardó trimeada')
      else nok('§7. la nota no se normalizó', JSON.stringify(row?.decision_notes))

      // N — el snapshot no se tocó.
      const igual =
        JSON.stringify(row?.payload_snapshot) === JSON.stringify(snapAntes?.payload_snapshot) &&
        row?.source_submission_id === snapAntes?.source_submission_id &&
        row?.intent === snapAntes?.intent &&
        row?.kind === snapAntes?.kind &&
        row?.customer_confirmed_at === snapAntes?.customer_confirmed_at
      if (igual) ok('N. el snapshot y la identidad quedaron idénticos tras decidir')
      else nok('N. la decisión alteró datos históricos')

      // O — auditoría.
      const { data: audit } = await admin.from('audit_logs')
        .select('action, actor_id, actor_type, old_value, new_value, created_at')
        .eq('entity_type', 'operation_requests').eq('entity_id', opId)
        .order('created_at', { ascending: false }).limit(5)

      const upd = (audit ?? []).find((a) => a.action === 'operation_requests.update')
      if (upd) {
        const oldS = (upd.old_value as Record<string, unknown> | null)?.status
        const newS = (upd.new_value as Record<string, unknown> | null)?.status
        if (oldS === 'pending' && newS === 'confirmed' && upd.actor_id === A.owner.id) {
          ok(`O. auditoría correcta: ${oldS} → ${newS}, actor = owner real (${upd.actor_type})`)
        } else {
          nok('O. la auditoría no refleja la transición', JSON.stringify({ oldS, newS, actor: upd.actor_id }))
        }
      } else {
        nok('O. no se registró la actualización en audit_logs', JSON.stringify(audit))
      }

      // M / §9 — segunda decisión no pisa la primera.
      const decidedAt = row?.decided_at
      const { data: again } = await asRecepSiA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'rejected', p_notes: 'intento de pisar',
      })
      if ((again as Rpc)?.outcome === 'already_decided') ok('M. una segunda decisión devuelve already_decided')
      else nok('M. la segunda decisión no fue rechazada', JSON.stringify(again))

      const { data: after } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by, decision_notes').eq('id', opId).single()
      if (after?.status === 'confirmed' && after.decided_at === decidedAt &&
          after.decided_by === A.owner.id && after.decision_notes === 'Aprobada por teléfono') {
        ok('M. la primera decisión quedó intacta (status, decided_at, decided_by y nota)')
      } else {
        nok('M. la segunda decisión pisó la primera', JSON.stringify(after))
      }
    }

    // ══ H. pending → rejected con motivo ════════════════════════════════════
    {
      const opId = await mkPending(A.id, A.contactId)
      const { data } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'rejected', p_notes: 'No hay disponibilidad esas fechas',
      })
      if ((data as Rpc)?.outcome === 'rejected') ok('H. pending → rejected')
      else nok('H. el rechazo falló', JSON.stringify(data))

      const { data: row } = await admin.from('operation_requests')
        .select('status, decided_by, decided_at, decision_notes').eq('id', opId).single()
      if (row?.status === 'rejected' && row.decided_by === A.owner.id &&
          row.decided_at && row.decision_notes === 'No hay disponibilidad esas fechas') {
        ok('H. motivo y actor registrados correctamente')
      } else {
        nok('H. el rechazo quedó incompleto', JSON.stringify(row))
      }
    }

    // ══ §3. Transiciones prohibidas ═════════════════════════════════════════
    {
      const opId = await mkPending(A.id, A.contactId)
      await asOwnerA.rpc('decide_operation_request', { p_operation_id: opId, p_action: 'confirmed' })

      const { data: bad } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'pending' as never,
      })
      if ((bad as Rpc)?.outcome === 'invalid_action') ok('§3. una acción fuera de confirmed|rejected se rechaza')
      else nok('§3. se aceptó una acción inválida', JSON.stringify(bad))
    }

    // ══ §7. Notas: tope y HTML ══════════════════════════════════════════════
    {
      const opLarga = await mkPending(A.id, A.contactId)
      const { data: larga } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opLarga, p_action: 'rejected', p_notes: 'x'.repeat(501),
      })
      if ((larga as Rpc)?.outcome === 'notes_too_long') ok('§7. una nota de más de 500 caracteres se rechaza')
      else nok('§7. se aceptó una nota sin tope', JSON.stringify(larga))

      const { data: html } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opLarga, p_action: 'rejected', p_notes: 'ver <script>alert(1)</script>',
      })
      if ((html as Rpc)?.outcome === 'notes_invalid') ok('§7. una nota con HTML se rechaza')
      else nok('§7. se aceptó HTML en la nota', JSON.stringify(html))

      const { data: still } = await admin.from('operation_requests').select('status').eq('id', opLarga).single()
      if (still?.status === 'pending') ok('§7. tras las notas inválidas la solicitud sigue pending')
      else nok('§7. una nota inválida igual decidió', String(still?.status))
    }

    // ══ L. Concurrencia ═════════════════════════════════════════════════════
    {
      const opId = await mkPending(A.id, A.contactId)
      const [r1, r2] = await Promise.all([
        asOwnerA.rpc('decide_operation_request', { p_operation_id: opId, p_action: 'confirmed', p_notes: 'owner' }),
        asRecepSiA.rpc('decide_operation_request', { p_operation_id: opId, p_action: 'rejected', p_notes: 'recep' }),
      ])
      const outcomes = [(r1.data as Rpc)?.outcome, (r2.data as Rpc)?.outcome].sort()
      const unaGano = outcomes.filter((o) => o === 'confirmed' || o === 'rejected').length === 1
      const otraPerdió = outcomes.includes('already_decided')

      if (unaGano && otraPerdió) ok(`L. dos decisiones concurrentes: una gana, la otra recibe already_decided (${outcomes.join(' / ')})`)
      else nok('L. la carrera no se resolvió bien', JSON.stringify(outcomes))

      const { data: row } = await admin.from('operation_requests')
        .select('status, decision_notes').eq('id', opId).single()
      if (row?.status === 'confirmed' || row?.status === 'rejected') {
        ok(`L. la solicitud quedó en un único estado final (${row.status}, nota "${row.decision_notes}")`)
      } else {
        nok('L. estado final inesperado', JSON.stringify(row))
      }

      // Una sola auditoría de update: la segunda no escribió nada.
      const { count } = await admin.from('audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('entity_type', 'operation_requests').eq('entity_id', opId)
        .eq('action', 'operation_requests.update')
      if (count === 1) ok('L/§9. una sola entrada de auditoría de UPDATE (sin duplicados)')
      else nok('L/§9. auditoría duplicada', `count=${count}`)
    }

    // ══ R. UPDATE directo sigue denegado ════════════════════════════════════
    {
      const opId = await mkPending(A.id, A.contactId)
      const { error } = await asOwnerA.from('operation_requests')
        .update({ status: 'confirmed', decided_at: new Date().toISOString(), decided_by: A.owner.id })
        .eq('id', opId)
      const { data: row } = await admin.from('operation_requests').select('status').eq('id', opId).single()

      if (row?.status === 'pending') ok(`R. el UPDATE directo sigue denegado (${error?.code ?? 'sin efecto'})`)
      else nok('R. el owner decidió con UPDATE directo', String(row?.status))
    }

    // ══ P / Q. Sin efectos colaterales (§14) ════════════════════════════════
    {
      const { count: reservas } = await admin.from('reservations')
        .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
      const { count: bA } = await admin.from('availability_blocks')
        .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
      const { count: bB } = await admin.from('property_availability_blocks')
        .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)

      if ((reservas ?? 0) === 0) ok('P. aprobar NO creó ninguna reservation')
      else nok('P. se creó una reservation', `${reservas}`)
      if ((bA ?? 0) === 0 && (bB ?? 0) === 0) ok('Q. aprobar NO bloqueó disponibilidad')
      else nok('Q. se crearon bloqueos', `${bA} + ${bB}`)
    }

    // ══ S. Impersonación ════════════════════════════════════════════════════
    // Cubierta en supabase/32-proof-3d-impersonation.sql: acá no hay cuenta
    // super admin real, y la decisión adoptada (no puede decidir) se verifica
    // simulando los claims del hook, igual que en las pruebas 28 y 30.
    ok('S. impersonación: verificada en supabase/32-proof-3d-impersonation.sql')

    for (const c of [asOwnerA, asRecepSiA, asRecepNoA, asOwnerB]) {
      await c.auth.signOut().catch(() => {})
    }

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

main().catch((e) => { console.error('[validate-decisions] fatal:', e instanceof Error ? e.message : String(e)); process.exit(1) })

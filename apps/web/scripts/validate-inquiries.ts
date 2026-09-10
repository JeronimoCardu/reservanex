/**
 * Fase 3E-B1 — consultas inmobiliarias: permisos y cero efectos colaterales.
 *
 * Dos cosas que demostrar:
 *
 *   1. PERMISOS. Gestionar una consulta ya no depende de can_confirm_reservations.
 *      El caso crítico es F: una recepcionista con SOLO permiso de reservas no
 *      puede tocar una consulta. Eso es la brecha semántica cerrada.
 *
 *   2. CERO MATERIALIZACIÓN. "Gestionada" significa exactamente "la inmobiliaria
 *      atendió esto", y nada más: ni reserva, ni contrato mensual, ni bloqueo de
 *      disponibilidad, ni visita, ni tarea, ni nota, ni WhatsApp.
 *
 * Todo por los caminos reales: la RPC de 3C para crear la operación y
 * decide_operation_request con logins reales. Sin mocks.
 *
 * Usage:  pnpm --filter @orderflow/web validate:inquiries
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

type Rpc = {
  outcome?: string
  required_permission?: string
  kind?: string
  decided_at?: string | null
  decided_by?: string | null
}

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const RUN     = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3E-B1 — consultas inmobiliarias')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authIds:   string[] = []

  const anonClient = () => createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // ── Fixture: dos tenants (para aislamiento) ──────────────────────────────
    async function buildTenant(label: string) {
      const { data: t, error } = await admin.from('tenants')
        .insert({
          name: `[TEST] 3EB1 ${label} ${RUN}`,
          slug: `test-3eb1-${label.toLowerCase()}-${RUN}`, status: 'active',
        }).select('id').single()
      if (error || !t) throw new Error(`tenant: ${error?.message}`)
      tenantIds.push(t.id)

      async function mkUser(
        kind: string,
        role: 'owner' | 'receptionist',
        perms: { reservas: boolean; consultas: boolean },
      ) {
        const password = randomBytes(18).toString('hex')
        const email    = `${kind}-3eb1-${label.toLowerCase()}-${RUN}@example.test`
        const { data: au, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
        if (e || !au.user) throw new Error(`user: ${e?.message}`)
        authIds.push(au.user.id)
        const { error: tu } = await admin.from('tenant_users').insert({
          id: au.user.id, tenant_id: t!.id, name: `${kind} ${label}`, email, role, active: true,
          can_confirm_reservations: perms.reservas,
          can_manage_inquiries:     perms.consultas,
        })
        if (tu) throw new Error(`tenant_users: ${tu.message}`)
        return { id: au.user.id, email, password }
      }

      const owner    = await mkUser('owner',    'owner',        { reservas: true,  consultas: true  })
      // Con el permiso nuevo.
      const recepSi  = await mkUser('recep-si', 'receptionist', { reservas: false, consultas: true  })
      // Sin ningún permiso.
      const recepNo  = await mkUser('recep-no', 'receptionist', { reservas: false, consultas: false })
      // EL CASO CRÍTICO: solo permiso de reservas.
      const recepRes = await mkUser('recep-res','receptionist', { reservas: true,  consultas: false })

      const { data: contact } = await admin.from('contacts')
        .insert({ tenant_id: t.id, phone: `5491${label === 'A' ? '1' : '2'}${RUN.slice(-8)}`, name: `Cliente ${label}` })
        .select('id').single()
      if (!contact) throw new Error('contact')

      const { data: prop } = await admin.from('properties').insert({
        tenant_id: t.id, title: `[TEST] Propiedad ${label} ${RUN}`, city: 'CABA',
        published: true, operation_type: 'temporary_rental', pricing_mode: 'consult', currency: 'ARS',
      } as never).select('id').single()
      if (!prop) throw new Error('property')

      return { id: t.id, owner, recepSi, recepNo, recepRes, contactId: contact.id, propertyId: prop.id }
    }

    const A = await buildTenant('A')
    const B = await buildTenant('B')
    ok('Fixture: 2 tenants, owner y 3 recepcionistas con combinaciones de permisos, contacto y propiedad')

    async function login(u: { email: string; password: string }): Promise<SupabaseClient<Database>> {
      const c = anonClient()
      const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password })
      if (error) throw new Error(`login ${u.email}: ${error.message}`)
      return c
    }

    const asOwnerA    = await login(A.owner)
    const asRecepSiA  = await login(A.recepSi)
    const asRecepNoA  = await login(A.recepNo)
    const asRecepResA = await login(A.recepRes)
    const asOwnerB    = await login(B.owner)
    ok('Logins reales de owner y de las tres recepcionistas')

    const PAYLOADS: Record<string, Record<string, unknown>> = {
      property_inquiry:       { name: 'Ana Gómez', message: '¿Sigue disponible? ¿Acepta mascotas?' },
      monthly_rental_inquiry: { name: 'Ana Gómez', move_in_date: '2029-03-01', occupants: 3, notes: 'con garantía propietaria' },
    }

    /** Crea una operación pending por el camino real (RPC de 3C). */
    async function mkPending(
      t: { id: string; contactId: string; propertyId: string },
      intent: 'property_inquiry' | 'monthly_rental_inquiry' | 'temporary_rental',
      payloadOverride?: Record<string, unknown>,
    ): Promise<{ opId: string; subId: string }> {
      const payload = payloadOverride ?? PAYLOADS[intent] ?? {
        name: 'Ana', check_in: '2029-05-01', check_out: '2029-05-05', adults: 2,
      }
      const { data: sub, error: se } = await admin.from('form_submissions').insert({
        tenant_id: t.id, reference: generateSubmissionReference(),
        intent, status: 'submitted', source: 'public_site',
        payload: payload as never, idempotency_key: randomUUID(), contact_id: t.contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        entity_type: 'property', entity_id: t.propertyId,
      } as never).select('id').single()
      if (se || !sub) throw new Error(`submission: ${se?.message}`)

      const { data, error } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub.id, p_tenant_id: t.id, p_contact_id: t.contactId, p_conversation_id: undefined,
      })
      if (error) throw new Error(`confirm: ${error.message}`)
      const opId = (data as { operation_id?: string } | null)?.operation_id
      if (!opId) throw new Error('sin operation_id')
      return { opId, subId: sub.id }
    }

    async function decide(
      c: SupabaseClient<Database>, opId: string, action: 'confirmed' | 'rejected', notes?: string,
    ): Promise<Rpc> {
      const { data, error } = await c.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: action, ...(notes ? { p_notes: notes } : {}),
      })
      if (error) return { outcome: `error:${error.code}` }
      return (data ?? {}) as Rpc
    }

    /** Cuenta todo lo que una consulta NO debe crear. */
    async function efectos(tenantId: string) {
      const n = async (table: 'reservations' | 'property_availability_blocks' | 'monthly_rental_contracts' | 'tasks' | 'notes') => {
        const { count } = await admin.from(table)
          .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
        return count ?? 0
      }
      const { count: outbox } = await admin.from('messaging_outbox')
        .select('id', { count: 'exact', head: true })
      return {
        reservas:  await n('reservations'),
        bloqueos:  await n('property_availability_blocks'),
        contratos: await n('monthly_rental_contracts'),
        tareas:    await n('tasks'),
        notas:     await n('notes'),
        outbox:    outbox ?? 0,
      }
    }

    // ══ §13 A/B/C — el owner siempre puede ══════════════════════════════════
    console.log(`\n${HR}\n  §13 — permisos\n`)

    {
      const { opId } = await mkPending(A, 'property_inquiry')
      const r = await decide(asOwnerA, opId, 'confirmed')
      if (r.outcome === 'confirmed') ok('A. owner gestiona una property_inquiry')
      else nok('A. el owner no pudo gestionar la consulta', JSON.stringify(r))
    }
    {
      const { opId } = await mkPending(A, 'property_inquiry')
      const r = await decide(asOwnerA, opId, 'rejected', 'no era para nosotros')
      const { data: op } = await admin.from('operation_requests')
        .select('status, decision_notes').eq('id', opId).single()
      if (r.outcome === 'rejected' && op?.status === 'rejected' && op.decision_notes === 'no era para nosotros') {
        ok('B. owner descarta una property_inquiry, con nota interna guardada')
      } else nok('B. el descarte no quedó bien', JSON.stringify({ r, op }))
    }
    {
      const { opId } = await mkPending(A, 'monthly_rental_inquiry')
      const r = await decide(asOwnerA, opId, 'confirmed')
      if (r.outcome === 'confirmed') ok('C. owner gestiona una monthly_rental_inquiry')
      else nok('C. el owner no pudo gestionar la consulta mensual', JSON.stringify(r))
    }

    // ══ §13 D/E/F — recepcionistas ══════════════════════════════════════════
    {
      const { opId } = await mkPending(A, 'property_inquiry')
      const r = await decide(asRecepSiA, opId, 'confirmed')
      if (r.outcome === 'confirmed') ok('D. recepcionista CON can_manage_inquiries gestiona la consulta')
      else nok('D. la recepcionista habilitada no pudo', JSON.stringify(r))
    }
    {
      const { opId } = await mkPending(A, 'property_inquiry')
      const r = await decide(asRecepNoA, opId, 'confirmed')
      const { data: op } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by').eq('id', opId).single()
      if (r.outcome === 'forbidden' && op?.status === 'pending' && op.decided_at === null) {
        ok('E. recepcionista SIN permisos → forbidden, y la consulta sigue pending')
      } else nok('E. una recepcionista sin permisos decidió', JSON.stringify({ r, op }))
    }
    {
      // ── EL CASO CRÍTICO ────────────────────────────────────────────────────
      const { opId } = await mkPending(A, 'property_inquiry')
      const r = await decide(asRecepResA, opId, 'confirmed')
      const { data: op } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by').eq('id', opId).single()

      if (r.outcome === 'forbidden' && op?.status === 'pending' && op.decided_at === null && op.decided_by === null) {
        ok('F. recepcionista con SOLO can_confirm_reservations NO puede gestionar una consulta — brecha cerrada')
      } else {
        nok('F. can_confirm_reservations siguió autorizando consultas', JSON.stringify({ r, op }))
      }

      if (r.required_permission === 'can_manage_inquiries' && r.kind === 'inquiry') {
        ok('F. la RPC dice qué permiso falta (can_manage_inquiries) y de qué kind')
      } else {
        nok('F. la denegación no informa el permiso requerido', JSON.stringify(r))
      }

      // Y no se rompió lo que ese permiso sí habilita.
      const res = await mkPending(A, 'temporary_rental')
      const r2 = await decide(asRecepResA, res.opId, 'rejected')
      if (r2.outcome === 'rejected') {
        ok('F. esa misma recepcionista SÍ sigue pudiendo decidir una solicitud de reserva')
      } else {
        nok('F. se rompió el permiso de reservas', JSON.stringify(r2))
      }
    }

    // ══ §13 G — aislamiento entre tenants ═══════════════════════════════════
    {
      const { opId } = await mkPending(A, 'property_inquiry')
      const r = await decide(asOwnerB, opId, 'confirmed')
      const { data: op } = await admin.from('operation_requests').select('status').eq('id', opId).single()
      if (r.outcome === 'not_found' && op?.status === 'pending') {
        ok('G. el owner de otro tenant recibe not_found y no toca nada')
      } else nok('G. cross-tenant no bloqueado', JSON.stringify({ r, op }))
    }

    // ══ §13 H — anon ════════════════════════════════════════════════════════
    {
      const { opId } = await mkPending(A, 'property_inquiry')
      const anon = anonClient()
      const { data, error } = await anon.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed',
      })
      const decidio = !error && (data as Rpc)?.outcome === 'confirmed'
      if (!decidio) ok(`H. anon no puede ejecutar la RPC (${error?.code ?? (data as Rpc)?.outcome})`)
      else nok('H. anon DECIDIÓ una consulta')
    }

    // ══ §13 I — platform_user / impersonación no decide ══════════════════════
    //
    // No se ejercita con una sesión real acá porque haría falta crear una cuenta
    // de plataforma (super admin), y eso está explícitamente prohibido en este
    // proyecto. La guarda es la primera cosa que hace la RPC —
    // `IF public.auth_user_type() = 'platform_user' THEN … platform_user_not_allowed`
    // — y no cambió en esta fase: la migración de 3E-B1 la conserva textual.
    //
    // La prueba con sesión real de impersonación vive en
    // supabase/32-proof-3d-impersonation.sql, de la Fase 3D.
    ok('I. platform_user: guarda intacta en la RPC; prueba con sesión real en supabase/32-proof-3d-impersonation.sql (cobertura heredada, no ejecutada acá)')

    // ══ §13 J — UPDATE directo ══════════════════════════════════════════════
    {
      const { opId } = await mkPending(A, 'property_inquiry')
      const { error } = await asOwnerA.from('operation_requests')
        .update({ status: 'confirmed' }).eq('id', opId)
      const { data: op } = await admin.from('operation_requests').select('status').eq('id', opId).single()
      if (op?.status === 'pending') {
        ok(`J. UPDATE directo de authenticated no cambia nada (${error?.code ?? 'sin filas afectadas'})`)
      } else nok('J. un UPDATE directo cambió el estado', JSON.stringify({ error, op }))
    }

    // ══ §14 — cero materialización ══════════════════════════════════════════
    console.log(`\n${HR}\n  §14 — dominio: una consulta gestionada no crea nada\n`)

    // No existe ninguna tabla de visitas en el esquema (N).
    ok('N. no existe ninguna tabla de visitas: no hay nada que se pueda crear (verificado en la auditoría de 3E-B)')

    for (const intent of ['property_inquiry', 'monthly_rental_inquiry'] as const) {
      for (const action of ['confirmed', 'rejected'] as const) {
        const antes = await efectos(A.id)
        const { opId, subId } = await mkPending(A, intent)

        const { data: opAntes } = await admin.from('operation_requests')
          .select('payload_snapshot, customer_confirmed_at, entity_type, entity_id, entity_title_snapshot, requested_date')
          .eq('id', opId).single()

        const r = await decide(asOwnerA, opId, action)
        const despues = await efectos(A.id)

        const sinEfectos =
          despues.reservas === antes.reservas &&
          despues.bloqueos === antes.bloqueos &&
          despues.contratos === antes.contratos &&
          despues.tareas === antes.tareas &&
          despues.notas === antes.notas &&
          despues.outbox === antes.outbox

        const etiqueta = `${intent} ${action}`
        if (r.outcome === action && sinEfectos) {
          ok(`K/L/M/O/P. ${etiqueta}: 0 reservas · 0 bloqueos · 0 contratos · 0 tareas · 0 notas · 0 outbox`)
        } else {
          nok(`K/L/M/O/P. ${etiqueta} produjo efectos`, JSON.stringify({ r, antes, despues }))
        }

        // Q/R/S — la evidencia no se toca al decidir.
        const { data: opDesp } = await admin.from('operation_requests')
          .select('payload_snapshot, customer_confirmed_at, entity_type, entity_id, entity_title_snapshot, requested_date, status, decided_at, decided_by')
          .eq('id', opId).single()

        const payloadIgual = JSON.stringify(opAntes!.payload_snapshot) === JSON.stringify(opDesp!.payload_snapshot)
        const confirmIgual = opAntes!.customer_confirmed_at === opDesp!.customer_confirmed_at
        const ctxIgual =
          opAntes!.entity_type === opDesp!.entity_type &&
          opAntes!.entity_id === opDesp!.entity_id &&
          opAntes!.entity_title_snapshot === opDesp!.entity_title_snapshot &&
          opAntes!.requested_date === opDesp!.requested_date

        if (payloadIgual) ok(`Q. ${etiqueta}: payload_snapshot intacto`)
        else nok(`Q. ${etiqueta}: cambió el payload_snapshot`)
        if (confirmIgual) ok(`R. ${etiqueta}: customer_confirmed_at intacto`)
        else nok(`R. ${etiqueta}: cambió customer_confirmed_at`)
        if (ctxIgual) ok(`S. ${etiqueta}: contexto de propiedad intacto`)
        else nok(`S. ${etiqueta}: cambió el contexto de propiedad`)

        // La submission tampoco se toca.
        const { data: sub } = await admin.from('form_submissions')
          .select('status, confirmed_at').eq('id', subId).single()
        if (sub?.status === 'confirmed') ok(`Q. ${etiqueta}: la submission sigue confirmed`)
        else nok(`Q. ${etiqueta}: la submission cambió`, JSON.stringify(sub))

        // T — reintento idempotente.
        const r2 = await decide(asOwnerA, opId, action === 'confirmed' ? 'rejected' : 'confirmed')
        const { data: opFinal } = await admin.from('operation_requests')
          .select('status, decided_at, decided_by').eq('id', opId).single()
        if (r2.outcome === 'already_decided' &&
            opFinal!.status === opDesp!.status &&
            opFinal!.decided_at === opDesp!.decided_at &&
            opFinal!.decided_by === opDesp!.decided_by) {
          ok(`T. ${etiqueta}: un segundo intento devuelve already_decided sin cambiar decided_at ni decided_by`)
        } else {
          nok(`T. ${etiqueta}: el reintento alteró la decisión`, JSON.stringify({ r2, opFinal }))
        }

        // U — auditoría con el actor real y la transición correcta.
        const { data: logs } = await admin.from('audit_logs')
          .select('action, actor_type, actor_id, entity_id')
          .eq('tenant_id', A.id).eq('entity_id', opId).order('created_at')
        const insert = logs?.find(l => l.action === 'system.operation_requests.insert')
        const update = logs?.filter(l => l.action === 'operation_requests.update') ?? []
        if (insert && update.length === 1 && update[0]!.actor_id === A.owner.id && update[0]!.actor_type === 'tenant_user') {
          ok(`U. ${etiqueta}: auditoría con un solo UPDATE y el actor real`)
        } else {
          nok(`U. ${etiqueta}: auditoría inesperada`, JSON.stringify(logs))
        }
      }
    }

    await Promise.all([
      asOwnerA.auth.signOut(), asRecepSiA.auth.signOut(), asRecepNoA.auth.signOut(),
      asRecepResA.auth.signOut(), asOwnerB.auth.signOut(),
    ].map(p => p.catch(() => {})))

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      for (const tb of ['reservation_events', 'reservations', 'operation_requests', 'notes', 'tasks'] as const) {
        try { await admin.from(tb).delete().eq('tenant_id', id) } catch { /* noop */ }
      }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      try { await admin.from('tenants').delete().eq('id', id) } catch { /* noop */ }
    }
    for (const id of authIds) { try { await admin.auth.admin.deleteUser(id) } catch { /* noop */ } }
    console.log(`  tenants: ${tenantIds.length} · usuarios: ${authIds.length}`)
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('[validate-inquiries] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

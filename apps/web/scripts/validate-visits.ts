/**
 * Fase 3E-B2 — visitas inmobiliarias.
 *
 * Cubre §24 (materialización), §25 (permisos), §26 (ciclo de vida) y §27
 * (timezone), por los caminos reales: la RPC de 3C para crear la solicitud y
 * decide_operation_request / reschedule / complete / cancel con logins reales.
 *
 * Usage:  pnpm --filter @orderflow/web validate:visits
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
  visit_id?: string | null
  required_permission?: string
  status?: string
  scheduled_for?: string
  previous_scheduled_for?: string
  timezone?: string
}

const TZ_A = 'America/Argentina/Buenos_Aires'
const TZ_B = 'America/Mexico_City'

/** Fecha futura, N días adelante, en formato YYYY-MM-DD. */
const futuro = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toISOString().split('T')[0]!

/** Hora local que muestra un instante según una zona — lo que ve el usuario. */
function horaLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
  }).format(new Date(iso))
}
function fechaLocal(iso: string, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz,
  }).format(new Date(iso))
  return p
}

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const RUN     = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3E-B2 — visitas inmobiliarias')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authIds:   string[] = []

  const anonClient = () => createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    async function buildTenant(label: string, tz: string) {
      const { data: t, error } = await admin.from('tenants')
        .insert({
          name: `[TEST] 3EB2 ${label} ${RUN}`,
          slug: `test-3eb2-${label.toLowerCase()}-${RUN}`,
          status: 'active', timezone: tz,
        } as never).select('id').single()
      if (error || !t) throw new Error(`tenant: ${error?.message}`)
      tenantIds.push(t.id)

      async function mkUser(
        kind: string, role: 'owner' | 'receptionist',
        perms: { reservas: boolean; visitas: boolean },
      ) {
        const password = randomBytes(18).toString('hex')
        const email    = `${kind}-3eb2-${label.toLowerCase()}-${RUN}@example.test`
        const { data: au, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
        if (e || !au.user) throw new Error(`user: ${e?.message}`)
        authIds.push(au.user.id)
        const { error: tu } = await admin.from('tenant_users').insert({
          id: au.user.id, tenant_id: t!.id, name: `${kind} ${label}`, email, role, active: true,
          can_confirm_reservations: perms.reservas,
          can_manage_visits:        perms.visitas,
        })
        if (tu) throw new Error(`tenant_users: ${tu.message}`)
        return { id: au.user.id, email, password }
      }

      const owner     = await mkUser('owner',      'owner',        { reservas: true,  visitas: true  })
      const recepSi   = await mkUser('recep-si',   'receptionist', { reservas: false, visitas: true  })
      const recepNo   = await mkUser('recep-no',   'receptionist', { reservas: false, visitas: false })
      const recepRes  = await mkUser('recep-res',  'receptionist', { reservas: true,  visitas: false })

      const { data: contact } = await admin.from('contacts')
        .insert({ tenant_id: t.id, phone: `5491${label === 'A' ? '1' : label === 'B' ? '2' : '3'}${RUN.slice(-8)}`, name: `Cliente ${label}` })
        .select('id').single()
      if (!contact) throw new Error('contact')

      const { data: prop } = await admin.from('properties').insert({
        tenant_id: t.id, title: `[TEST] Casa ${label} ${RUN}`, city: 'CABA',
        published: true, operation_type: 'sale', pricing_mode: 'consult', currency: 'ARS',
      } as never).select('id').single()
      if (!prop) throw new Error('property')

      return { id: t.id, tz, owner, recepSi, recepNo, recepRes, contactId: contact.id, propertyId: prop.id }
    }

    // Propiedad de VENTA a propósito: una visita no es una estadía, y tiene que
    // poder agendarse sobre cualquier tipo de operación.
    const A = await buildTenant('A', TZ_A)
    const B = await buildTenant('B', TZ_A)
    const C = await buildTenant('C', TZ_B)
    ok('Fixture: 3 tenants (2 en Buenos Aires, 1 en México), owner y 3 recepcionistas cada uno')

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
    const asOwnerC    = await login(C.owner)
    ok('Logins reales de owner y de las tres recepcionistas')

    type Fixture = { id: string; contactId: string; propertyId: string }

    async function mkPending(
      t: Fixture, opts: { sinPropiedad?: boolean } = {},
    ): Promise<{ opId: string; subId: string }> {
      const { data: sub, error: se } = await admin.from('form_submissions').insert({
        tenant_id: t.id, reference: generateSubmissionReference(),
        intent: 'property_visit', status: 'submitted', source: 'public_site',
        payload: {
          name: 'Ana Gómez',
          preferred_date: futuro(20),
          preferred_time_range: 'afternoon',
          notes: 'Timbre 3B',
        } as never,
        idempotency_key: randomUUID(), contact_id: t.contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        ...(opts.sinPropiedad ? {} : { entity_type: 'property', entity_id: t.propertyId }),
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

    async function agendar(
      c: SupabaseClient<Database>, opId: string, fecha?: string, hora?: string,
    ): Promise<Rpc> {
      const { data, error } = await c.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed',
        ...(fecha ? { p_scheduled_date: fecha } : {}),
        ...(hora  ? { p_scheduled_time: hora }  : {}),
      })
      if (error) return { outcome: `error:${error.code}` }
      return (data ?? {}) as Rpc
    }

    async function visitasDe(opId: string) {
      const { data } = await admin.from('property_visits')
        .select('*').eq('source_operation_request_id', opId)
      return data ?? []
    }

    async function opDe(opId: string) {
      const { data } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by, payload_snapshot, customer_confirmed_at, requested_date, entity_id')
        .eq('id', opId).single()
      return data!
    }

    async function efectos(tenantId: string) {
      const n = async (tb: 'reservations' | 'property_availability_blocks' | 'availability_blocks' | 'tasks') => {
        const { count } = await admin.from(tb).select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
        return count ?? 0
      }
      const { count: outbox } = await admin.from('messaging_outbox').select('id', { count: 'exact', head: true })
      return {
        reservas: await n('reservations'),
        bloqueos: await n('property_availability_blocks'),
        bloqueos2: await n('availability_blocks'),
        tareas: await n('tasks'),
        outbox: outbox ?? 0,
      }
    }

    // ══ §24 — materialización ═══════════════════════════════════════════════
    console.log(`\n${HR}\n  §24 — materialización\n`)

    const FECHA = futuro(30)
    const HORA  = '17:30'
    let visitaPrincipal = ''
    let opPrincipal     = ''

    {
      const antes = await efectos(A.id)
      const { opId, subId } = await mkPending(A)
      opPrincipal = opId

      const opAntes = await opDe(opId)
      const r = await agendar(asOwnerA, opId, FECHA, HORA)
      const visitas = await visitasDe(opId)
      const opDesp = await opDe(opId)

      if (r.outcome === 'confirmed' && visitas.length === 1 && visitas[0]!.status === 'scheduled') {
        ok('A. visita agendada: una property_visit en estado scheduled')
        visitaPrincipal = visitas[0]!.id
      } else {
        nok('A. no se creó la visita', JSON.stringify({ r, visitas }))
      }

      if (opDesp.status === 'confirmed' && opDesp.decided_at !== null) {
        ok('B. la operation_request quedó confirmed con decided_at')
      } else nok('B. la solicitud no quedó confirmed', JSON.stringify(opDesp))

      if (opDesp.decided_by === A.owner.id && visitas[0]?.scheduled_by === A.owner.id) {
        ok('H. actor real en decided_by y en scheduled_by')
      } else nok('H. actor incorrecto', JSON.stringify({ opDesp, v: visitas[0] }))

      // J — la evidencia original no se toca
      const evidenciaIgual =
        JSON.stringify(opAntes.payload_snapshot) === JSON.stringify(opDesp.payload_snapshot) &&
        opAntes.customer_confirmed_at === opDesp.customer_confirmed_at &&
        opAntes.requested_date === opDesp.requested_date &&
        opAntes.entity_id === opDesp.entity_id
      if (evidenciaIgual) ok('J. payload, customer_confirmed_at, fecha pedida y propiedad intactos')
      else nok('J. cambió la evidencia original')

      const { data: sub } = await admin.from('form_submissions').select('status').eq('id', subId).single()
      if (sub?.status === 'confirmed') ok('J. la submission sigue confirmed')
      else nok('J. la submission cambió', JSON.stringify(sub))

      // §3 — la preferencia NO se copia a la visita
      const v = visitas[0] as Record<string, unknown> | undefined
      if (v && !('preferred_date' in v) && !('preferred_time_range' in v)) {
        ok('§3. la preferencia del cliente NO se duplicó en property_visits')
      } else nok('§3. la preferencia se copió a la visita')

      // §4 — la hora agendada puede caer fuera de la franja pedida
      if (horaLocal(visitas[0]!.scheduled_for, A.tz) === HORA) {
        ok(`§4. la hora agendada (${HORA}) se guardó tal cual, sin atarse a la franja "afternoon"`)
      } else nok('§4. la hora no coincide', horaLocal(visitas[0]!.scheduled_for, A.tz))

      // K/L/M/N — cero efectos
      const desp = await efectos(A.id)
      if (desp.reservas === antes.reservas && desp.bloqueos === antes.bloqueos &&
          desp.bloqueos2 === antes.bloqueos2 && desp.tareas === antes.tareas && desp.outbox === antes.outbox) {
        ok('K/L/M/N. 0 reservas · 0 bloqueos · 0 tareas · 0 outbox')
      } else nok('K/L/M/N. hubo efectos', JSON.stringify({ antes, desp }))
    }

    // C/D — unicidad e idempotencia
    {
      const r2 = await agendar(asOwnerA, opPrincipal, futuro(40), '10:00')
      const visitas = await visitasDe(opPrincipal)
      if (r2.outcome === 'already_decided' && visitas.length === 1 && visitas[0]!.id === visitaPrincipal) {
        ok('D. reintentar devuelve already_decided y sigue habiendo UNA sola visita')
      } else nok('D. el reintento duplicó o alteró', JSON.stringify({ r2, n: visitas.length }))

      // C — la UNIQUE es la garantía dura, no el chequeo de la app.
      const { error } = await admin.from('property_visits').insert({
        tenant_id: A.id, contact_id: A.contactId, property_id: A.propertyId,
        source_operation_request_id: opPrincipal,
        scheduled_for: new Date(Date.now() + 86_400_000).toISOString(),
        timezone_snapshot: A.tz, status: 'scheduled',
      } as never)
      if (error?.code === '23505') ok('C. un INSERT directo con la misma operación se rechaza por UNIQUE (23505)')
      else nok('C. la base permitió dos visitas para una operación', error?.message ?? 'insert exitoso')
    }

    // E — rechazar no crea visita
    {
      const { opId } = await mkPending(A)
      const { data } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'rejected',
      })
      const visitas = await visitasDe(opId)
      const op = await opDe(opId)
      if ((data as Rpc)?.outcome === 'rejected' && visitas.length === 0 && op.status === 'rejected') {
        ok('E. descartar la solicitud no agenda ninguna visita')
      } else nok('E. el rechazo creó una visita', JSON.stringify({ data, n: visitas.length }))
    }

    // F — sin propiedad
    {
      const { opId } = await mkPending(A, { sinPropiedad: true })
      const r = await agendar(asOwnerA, opId, futuro(25), '12:00')
      const op = await opDe(opId)
      if (r.outcome === 'missing_visit_context' && op.status === 'pending' && op.decided_at === null) {
        ok('F. sin propiedad: missing_visit_context y la solicitud sigue pending')
      } else nok('F. se agendó sin propiedad', JSON.stringify({ r, op }))
    }

    // G — fecha/hora pasada
    {
      const { opId } = await mkPending(A)
      const r = await agendar(asOwnerA, opId, futuro(-2), '12:00')
      const op = await opDe(opId)
      const visitas = await visitasDe(opId)
      if (r.outcome === 'scheduled_time_in_past' && op.status === 'pending' &&
          op.decided_at === null && op.decided_by === null && visitas.length === 0) {
        ok('G. hora en el pasado: scheduled_time_in_past, 0 visitas, solicitud pending')
      } else nok('G. se agendó en el pasado', JSON.stringify({ r, op }))
    }

    // §7 — la guarda de parámetros
    {
      const { opId } = await mkPending(A)
      const { data } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'rejected',
        p_scheduled_date: futuro(10), p_scheduled_time: '12:00',
      })
      const op = await opDe(opId)
      if ((data as Rpc)?.outcome === 'invalid_parameters' && op.status === 'pending') {
        ok('§7. mandar fecha/hora al DESCARTAR se rechaza con invalid_parameters, sin tocar nada')
      } else nok('§7. la guarda de parámetros no funcionó', JSON.stringify({ data, op }))
    }

    // Sin fecha/hora al agendar
    {
      const { opId } = await mkPending(A)
      const r = await agendar(asOwnerA, opId)
      const op = await opDe(opId)
      if (r.outcome === 'visit_schedule_required' && op.status === 'pending') {
        ok('§5. agendar sin fecha/hora devuelve visit_schedule_required y no decide nada')
      } else nok('§5. se agendó sin fecha ni hora', JSON.stringify({ r, op }))
    }

    // I — cross tenant
    {
      const { opId } = await mkPending(A)
      const r = await agendar(asOwnerB, opId, futuro(15), '11:00')
      const op = await opDe(opId)
      if (r.outcome === 'not_found' && op.status === 'pending') {
        ok('I. el owner de otro tenant recibe not_found y no toca nada')
      } else nok('I. cross-tenant no bloqueado', JSON.stringify({ r, op }))
    }

    // ══ §25 — permisos ══════════════════════════════════════════════════════
    console.log(`\n${HR}\n  §25 — permisos\n`)

    ok('O. owner agenda (verificado en A)')

    {
      const { opId } = await mkPending(A)
      const r = await agendar(asRecepSiA, opId, futuro(31), '09:00')
      if (r.outcome === 'confirmed') ok('P/S. recepcionista con can_manage_visits (y SIN can_confirm_reservations) agenda')
      else nok('P/S. la recepcionista habilitada no pudo', JSON.stringify(r))
    }
    {
      const { opId } = await mkPending(A)
      const r = await agendar(asRecepNoA, opId, futuro(32), '09:00')
      const op = await opDe(opId)
      if (r.outcome === 'forbidden' && op.status === 'pending') {
        ok('Q. recepcionista sin permisos → forbidden, solicitud pending')
      } else nok('Q. una recepcionista sin permisos agendó', JSON.stringify({ r, op }))
    }
    {
      // EL CASO CRÍTICO del §18: el permiso de reservas ya no habilita visitas.
      const { opId } = await mkPending(A)
      const r = await agendar(asRecepResA, opId, futuro(33), '09:00')
      const op = await opDe(opId)
      const visitas = await visitasDe(opId)
      if (r.outcome === 'forbidden' && r.required_permission === 'can_manage_visits' &&
          op.status === 'pending' && visitas.length === 0) {
        ok('R. recepcionista con SOLO can_confirm_reservations NO puede agendar — brecha cerrada')
      } else nok('R. can_confirm_reservations siguió autorizando visitas', JSON.stringify({ r, op }))
    }

    // T — anon
    {
      const { opId } = await mkPending(A)
      const anon = anonClient()
      const { data, error } = await anon.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed',
        p_scheduled_date: futuro(20), p_scheduled_time: '10:00',
      })
      if (error || (data as Rpc)?.outcome !== 'confirmed') {
        ok(`T. anon no puede ejecutar la RPC (${error?.code ?? (data as Rpc)?.outcome})`)
      } else nok('T. anon agendó una visita')
    }

    // U — UPDATE / INSERT / DELETE directo sobre property_visits
    {
      const { error: upd } = await asOwnerA.from('property_visits')
        .update({ status: 'completed' }).eq('id', visitaPrincipal)
      const { error: ins } = await asOwnerA.from('property_visits').insert({
        tenant_id: A.id, contact_id: A.contactId, property_id: A.propertyId,
        source_operation_request_id: opPrincipal,
        scheduled_for: new Date(Date.now() + 86_400_000).toISOString(),
        timezone_snapshot: A.tz,
      } as never)
      const { error: del } = await asOwnerA.from('property_visits').delete().eq('id', visitaPrincipal)

      const { data: v } = await admin.from('property_visits').select('status').eq('id', visitaPrincipal).single()
      if (v?.status === 'scheduled' && (upd || ins || del)) {
        ok(`U. authenticated no puede escribir property_visits directo (${upd?.code ?? ins?.code ?? del?.code})`)
      } else nok('U. un write directo pasó', JSON.stringify({ upd, ins, del, v }))
    }

    // V — impersonación de plataforma
    ok('V. impersonación: property_visits solo tiene policy sa_imp_ de SELECT — no hay UPDATE/INSERT/DELETE para nadie (verificado en el esquema; no se crea super admin)')

    // ══ §26 — ciclo de vida ═════════════════════════════════════════════════
    console.log(`\n${HR}\n  §26 — ciclo de vida\n`)

    // Y/Z/AA — reagendar
    {
      const { data: antes } = await admin.from('property_visits')
        .select('scheduled_for').eq('id', visitaPrincipal).single()
      const opAntes = await opDe(opPrincipal)

      const NUEVA_FECHA = futuro(45), NUEVA_HORA = '11:15'
      const { data } = await asOwnerA.rpc('reschedule_property_visit', {
        p_visit_id: visitaPrincipal, p_scheduled_date: NUEVA_FECHA, p_scheduled_time: NUEVA_HORA,
      })
      const r = data as Rpc
      const { data: desp } = await admin.from('property_visits')
        .select('scheduled_for, timezone_snapshot, status, source_operation_request_id')
        .eq('id', visitaPrincipal).single()
      const opDesp = await opDe(opPrincipal)

      if (r?.outcome === 'rescheduled' &&
          horaLocal(desp!.scheduled_for, A.tz) === NUEVA_HORA &&
          fechaLocal(desp!.scheduled_for, A.tz) === NUEVA_FECHA &&
          desp!.status === 'scheduled') {
        ok(`Y. reagendada a ${NUEVA_FECHA} ${NUEVA_HORA}, sigue scheduled`)
      } else nok('Y. el reagendamiento no aplicó', JSON.stringify({ r, desp }))

      if (desp!.source_operation_request_id === opPrincipal &&
          opDesp.status === opAntes.status &&
          opDesp.decided_at === opAntes.decided_at &&
          JSON.stringify(opDesp.payload_snapshot) === JSON.stringify(opAntes.payload_snapshot)) {
        ok('Z. reagendar NO modificó la operation_request ni la preferencia original')
      } else nok('Z. reagendar tocó la solicitud', JSON.stringify({ opAntes, opDesp }))

      const { data: logs } = await admin.from('audit_logs')
        .select('action, actor_id, old_value, new_value')
        .eq('entity_id', visitaPrincipal).order('created_at')
      const upd = (logs ?? []).filter(l => l.action === 'property_visits.update')
      const cambio = upd.find(l =>
        (l.old_value as Record<string, unknown> | null)?.['scheduled_for'] === antes!.scheduled_for &&
        (l.new_value as Record<string, unknown> | null)?.['scheduled_for'] === desp!.scheduled_for)
      if (cambio && cambio.actor_id === A.owner.id) {
        ok('AA. el cambio de horario quedó auditado con old → new y el actor real')
      } else nok('AA. la auditoría del reagendamiento no aparece', JSON.stringify(upd.slice(0, 2)))
    }

    // Reagendar al pasado
    {
      const { data } = await asOwnerA.rpc('reschedule_property_visit', {
        p_visit_id: visitaPrincipal, p_scheduled_date: futuro(-1), p_scheduled_time: '10:00',
      })
      if ((data as Rpc)?.outcome === 'scheduled_time_in_past') ok('§13. reagendar al pasado se rechaza')
      else nok('§13. se pudo reagendar al pasado', JSON.stringify(data))
    }

    // W/AF — completar
    {
      const { data: d1 } = await asOwnerA.rpc('complete_property_visit', { p_visit_id: visitaPrincipal })
      const { data: v1 } = await admin.from('property_visits')
        .select('status, completed_at, completed_by').eq('id', visitaPrincipal).single()
      if ((d1 as Rpc)?.outcome === 'completed' && v1?.status === 'completed' &&
          v1.completed_at !== null && v1.completed_by === A.owner.id) {
        ok('W. scheduled → completed, con actor y timestamp')
      } else nok('W. no se completó', JSON.stringify({ d1, v1 }))

      const { data: d2 } = await asOwnerA.rpc('complete_property_visit', { p_visit_id: visitaPrincipal })
      const { data: v2 } = await admin.from('property_visits')
        .select('completed_at, completed_by').eq('id', visitaPrincipal).single()
      if ((d2 as Rpc)?.outcome === 'already_completed' && v2!.completed_at === v1!.completed_at) {
        ok('AF. completar dos veces es idempotente: no reescribe cuándo ni quién')
      } else nok('AF. el segundo complete alteró la visita', JSON.stringify({ d2, v1, v2 }))
    }

    // AB/AD — desde completed
    {
      const { data: re } = await asOwnerA.rpc('reschedule_property_visit', {
        p_visit_id: visitaPrincipal, p_scheduled_date: futuro(50), p_scheduled_time: '10:00',
      })
      const { data: ca } = await asOwnerA.rpc('cancel_property_visit', { p_visit_id: visitaPrincipal })
      const { data: v } = await admin.from('property_visits').select('status').eq('id', visitaPrincipal).single()
      if ((re as Rpc)?.outcome === 'not_reschedulable' && (ca as Rpc)?.outcome === 'invalid_transition' &&
          v?.status === 'completed') {
        ok('AB/AD. una visita realizada no se puede reagendar ni cancelar')
      } else nok('AB/AD. transición prohibida permitida', JSON.stringify({ re, ca, v }))
    }

    // X/AC/AE — cancelar en otra visita
    {
      const { opId } = await mkPending(A)
      const r = await agendar(asOwnerA, opId, futuro(35), '16:00')
      const vid = r.visit_id!

      const { data: d1 } = await asOwnerA.rpc('cancel_property_visit', {
        p_visit_id: vid, p_reason: 'El cliente reprogramó por teléfono',
      })
      const { data: v1 } = await admin.from('property_visits')
        .select('status, cancelled_at, cancelled_by, cancellation_reason').eq('id', vid).single()
      if ((d1 as Rpc)?.outcome === 'cancelled' && v1?.status === 'cancelled' &&
          v1.cancelled_by === A.owner.id && v1.cancellation_reason === 'El cliente reprogramó por teléfono') {
        ok('X. scheduled → cancelled, con motivo, actor y timestamp')
      } else nok('X. no se canceló bien', JSON.stringify({ d1, v1 }))

      // §15 — la solicitud sigue confirmed
      const op = await opDe(opId)
      if (op.status === 'confirmed') {
        ok('§15. cancelar la visita NO cambia el estado de la operation_request')
      } else nok('§15. la cancelación reescribió la decisión original', op.status)

      const { data: d2 } = await asOwnerA.rpc('reschedule_property_visit', {
        p_visit_id: vid, p_scheduled_date: futuro(36), p_scheduled_time: '10:00',
      })
      const { data: d3 } = await asOwnerA.rpc('complete_property_visit', { p_visit_id: vid })
      const { data: d4 } = await asOwnerA.rpc('cancel_property_visit', { p_visit_id: vid })
      const { data: v2 } = await admin.from('property_visits')
        .select('status, cancelled_at').eq('id', vid).single()

      if ((d2 as Rpc)?.outcome === 'not_reschedulable' && (d3 as Rpc)?.outcome === 'invalid_transition' &&
          (d4 as Rpc)?.outcome === 'already_cancelled' && v2!.cancelled_at === v1!.cancelled_at) {
        ok('AC/AE/AF. una visita cancelada no se reagenda ni se completa, y re-cancelar es idempotente')
      } else nok('AC/AE/AF. transición prohibida permitida', JSON.stringify({ d2, d3, d4 }))
    }

    // Permiso en el ciclo de vida
    {
      const { opId } = await mkPending(A)
      const r = await agendar(asOwnerA, opId, futuro(37), '15:00')
      const vid = r.visit_id!
      const { data } = await asRecepResA.rpc('cancel_property_visit', { p_visit_id: vid })
      const { data: v } = await admin.from('property_visits').select('status').eq('id', vid).single()
      if ((data as Rpc)?.outcome === 'forbidden' && v?.status === 'scheduled') {
        ok('§13. el ciclo de vida también exige can_manage_visits (no alcanza el de reservas)')
      } else nok('§13. una recepcionista sin permiso canceló', JSON.stringify({ data, v }))
    }

    // ══ §27 — timezone ══════════════════════════════════════════════════════
    console.log(`\n${HR}\n  §27 — timezone\n`)

    const TZ_FECHA = futuro(60)
    const TZ_HORA  = '17:30'
    let visitaA = '', instanteA = ''

    {
      const { opId } = await mkPending(A)
      const r = await agendar(asOwnerA, opId, TZ_FECHA, TZ_HORA)
      const { data: v } = await admin.from('property_visits')
        .select('id, scheduled_for, timezone_snapshot').eq('id', r.visit_id!).single()
      visitaA = v!.id; instanteA = v!.scheduled_for

      if (v!.timezone_snapshot === TZ_A) ok(`timezone: el snapshot es el del tenant (${TZ_A})`)
      else nok('timezone: snapshot incorrecto', v!.timezone_snapshot)

      if (horaLocal(v!.scheduled_for, TZ_A) === TZ_HORA && fechaLocal(v!.scheduled_for, TZ_A) === TZ_FECHA) {
        ok(`timezone: ${TZ_HORA} local vuelve a mostrarse como ${TZ_HORA} en ${TZ_A}`)
      } else nok('timezone: el display no coincide', horaLocal(v!.scheduled_for, TZ_A))
    }

    {
      const { opId } = await mkPending(C)
      const r = await agendar(asOwnerC, opId, TZ_FECHA, TZ_HORA)
      const { data: v } = await admin.from('property_visits')
        .select('scheduled_for, timezone_snapshot').eq('id', r.visit_id!).single()

      if (v!.timezone_snapshot === TZ_B) ok(`timezone: otro tenant usa su propia zona (${TZ_B})`)
      else nok('timezone: el segundo tenant no usó su zona', v!.timezone_snapshot)

      if (v!.scheduled_for !== instanteA) {
        ok('timezone: la MISMA hora local en dos zonas produce instantes distintos')
      } else nok('timezone: los instantes coincidieron, la zona no se aplicó')

      if (horaLocal(v!.scheduled_for, TZ_B) === TZ_HORA) {
        ok(`timezone: ${TZ_HORA} local en ${TZ_B} también vuelve como ${TZ_HORA}`)
      } else nok('timezone: display incorrecto en el segundo tenant', horaLocal(v!.scheduled_for, TZ_B))
    }

    // El snapshot congela la interpretación histórica
    {
      await admin.from('tenants').update({ timezone: TZ_B } as never).eq('id', A.id)

      const { data: v } = await admin.from('property_visits')
        .select('scheduled_for, timezone_snapshot').eq('id', visitaA).single()

      const intacta = v!.timezone_snapshot === TZ_A && v!.scheduled_for === instanteA &&
                      horaLocal(v!.scheduled_for, v!.timezone_snapshot) === TZ_HORA
      if (intacta) {
        ok('timezone: cambiar tenants.timezone NO altera una visita existente — el snapshot la protege')
      } else nok('timezone: la visita histórica se reinterpretó', JSON.stringify(v))

      // Una visita NUEVA sí usa la zona nueva.
      const { opId } = await mkPending(A)
      const r = await agendar(asOwnerA, opId, TZ_FECHA, TZ_HORA)
      const { data: v2 } = await admin.from('property_visits')
        .select('scheduled_for, timezone_snapshot').eq('id', r.visit_id!).single()
      if (v2!.timezone_snapshot === TZ_B && v2!.scheduled_for !== instanteA) {
        ok('timezone: una visita NUEVA sí toma la zona nueva del tenant')
      } else nok('timezone: la visita nueva no tomó la zona nueva', JSON.stringify(v2))

      await admin.from('tenants').update({ timezone: TZ_A } as never).eq('id', A.id)
    }

    await Promise.all([asOwnerA, asRecepSiA, asRecepNoA, asRecepResA, asOwnerB, asOwnerC]
      .map(c => c.auth.signOut().catch(() => {})))

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      for (const tb of ['property_visits', 'reservation_events', 'reservations', 'operation_requests'] as const) {
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
  console.error('[validate-visits] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

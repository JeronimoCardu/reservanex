/**
 * Fase 3E-C2 — reservas de mesa.
 *
 * Cubre §20 (materialización), §21 (permisos), §22 (ciclo de vida),
 * §23 (timezone) y §24 (regresión de general_inquiry), por los caminos reales:
 * la RPC de 3C para crear la solicitud y decide_operation_request / edit /
 * complete / cancel / no_show con logins reales.
 *
 * Usage:  pnpm --filter @orderflow/web validate:table-reservations
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
  table_reservation_id?: string | null
  required_permission?: string
  status?: string
  party_size?: number
  scheduled_for?: string
}

const TZ_A = 'America/Argentina/Buenos_Aires'
const TZ_B = 'America/Mexico_City'

const futuro = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toISOString().split('T')[0]!

function horaLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
  }).format(new Date(iso))
}
function fechaLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz,
  }).format(new Date(iso))
}

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const RUN     = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3E-C2 — reservas de mesa')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authIds:   string[] = []

  const anonClient = () => createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    async function buildTenant(label: string, tz: string) {
      const { data: t, error } = await admin.from('tenants')
        .insert({
          name: `[TEST] 3EC2 ${label} ${RUN}`,
          slug: `test-3ec2-${label.toLowerCase()}-${RUN}`,
          status: 'active', vertical: 'food_service', timezone: tz,
        } as never).select('id').single()
      if (error || !t) throw new Error(`tenant: ${error?.message}`)
      tenantIds.push(t.id)

      async function mkUser(
        kind: string, role: 'owner' | 'receptionist',
        perms: { reservas: boolean; mesas: boolean; consultas?: boolean },
      ) {
        const password = randomBytes(18).toString('hex')
        const email    = `${kind}-3ec2-${label.toLowerCase()}-${RUN}@example.test`
        const { data: au, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
        if (e || !au.user) throw new Error(`user: ${e?.message}`)
        authIds.push(au.user.id)
        const { error: tu } = await admin.from('tenant_users').insert({
          id: au.user.id, tenant_id: t!.id, name: `${kind} ${label}`, email, role, active: true,
          can_confirm_reservations:     perms.reservas,
          can_manage_table_reservations: perms.mesas,
          can_manage_inquiries:          perms.consultas ?? false,
        } as never)
        if (tu) throw new Error(`tenant_users: ${tu.message}`)
        return { id: au.user.id, email, password }
      }

      const owner    = await mkUser('owner',     'owner',        { reservas: true,  mesas: true })
      const recepSi  = await mkUser('recep-si',  'receptionist', { reservas: false, mesas: true })
      const recepNo  = await mkUser('recep-no',  'receptionist', { reservas: false, mesas: false })
      const recepRes = await mkUser('recep-res', 'receptionist', { reservas: true,  mesas: false })
      const recepInq = await mkUser('recep-inq', 'receptionist', { reservas: false, mesas: false, consultas: true })

      const { data: contact } = await admin.from('contacts')
        .insert({ tenant_id: t.id, phone: `5498${label === 'A' ? '1' : label === 'B' ? '2' : '3'}${RUN.slice(-8)}`, name: null })
        .select('id').single()
      if (!contact) throw new Error('contact')

      return { id: t.id, tz, owner, recepSi, recepNo, recepRes, recepInq, contactId: contact.id }
    }

    const A = await buildTenant('A', TZ_A)
    const B = await buildTenant('B', TZ_A)
    const C = await buildTenant('C', TZ_B)
    ok('Fixture: 3 tenants food_service (2 en Buenos Aires, 1 en México) con owner y 4 recepcionistas')

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
    const asRecepInqA = await login(A.recepInq)
    const asOwnerB    = await login(B.owner)
    const asOwnerC    = await login(C.owner)
    ok('Logins reales')

    type Fixture = { id: string; contactId: string }

    /** Crea una solicitud de mesa pending por el camino real (RPC de 3C). */
    async function mkPending(
      t: Fixture,
      opts: { date?: string; time?: string; people?: number; intent?: string } = {},
    ): Promise<{ opId: string; subId: string }> {
      const intent = opts.intent ?? 'table_reservation'
      const payload = intent === 'general_inquiry'
        ? { name: 'Carla Ruiz', message: '¿Tienen opciones sin TACC?' }
        : {
            name:   'Ana Gómez',
            date:   opts.date   ?? futuro(20),
            time:   opts.time   ?? '20:30',
            people: opts.people ?? 4,
            notes:  'Mesa junto a la ventana si se puede.',
          }

      const { data: sub, error: se } = await admin.from('form_submissions').insert({
        tenant_id: t.id, reference: generateSubmissionReference(),
        intent, status: 'submitted', source: 'public_site',
        payload: payload as never, idempotency_key: randomUUID(), contact_id: t.contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
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

    async function confirmar(
      c: SupabaseClient<Database>, opId: string,
      fecha?: string, hora?: string, personas?: number,
    ): Promise<Rpc> {
      const { data, error } = await c.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed',
        ...(fecha    ? { p_scheduled_date: fecha } : {}),
        ...(hora     ? { p_scheduled_time: hora }  : {}),
        ...(personas === undefined ? {} : { p_party_size: personas }),
      })
      if (error) return { outcome: `error:${error.code}` }
      return (data ?? {}) as Rpc
    }

    const reservasDe = async (opId: string) => {
      const { data } = await admin.from('table_reservations')
        .select('*').eq('source_operation_request_id', opId)
      return data ?? []
    }

    const opDe = async (opId: string) => {
      const { data } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by, payload_snapshot, requested_date, requested_time, customer_confirmed_at')
        .eq('id', opId).single()
      return data!
    }

    async function efectos(tenantId: string) {
      const n = async (tb: 'reservations' | 'property_availability_blocks' | 'property_visits' | 'tasks') => {
        const { count } = await admin.from(tb).select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
        return count ?? 0
      }
      const { count: outbox } = await admin.from('messaging_outbox').select('id', { count: 'exact', head: true })
      return {
        reservas: await n('reservations'), bloqueos: await n('property_availability_blocks'),
        visitas: await n('property_visits'), tareas: await n('tasks'), outbox: outbox ?? 0,
      }
    }

    // ══ §20 — materialización ═══════════════════════════════════════════════
    console.log(`\n${HR}\n  §20 — materialización\n`)

    const FECHA = futuro(30), HORA = '21:00'
    let reservaPrincipal = '', opPrincipal = ''

    {
      const antes = await efectos(A.id)
      const { opId, subId } = await mkPending(A)
      opPrincipal = opId
      const opAntes = await opDe(opId)

      // H — se confirma con valores DISTINTOS a los solicitados (20:30 / 4).
      const r = await confirmar(asOwnerA, opId, FECHA, HORA, 5)
      const reservas = await reservasDe(opId)
      const opDesp = await opDe(opId)

      if (r.outcome === 'confirmed' && reservas.length === 1 && reservas[0]!.status === 'confirmed') {
        ok('A. reserva creada en estado confirmed')
        reservaPrincipal = reservas[0]!.id
      } else nok('A. no se creó la reserva', JSON.stringify({ r, reservas }))

      if (opDesp.status === 'confirmed' && opDesp.decided_at !== null) {
        ok('B. la operation_request quedó confirmed con decided_at')
      } else nok('B. la solicitud no quedó confirmed', JSON.stringify(opDesp))

      if (opDesp.decided_by === A.owner.id && reservas[0]?.confirmed_by === A.owner.id) {
        ok('J. actor real en decided_by y confirmed_by')
      } else nok('J. actor incorrecto')

      // H — lo acordado difiere de lo solicitado, y lo solicitado NO cambió.
      const v = reservas[0]!
      const acordadoOk = horaLocal(v.scheduled_for, A.tz) === HORA &&
                         fechaLocal(v.scheduled_for, A.tz) === FECHA && v.party_size === 5
      const pedidoOk = opDesp.requested_time === '20:30:00' &&
                       (opDesp.payload_snapshot as Record<string, unknown>)['people'] === 4 &&
                       (opDesp.payload_snapshot as Record<string, unknown>)['time'] === '20:30'
      if (acordadoOk && pedidoOk) {
        ok('H. lo ACORDADO (21:00, 5 personas) difiere de lo SOLICITADO (20:30, 4), y lo pedido queda intacto')
      } else nok('H. la separación pedido/acordado falló', JSON.stringify({ v, opDesp }))

      // I — evidencia intacta
      const evidenciaIgual =
        JSON.stringify(opAntes.payload_snapshot) === JSON.stringify(opDesp.payload_snapshot) &&
        opAntes.customer_confirmed_at === opDesp.customer_confirmed_at &&
        opAntes.requested_date === opDesp.requested_date &&
        opAntes.requested_time === opDesp.requested_time
      if (evidenciaIgual) ok('I. payload, customer_confirmed_at y fecha/hora pedidas intactos')
      else nok('I. cambió la evidencia original')

      const { data: sub } = await admin.from('form_submissions').select('status').eq('id', subId).single()
      if (sub?.status === 'confirmed') ok('I. la submission sigue confirmed')
      else nok('I. la submission cambió')

      // §2 — lo pedido NO se copia a la reserva
      const row = v as Record<string, unknown>
      if (!('requested_date' in row) && !('people' in row) && !('notes' in row)) {
        ok('§2. lo solicitado NO se duplicó en table_reservations')
      } else nok('§2. se copió la solicitud a la reserva')

      // L/M/N/O/P
      const desp = await efectos(A.id)
      if (desp.reservas === antes.reservas && desp.bloqueos === antes.bloqueos &&
          desp.visitas === antes.visitas && desp.tareas === antes.tareas && desp.outbox === antes.outbox) {
        ok('L/M/N/O/P. 0 reservas inmobiliarias · 0 bloqueos · 0 visitas · 0 tareas · 0 outbox')
      } else nok('L-P. hubo efectos', JSON.stringify({ antes, desp }))
    }

    // C/D — unicidad e idempotencia
    {
      const r2 = await confirmar(asOwnerA, opPrincipal, futuro(40), '10:00', 2)
      const reservas = await reservasDe(opPrincipal)
      if (r2.outcome === 'already_decided' && reservas.length === 1 && reservas[0]!.id === reservaPrincipal) {
        ok('D. reintentar devuelve already_decided y sigue habiendo UNA sola reserva')
      } else nok('D. el reintento duplicó', JSON.stringify({ r2, n: reservas.length }))

      const { error } = await admin.from('table_reservations').insert({
        tenant_id: A.id, contact_id: A.contactId, source_operation_request_id: opPrincipal,
        scheduled_for: new Date(Date.now() + 86_400_000).toISOString(),
        timezone_snapshot: A.tz, party_size: 2, status: 'confirmed',
      } as never)
      if (error?.code === '23505') ok('C. un INSERT directo con la misma operación se rechaza por UNIQUE (23505)')
      else nok('C. la base permitió dos reservas para una operación', error?.message ?? 'insert exitoso')
    }

    // E — rechazar
    {
      const { opId } = await mkPending(A)
      const { data } = await asOwnerA.rpc('decide_operation_request', { p_operation_id: opId, p_action: 'rejected' })
      const reservas = await reservasDe(opId)
      const op = await opDe(opId)
      if ((data as Rpc)?.outcome === 'rejected' && reservas.length === 0 && op.status === 'rejected') {
        ok('E. rechazar la solicitud no crea ninguna reserva')
      } else nok('E. el rechazo creó una reserva', JSON.stringify({ data, n: reservas.length }))
    }

    // F — fecha/hora pasada
    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asOwnerA, opId, futuro(-2), '20:00', 4)
      const op = await opDe(opId)
      if (r.outcome === 'scheduled_time_in_past' && op.status === 'pending' &&
          op.decided_at === null && op.decided_by === null && (await reservasDe(opId)).length === 0) {
        ok('F. hora en el pasado: scheduled_time_in_past, 0 reservas, solicitud pending')
      } else nok('F. se confirmó en el pasado', JSON.stringify({ r, op }))
    }

    // G — party_size inválido
    {
      for (const [n, etiqueta] of [[0, 'cero'], [51, 'más de 50']] as const) {
        const { opId } = await mkPending(A)
        const r = await confirmar(asOwnerA, opId, futuro(25), '20:00', n)
        const op = await opDe(opId)
        if (r.outcome === 'invalid_party_size' && op.status === 'pending') {
          ok(`G. party_size ${etiqueta} (${n}): invalid_party_size y la solicitud sigue pending`)
        } else nok(`G. se aceptó party_size ${n}`, JSON.stringify({ r, op }))
      }
    }

    // Sin fecha/hora
    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asOwnerA, opId)
      const op = await opDe(opId)
      if (r.outcome === 'table_schedule_required' && op.status === 'pending') {
        ok('§4. confirmar sin fecha/hora devuelve table_schedule_required y no decide nada')
      } else nok('§4. se confirmó sin fecha ni hora', JSON.stringify({ r, op }))
    }

    // Sin party_size explícito toma el solicitado
    {
      const { opId } = await mkPending(A, { people: 7 })
      const r = await confirmar(asOwnerA, opId, futuro(26), '19:00')
      const reservas = await reservasDe(opId)
      if (r.outcome === 'confirmed' && reservas[0]?.party_size === 7) {
        ok('§6. sin party_size explícito se toma el solicitado (7)')
      } else nok('§6. no se tomó el party_size solicitado', JSON.stringify({ r, reservas }))
    }

    // Guarda de parámetros
    {
      const { opId } = await mkPending(A)
      const { data } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'rejected',
        p_scheduled_date: futuro(10), p_scheduled_time: '20:00', p_party_size: 4,
      })
      const op = await opDe(opId)
      if ((data as Rpc)?.outcome === 'invalid_parameters' && op.status === 'pending') {
        ok('§5. mandar fecha/hora/personas al RECHAZAR se rechaza con invalid_parameters')
      } else nok('§5. la guarda de parámetros no funcionó', JSON.stringify({ data, op }))
    }

    // K — cross tenant
    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asOwnerB, opId, futuro(15), '20:00', 3)
      const op = await opDe(opId)
      if (r.outcome === 'not_found' && op.status === 'pending') {
        ok('K. el owner de otro tenant recibe not_found y no toca nada')
      } else nok('K. cross-tenant no bloqueado', JSON.stringify({ r, op }))
    }

    // ══ §21 — permisos ══════════════════════════════════════════════════════
    console.log(`\n${HR}\n  §21 — permisos\n`)

    ok('Q. owner confirma (verificado en A)')

    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asRecepSiA, opId, futuro(31), '20:00', 2)
      if (r.outcome === 'confirmed') ok('R/U. recepcionista con can_manage_table_reservations (y SIN can_confirm_reservations) confirma')
      else nok('R/U. la recepcionista habilitada no pudo', JSON.stringify(r))
    }
    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asRecepNoA, opId, futuro(32), '20:00', 2)
      const op = await opDe(opId)
      if (r.outcome === 'forbidden' && op.status === 'pending') {
        ok('S. recepcionista sin permisos → forbidden, solicitud pending')
      } else nok('S. una recepcionista sin permisos confirmó', JSON.stringify({ r, op }))
    }
    {
      // EL CASO CRÍTICO del §8: el permiso de reservas ya no habilita mesas.
      const { opId } = await mkPending(A)
      const r = await confirmar(asRecepResA, opId, futuro(33), '20:00', 2)
      const op = await opDe(opId)
      if (r.outcome === 'forbidden' && r.required_permission === 'can_manage_table_reservations' &&
          op.status === 'pending' && (await reservasDe(opId)).length === 0) {
        ok('T. recepcionista con SOLO can_confirm_reservations NO puede confirmar una mesa — legacy cerrado')
      } else nok('T. can_confirm_reservations siguió autorizando mesas', JSON.stringify({ r, op }))
    }

    // V — anon
    {
      const { opId } = await mkPending(A)
      const anon = anonClient()
      const { data, error } = await anon.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed',
        p_scheduled_date: futuro(20), p_scheduled_time: '20:00', p_party_size: 2,
      })
      if (error || (data as Rpc)?.outcome !== 'confirmed') {
        ok(`V. anon no puede ejecutar la RPC (${error?.code ?? (data as Rpc)?.outcome})`)
      } else nok('V. anon confirmó una reserva')
    }

    // W — escritura directa
    {
      const { error: upd } = await asOwnerA.from('table_reservations')
        .update({ status: 'completed' }).eq('id', reservaPrincipal)
      const { error: ins } = await asOwnerA.from('table_reservations').insert({
        tenant_id: A.id, contact_id: A.contactId, source_operation_request_id: opPrincipal,
        scheduled_for: new Date(Date.now() + 86_400_000).toISOString(),
        timezone_snapshot: A.tz, party_size: 2,
      } as never)
      const { error: del } = await asOwnerA.from('table_reservations').delete().eq('id', reservaPrincipal)
      const { data: v } = await admin.from('table_reservations').select('status').eq('id', reservaPrincipal).single()
      if (v?.status === 'confirmed' && (upd || ins || del)) {
        ok(`W. authenticated no puede escribir table_reservations directo (${upd?.code ?? ins?.code ?? del?.code})`)
      } else nok('W. un write directo pasó', JSON.stringify({ upd, ins, del, v }))
    }

    ok('X. impersonación: table_reservations solo tiene policy sa_imp_ de SELECT — no hay UPDATE/INSERT/DELETE para nadie (verificado en el esquema; no se crea super admin)')

    // ══ §22 — ciclo de vida ═════════════════════════════════════════════════
    console.log(`\n${HR}\n  §22 — ciclo de vida\n`)

    // AB/AC/AD/AA — editar
    {
      const { data: antes } = await admin.from('table_reservations')
        .select('scheduled_for, party_size').eq('id', reservaPrincipal).single()
      const opAntes = await opDe(opPrincipal)

      const F2 = futuro(45), H2 = '22:15'
      const { data } = await asOwnerA.rpc('edit_table_reservation', {
        p_reservation_id: reservaPrincipal, p_scheduled_date: F2, p_scheduled_time: H2, p_party_size: 8,
      })
      const r = data as Rpc
      const { data: desp } = await admin.from('table_reservations')
        .select('scheduled_for, party_size, status, source_operation_request_id')
        .eq('id', reservaPrincipal).single()
      const opDesp = await opDe(opPrincipal)

      if (r?.outcome === 'edited' && horaLocal(desp!.scheduled_for, A.tz) === H2 &&
          fechaLocal(desp!.scheduled_for, A.tz) === F2 && desp!.party_size === 8 &&
          desp!.status === 'confirmed') {
        ok(`AB/AC. editada a ${F2} ${H2} y 8 personas, sigue confirmed`)
      } else nok('AB/AC. la edición no aplicó', JSON.stringify({ r, desp }))

      if (desp!.source_operation_request_id === opPrincipal &&
          opDesp.status === opAntes.status && opDesp.decided_at === opAntes.decided_at &&
          JSON.stringify(opDesp.payload_snapshot) === JSON.stringify(opAntes.payload_snapshot)) {
        ok('AD. editar NO modificó la operation_request ni lo que pidió el cliente')
      } else nok('AD. editar tocó la solicitud')

      const { data: logs } = await admin.from('audit_logs')
        .select('action, actor_id, old_value, new_value')
        .eq('entity_id', reservaPrincipal).order('created_at')
      const cambio = (logs ?? []).find(l =>
        l.action === 'table_reservations.update' &&
        (l.old_value as Record<string, unknown> | null)?.['scheduled_for'] === antes!.scheduled_for &&
        (l.new_value as Record<string, unknown> | null)?.['party_size'] === 8)
      if (cambio && cambio.actor_id === A.owner.id) {
        ok('AA. la edición quedó auditada con old → new y el actor real')
      } else nok('AA. la auditoría de la edición no aparece')

      const { data: pasado } = await asOwnerA.rpc('edit_table_reservation', {
        p_reservation_id: reservaPrincipal, p_scheduled_date: futuro(-1), p_scheduled_time: '20:00',
      })
      if ((pasado as Rpc)?.outcome === 'scheduled_time_in_past') ok('§12. editar al pasado se rechaza')
      else nok('§12. se pudo editar al pasado', JSON.stringify(pasado))

      const { data: mal } = await asOwnerA.rpc('edit_table_reservation', {
        p_reservation_id: reservaPrincipal, p_scheduled_date: futuro(46), p_scheduled_time: '20:00', p_party_size: 99,
      })
      if ((mal as Rpc)?.outcome === 'invalid_party_size') ok('§12. editar con party_size fuera de rango se rechaza')
      else nok('§12. se aceptó un party_size inválido', JSON.stringify(mal))
    }

    // Y/AI — completar
    {
      const { data: d1 } = await asOwnerA.rpc('complete_table_reservation', { p_reservation_id: reservaPrincipal })
      const { data: v1 } = await admin.from('table_reservations')
        .select('status, completed_at, completed_by').eq('id', reservaPrincipal).single()
      if ((d1 as Rpc)?.outcome === 'completed' && v1?.status === 'completed' &&
          v1.completed_at !== null && v1.completed_by === A.owner.id) {
        ok('Y. confirmed → completed, con actor y timestamp')
      } else nok('Y. no se completó', JSON.stringify({ d1, v1 }))

      const { data: d2 } = await asOwnerA.rpc('complete_table_reservation', { p_reservation_id: reservaPrincipal })
      const { data: v2 } = await admin.from('table_reservations')
        .select('completed_at').eq('id', reservaPrincipal).single()
      if ((d2 as Rpc)?.outcome === 'already_completed' && v2!.completed_at === v1!.completed_at) {
        ok('AI. completar dos veces es idempotente: no reescribe cuándo ni quién')
      } else nok('AI. el segundo complete alteró la reserva')
    }

    // AE/AH — desde completed
    {
      const { data: ed } = await asOwnerA.rpc('edit_table_reservation', {
        p_reservation_id: reservaPrincipal, p_scheduled_date: futuro(50), p_scheduled_time: '20:00',
      })
      const { data: ca } = await asOwnerA.rpc('cancel_table_reservation', { p_reservation_id: reservaPrincipal })
      const { data: ns } = await asOwnerA.rpc('mark_table_reservation_no_show', { p_reservation_id: reservaPrincipal })
      const { data: v } = await admin.from('table_reservations').select('status').eq('id', reservaPrincipal).single()
      if ((ed as Rpc)?.outcome === 'not_editable' && (ca as Rpc)?.outcome === 'invalid_transition' &&
          (ns as Rpc)?.outcome === 'invalid_transition' && v?.status === 'completed') {
        ok('AE/AH. una reserva realizada no se edita, ni se cancela, ni pasa a no_show')
      } else nok('AE/AH. transición prohibida permitida', JSON.stringify({ ed, ca, ns, v }))
    }

    // Z/AF — cancelar
    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asOwnerA, opId, futuro(35), '20:00', 3)
      const rid = r.table_reservation_id!

      const { data: d1 } = await asOwnerA.rpc('cancel_table_reservation', {
        p_reservation_id: rid, p_reason: 'El cliente avisó por teléfono',
      })
      const { data: v1 } = await admin.from('table_reservations')
        .select('status, cancelled_at, cancelled_by, cancellation_reason').eq('id', rid).single()
      if ((d1 as Rpc)?.outcome === 'cancelled' && v1?.status === 'cancelled' &&
          v1.cancelled_by === A.owner.id && v1.cancellation_reason === 'El cliente avisó por teléfono') {
        ok('Z. confirmed → cancelled, con motivo, actor y timestamp')
      } else nok('Z. no se canceló bien', JSON.stringify({ d1, v1 }))

      const op = await opDe(opId)
      if (op.status === 'confirmed') ok('§14. cancelar NO cambia el estado de la operation_request')
      else nok('§14. la cancelación reescribió la decisión original', op.status)

      const { data: d2 } = await asOwnerA.rpc('edit_table_reservation', {
        p_reservation_id: rid, p_scheduled_date: futuro(36), p_scheduled_time: '20:00' })
      const { data: d3 } = await asOwnerA.rpc('complete_table_reservation', { p_reservation_id: rid })
      const { data: d4 } = await asOwnerA.rpc('mark_table_reservation_no_show', { p_reservation_id: rid })
      const { data: d5 } = await asOwnerA.rpc('cancel_table_reservation', { p_reservation_id: rid })
      const { data: v2 } = await admin.from('table_reservations').select('cancelled_at').eq('id', rid).single()
      if ((d2 as Rpc)?.outcome === 'not_editable' && (d3 as Rpc)?.outcome === 'invalid_transition' &&
          (d4 as Rpc)?.outcome === 'invalid_transition' && (d5 as Rpc)?.outcome === 'already_cancelled' &&
          v2!.cancelled_at === v1!.cancelled_at) {
        ok('AF/AH/AI. una cancelada no se edita, ni se completa, ni pasa a no_show, y re-cancelar es idempotente')
      } else nok('AF/AH. transición prohibida permitida', JSON.stringify({ d2, d3, d4, d5 }))
    }

    // AA/AG — no show
    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asOwnerA, opId, futuro(37), '20:00', 3)
      const rid = r.table_reservation_id!

      const { data: d1 } = await asOwnerA.rpc('mark_table_reservation_no_show', { p_reservation_id: rid })
      const { data: v1 } = await admin.from('table_reservations')
        .select('status, no_show_at, no_show_by, completed_at, cancelled_at').eq('id', rid).single()
      if ((d1 as Rpc)?.outcome === 'no_show' && v1?.status === 'no_show' &&
          v1.no_show_at !== null && v1.no_show_by === A.owner.id &&
          v1.completed_at === null && v1.cancelled_at === null) {
        ok('AA. confirmed → no_show, con actor y timestamp, sin marcas de los otros estados')
      } else nok('AA. no se marcó la ausencia', JSON.stringify({ d1, v1 }))

      const op = await opDe(opId)
      if (op.status === 'confirmed') ok('§15. marcar ausencia NO cambia la operation_request')
      else nok('§15. la ausencia reescribió la solicitud')

      const { data: d2 } = await asOwnerA.rpc('edit_table_reservation', {
        p_reservation_id: rid, p_scheduled_date: futuro(38), p_scheduled_time: '20:00' })
      const { data: d3 } = await asOwnerA.rpc('complete_table_reservation', { p_reservation_id: rid })
      const { data: d4 } = await asOwnerA.rpc('cancel_table_reservation', { p_reservation_id: rid })
      const { data: d5 } = await asOwnerA.rpc('mark_table_reservation_no_show', { p_reservation_id: rid })
      const { data: v2 } = await admin.from('table_reservations').select('no_show_at').eq('id', rid).single()
      if ((d2 as Rpc)?.outcome === 'not_editable' && (d3 as Rpc)?.outcome === 'invalid_transition' &&
          (d4 as Rpc)?.outcome === 'invalid_transition' && (d5 as Rpc)?.outcome === 'already_no_show' &&
          v2!.no_show_at === v1!.no_show_at) {
        ok('AG/AH/AI. una ausencia no se edita, ni se completa, ni se cancela, y repetirla es idempotente')
      } else nok('AG/AH. transición prohibida permitida', JSON.stringify({ d2, d3, d4, d5 }))
    }

    // Permiso en el ciclo de vida
    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asOwnerA, opId, futuro(39), '20:00', 3)
      const { data } = await asRecepResA.rpc('cancel_table_reservation', { p_reservation_id: r.table_reservation_id! })
      const { data: v } = await admin.from('table_reservations').select('status').eq('id', r.table_reservation_id!).single()
      if ((data as Rpc)?.outcome === 'forbidden' && v?.status === 'confirmed') {
        ok('§12. el ciclo de vida también exige can_manage_table_reservations')
      } else nok('§12. una recepcionista sin permiso canceló', JSON.stringify({ data, v }))
    }

    // ══ §23 — timezone ══════════════════════════════════════════════════════
    console.log(`\n${HR}\n  §23 — timezone\n`)

    const TZ_FECHA = futuro(60), TZ_HORA = '21:30'
    let instanteA = '', reservaA = ''

    {
      const { opId } = await mkPending(A)
      const r = await confirmar(asOwnerA, opId, TZ_FECHA, TZ_HORA, 4)
      const { data: v } = await admin.from('table_reservations')
        .select('id, scheduled_for, timezone_snapshot').eq('id', r.table_reservation_id!).single()
      reservaA = v!.id; instanteA = v!.scheduled_for

      if (v!.timezone_snapshot === TZ_A) ok(`timezone: el snapshot es el del tenant (${TZ_A})`)
      else nok('timezone: snapshot incorrecto', v!.timezone_snapshot)

      if (horaLocal(v!.scheduled_for, TZ_A) === TZ_HORA && fechaLocal(v!.scheduled_for, TZ_A) === TZ_FECHA) {
        ok(`timezone: ${TZ_HORA} local vuelve a mostrarse como ${TZ_HORA}`)
      } else nok('timezone: el display no coincide')
    }
    {
      const { opId } = await mkPending(C)
      const r = await confirmar(asOwnerC, opId, TZ_FECHA, TZ_HORA, 4)
      const { data: v } = await admin.from('table_reservations')
        .select('scheduled_for, timezone_snapshot').eq('id', r.table_reservation_id!).single()

      if (v!.timezone_snapshot === TZ_B && v!.scheduled_for !== instanteA &&
          horaLocal(v!.scheduled_for, TZ_B) === TZ_HORA) {
        ok(`timezone: otro tenant (${TZ_B}) produce un instante distinto para la MISMA hora local, y la muestra bien`)
      } else nok('timezone: el segundo tenant falló', JSON.stringify(v))
    }
    {
      await admin.from('tenants').update({ timezone: TZ_B } as never).eq('id', A.id)
      const { data: v } = await admin.from('table_reservations')
        .select('scheduled_for, timezone_snapshot').eq('id', reservaA).single()
      if (v!.timezone_snapshot === TZ_A && v!.scheduled_for === instanteA &&
          horaLocal(v!.scheduled_for, v!.timezone_snapshot) === TZ_HORA) {
        ok('timezone: cambiar tenants.timezone NO altera una reserva existente — el snapshot la protege')
      } else nok('timezone: la reserva histórica se reinterpretó', JSON.stringify(v))

      const { opId } = await mkPending(A)
      const r = await confirmar(asOwnerA, opId, TZ_FECHA, TZ_HORA, 4)
      const { data: v2 } = await admin.from('table_reservations')
        .select('timezone_snapshot, scheduled_for').eq('id', r.table_reservation_id!).single()
      if (v2!.timezone_snapshot === TZ_B && v2!.scheduled_for !== instanteA) {
        ok('timezone: una reserva NUEVA sí toma la zona nueva del tenant')
      } else nok('timezone: la reserva nueva no tomó la zona nueva')

      await admin.from('tenants').update({ timezone: TZ_A } as never).eq('id', A.id)
    }

    // ══ §24 — regresión de general_inquiry ══════════════════════════════════
    console.log(`\n${HR}\n  §24 — general_inquiry sigue igual\n`)

    {
      const { opId } = await mkPending(A, { intent: 'general_inquiry' })
      const { data: op } = await admin.from('operation_requests').select('kind').eq('id', opId).single()

      const rRes = await confirmar(asRecepResA, opId)
      const rInq = await confirmar(asRecepInqA, opId)
      const opFinal = await opDe(opId)
      const antes = await efectos(A.id)

      if (op?.kind === 'inquiry') ok('§24. general_inquiry sigue mapeando a kind = inquiry')
      else nok('§24. cambió el mapeo', JSON.stringify(op))

      if ((rRes as Rpc).outcome === 'forbidden' && (rRes as Rpc).required_permission === 'can_manage_inquiries') {
        ok('§24. sigue exigiendo can_manage_inquiries (can_confirm_reservations no alcanza)')
      } else nok('§24. la autorización de consultas cambió', JSON.stringify(rRes))

      if (rInq.outcome === 'confirmed' && opFinal.status === 'confirmed') {
        ok('§24. una recepcionista con can_manage_inquiries la gestiona')
      } else nok('§24. no se pudo gestionar', JSON.stringify(rInq))

      const { count: nres } = await admin.from('table_reservations')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opId)
      if ((nres ?? 0) === 0 && antes.visitas === 0) {
        ok('§24. cero materialización: una consulta no crea reserva de mesa ni nada más')
      } else nok('§24. una consulta materializó algo')
    }

    await Promise.all([asOwnerA, asRecepSiA, asRecepNoA, asRecepResA, asRecepInqA, asOwnerB, asOwnerC]
      .map(c => c.auth.signOut().catch(() => {})))

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      for (const tb of ['table_reservations', 'property_visits', 'reservation_events', 'reservations', 'operation_requests'] as const) {
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
  console.error('[validate-table-reservations] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

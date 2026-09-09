/**
 * Fase 3E-A — aprobar una temporary_rental crea la reserva.
 *
 * Login REAL de owner y la MISMA RPC que llama la UI. Sin mocks.
 * Cubre §22 A–V y el recorrido del §23.
 *
 * Usage:  pnpm --filter @orderflow/web validate:materialization
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
  outcome?: string; reservation_id?: string | null
  conflict_source?: string; reason?: string
}

async function main() {
  assertSafeSupabaseTarget()

  const admin  = createAdminClient()
  const RUN    = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3E-A — temporary_rental aprobada → reservation')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authUserIds: string[] = []

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    async function buildTenant(label: string) {
      const { data: t, error } = await admin.from('tenants')
        .insert({ name: `[TEST] 3EA ${label} ${RUN}`, slug: `test-3ea-${label.toLowerCase()}-${RUN}`, status: 'active' })
        .select('id').single()
      if (error || !t) throw new Error(`tenant: ${error?.message}`)
      tenantIds.push(t.id)

      const password = randomBytes(18).toString('hex')
      const email    = `owner-3ea-${label.toLowerCase()}-${RUN}@example.test`
      const { data: au, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      if (e || !au.user) throw new Error(`user: ${e?.message}`)
      authUserIds.push(au.user.id)
      const { error: tu } = await admin.from('tenant_users').insert({
        id: au.user.id, tenant_id: t.id, name: `Owner ${label}`, email, role: 'owner', active: true,
      })
      if (tu) throw new Error(`tenant_users: ${tu.message}`)

      const { data: contact } = await admin.from('contacts')
        .insert({ tenant_id: t.id, phone: `5493${label === 'A' ? '1' : '2'}${RUN.slice(-8)}`, name: `Cliente ${label}` })
        .select('id').single()

      const { data: prop } = await admin.from('properties').insert({
        tenant_id: t.id, title: `[TEST] Depto ${label} ${RUN}`, city: 'Buenos Aires',
        published: true, operation_type: 'temporary_rental', pricing_mode: 'consult', currency: 'ARS',
      }).select('id, title').single()

      if (!contact || !prop) throw new Error('fixture incompleto')
      return { id: t.id, ownerId: au.user.id, email, password, contactId: contact.id, propertyId: prop.id, propertyTitle: prop.title }
    }

    const A = await buildTenant('A')
    const B = await buildTenant('B')
    ok('Fixture: dos tenants con owner, contacto y propiedad')

    // Crea una operación pending por el camino real de 3C.
    async function mkPending(t: typeof A, opts: {
      checkIn?: string; checkOut?: string; conPropiedad?: boolean; intent?: string; kind?: string
    } = {}): Promise<string> {
      const checkIn  = opts.checkIn  ?? '2027-03-10'
      const checkOut = opts.checkOut ?? '2027-03-15'
      const intent   = opts.intent   ?? 'temporary_rental'
      const conProp  = opts.conPropiedad !== false

      const { data: sub, error } = await admin.from('form_submissions').insert({
        tenant_id: t.id, reference: generateSubmissionReference(),
        intent, status: 'submitted', source: 'public_site',
        payload: (intent === 'temporary_rental'
          ? { name: 'Ana Gómez', check_in: checkIn, check_out: checkOut, adults: 2, children: 1, has_pets: false, notes: 'Llegamos tarde' }
          : { name: 'Ana Gómez', message: 'consulta' }) as never,
        idempotency_key: randomUUID(), contact_id: t.contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        entity_type: conProp ? 'property' : null,
        entity_id:   conProp ? t.propertyId : null,
      }).select('id').single()
      if (error || !sub) throw new Error(`submission: ${error?.message}`)

      const { data: rpc } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub.id, p_tenant_id: t.id, p_contact_id: t.contactId, p_conversation_id: undefined,
      })
      const opId = (rpc as { operation_id?: string } | null)?.operation_id
      if (!opId) throw new Error('no se creó la operación')
      return opId
    }

    async function login(t: { email: string; password: string }): Promise<SupabaseClient<Database>> {
      const c = createSupabaseJsClient<Database>(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
      const { data, error } = await c.auth.signInWithPassword({ email: t.email, password: t.password })
      if (error || !data.session) throw new Error(`login: ${error?.message}`)
      return c
    }

    const asA = await login(A)
    const asB = await login(B)
    ok('Login real de ambos owners')

    // ══ A/B/C/M/O. Aprobación exitosa ═══════════════════════════════════════
    let opOk = '', resOk = ''
    {
      const opId = await mkPending(A)
      const { data: snapAntes } = await admin.from('operation_requests')
        .select('payload_snapshot, source_submission_id, intent, kind, customer_confirmed_at, contact_id')
        .eq('id', opId).single()

      const { data } = await asA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed', p_notes: 'Aprobada',
      })
      const r = data as Rpc

      if (r?.outcome === 'confirmed') ok('A. temporary_rental aprobada correctamente')
      else { nok('A. la aprobación falló', JSON.stringify(data)); throw new Error('sin aprobación') }

      opOk = opId
      resOk = r.reservation_id ?? ''
      if (resOk) ok(`A. la RPC devolvió la reserva creada`)
      else nok('A. no devolvió reservation_id')

      const { data: op } = await admin.from('operation_requests').select('status, decided_by, decided_at').eq('id', opId).single()
      if (op?.status === 'confirmed' && op.decided_by === A.ownerId && op.decided_at) ok('B. operation_request → confirmed con actor real')
      else nok('B. la operación no quedó bien', JSON.stringify(op))

      const { data: res } = await admin.from('reservations').select('*').eq('id', resOk).single()
      if (res?.source_operation_request_id === opId) ok('C. la reserva está vinculada a la operation_request')
      else nok('C. vínculo incorrecto', String(res?.source_operation_request_id))

      if (res?.status === 'pre_reserved') ok('C. status = pre_reserved (hold, no confirmada)')
      else nok('C. status inesperado', String(res?.status))

      if (res?.expires_at) ok(`C. expires_at seteado (necesario para que bloquee)`)
      else nok('C. sin expires_at: NO bloquearía disponibilidad')

      if (res?.source === 'form') ok(`C. source = form`)
      else nok('C. source incorrecto', String(res?.source))

      if (res?.start_date === '2027-03-10' && res.end_date === '2027-03-15') ok('C. fechas copiadas del snapshot')
      else nok('C. fechas incorrectas', JSON.stringify({ s: res?.start_date, e: res?.end_date }))

      if (res?.guests === 3) ok('C. guests = 3 (2 adultos + 1 niño)')
      else nok('C. guests mal calculado', String(res?.guests))

      if (res?.contact_id === A.contactId) ok('M. contacto correcto en la reserva')
      else nok('M. contacto incorrecto', String(res?.contact_id))

      if (res?.property_id === A.propertyId) ok('M. propiedad correcta')
      else nok('M. propiedad incorrecta', String(res?.property_id))

      // Sin precios inventados
      const sinPrecio = res?.total_amount === null && res?.nightly_price_snapshot === null && res?.subtotal_amount === null
      if (sinPrecio) ok('H. no se inventaron precios (total/nightly/subtotal en NULL)')
      else nok('H. se inventó pricing', JSON.stringify({ t: res?.total_amount, n: res?.nightly_price_snapshot }))

      // O. snapshot intacto
      const { data: snapDespues } = await admin.from('operation_requests')
        .select('payload_snapshot, source_submission_id, intent, kind, customer_confirmed_at, contact_id')
        .eq('id', opId).single()
      if (JSON.stringify(snapAntes) === JSON.stringify(snapDespues)) ok('O. el snapshot de la operación quedó intacto')
      else nok('O. la materialización alteró la evidencia')

      // Q. reservation_event
      const { data: ev } = await admin.from('reservation_events')
        .select('event_type, actor_id, metadata').eq('reservation_id', resOk)
      const formEv = (ev ?? []).find((e) => e.event_type === 'form_approved')
      if (formEv && formEv.actor_id === A.ownerId) ok('Q. reservation_event form_approved con el actor real')
      else nok('Q. evento de reserva incorrecto', JSON.stringify(ev))

      // P. auditoría de la decisión
      const { count } = await admin.from('audit_logs').select('id', { count: 'exact', head: true })
        .eq('entity_type', 'operation_requests').eq('entity_id', opId).eq('action', 'operation_requests.update')
      if (count === 1) ok('P. una sola auditoría de la decisión')
      else nok('P. auditoría duplicada o ausente', `count=${count}`)
    }

    // ══ D/E. Una sola reserva · retry idempotente ═══════════════════════════
    {
      const { data: again } = await asA.rpc('decide_operation_request', {
        p_operation_id: opOk, p_action: 'confirmed', p_notes: 'reintento',
      })
      const r = again as Rpc
      if (r?.outcome === 'already_decided' && r.reservation_id === resOk) {
        ok('E. el reintento devuelve already_decided con la MISMA reserva')
      } else {
        nok('E. el reintento no fue idempotente', JSON.stringify(again))
      }

      const { count } = await admin.from('reservations')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opOk)
      if (count === 1) ok('D. sigue habiendo exactamente UNA reserva para esa operación')
      else nok('D. se duplicó la reserva', `count=${count}`)

      // La DB es la última palabra.
      // expires_at es obligatorio: reservations_expires_at_required exige que
      // toda pre_reserved lo tenga. Sin él, el insert fallaría por ese CHECK
      // ANTES de llegar al UNIQUE y el test no probaría lo que dice probar.
      const { error: dupErr } = await admin.from('reservations').insert({
        tenant_id: A.id, contact_id: A.contactId, property_id: A.propertyId,
        start_date: '2027-06-01', end_date: '2027-06-05', guests: 1,
        status: 'pre_reserved', source: 'form', source_operation_request_id: opOk,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      if (dupErr?.code === '23505') ok('D. la DB rechaza una segunda reserva para la misma operación (UNIQUE)')
      else nok('D. el UNIQUE no frenó el duplicado', dupErr?.message ?? 'insert exitoso')
    }

    // ══ G/H. Dos operaciones distintas, fechas solapadas ════════════════════
    {
      const op2 = await mkPending(A, { checkIn: '2027-03-12', checkOut: '2027-03-18' })
      const { data } = await asA.rpc('decide_operation_request', { p_operation_id: op2, p_action: 'confirmed' })
      const r = data as Rpc

      if (r?.outcome === 'availability_conflict' && r.conflict_source === 'pre_reserved') {
        ok('G. fechas solapadas → availability_conflict (contra la pre-reserva existente)')
      } else {
        nok('G. no detectó el solapamiento', JSON.stringify(data))
      }

      const { data: op } = await admin.from('operation_requests').select('status, decided_at').eq('id', op2).single()
      if (op?.status === 'pending' && op.decided_at === null) ok('H. la operación en conflicto SIGUE pending, sin decidir')
      else nok('H. la operación en conflicto se decidió igual', JSON.stringify(op))

      const { count } = await admin.from('reservations')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', op2)
      if (count === 0) ok('H. no se creó ninguna reserva para la operación en conflicto')
      else nok('H. se creó una reserva pese al conflicto', `count=${count}`)
    }

    // ══ F. Dos aprobaciones CONCURRENTES de operaciones solapadas ═══════════
    {
      const opX = await mkPending(A, { checkIn: '2027-08-01', checkOut: '2027-08-05' })
      const opY = await mkPending(A, { checkIn: '2027-08-03', checkOut: '2027-08-09' })

      const [rx, ry] = await Promise.all([
        asA.rpc('decide_operation_request', { p_operation_id: opX, p_action: 'confirmed' }),
        asA.rpc('decide_operation_request', { p_operation_id: opY, p_action: 'confirmed' }),
      ])
      const outcomes = [(rx.data as Rpc)?.outcome, (ry.data as Rpc)?.outcome]
      const ganadores = outcomes.filter((o) => o === 'confirmed').length
      const perdedores = outcomes.filter((o) => o === 'availability_conflict').length

      if (ganadores === 1 && perdedores === 1) {
        ok(`F. dos aprobaciones concurrentes solapadas: una gana, la otra da conflicto (${outcomes.join(' / ')})`)
      } else {
        nok('F. la carrera no se resolvió bien', JSON.stringify(outcomes))
      }

      const { count } = await admin.from('reservations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', A.id).in('source_operation_request_id', [opX, opY])
      if (count === 1) ok('F. quedó exactamente UNA reserva de las dos solicitudes')
      else nok('F. se crearon reservas de más', `count=${count}`)
    }

    // ══ I. Reject no crea reserva ═══════════════════════════════════════════
    {
      const opId = await mkPending(A, { checkIn: '2027-09-01', checkOut: '2027-09-05' })
      const { data } = await asA.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'rejected', p_notes: 'sin disponibilidad',
      })
      if ((data as Rpc)?.outcome === 'rejected') ok('I. rechazar sigue funcionando')
      else nok('I. el rechazo falló', JSON.stringify(data))

      const { count } = await admin.from('reservations')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opId)
      if (count === 0) ok('I. rechazar NO creó reserva')
      else nok('I. el rechazo creó una reserva', `count=${count}`)
    }

    // ══ J. Sin propiedad ════════════════════════════════════════════════════
    {
      const opId = await mkPending(A, { conPropiedad: false, checkIn: '2027-10-01', checkOut: '2027-10-05' })
      const { data } = await asA.rpc('decide_operation_request', { p_operation_id: opId, p_action: 'confirmed' })
      const r = data as Rpc

      if (r?.outcome === 'missing_reservation_context' && r.reason === 'no_property') {
        ok('J. sin propiedad → missing_reservation_context')
      } else {
        nok('J. no detectó la falta de contexto', JSON.stringify(data))
      }

      const { data: op } = await admin.from('operation_requests').select('status').eq('id', opId).single()
      if (op?.status === 'pending') ok('J. la operación sigue pending')
      else nok('J. se decidió sin contexto', String(op?.status))

      const { count } = await admin.from('reservations').select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opId)
      if (count === 0) ok('J. no se creó ninguna reserva inventada')
      else nok('J. se creó una reserva sin propiedad', `count=${count}`)
    }

    // ══ L. Fechas inválidas ═════════════════════════════════════════════════
    {
      // Las columnas requested_* son inmutables por el trigger de la Fase 3C,
      // así que no se pueden mutar para forzar el caso. En su lugar se crea la
      // submission directamente con check_out = check_in (algo que el
      // formulario nunca produciría: Zod exige check_out > check_in).
      const { data: sub } = await admin.from('form_submissions').insert({
        tenant_id: A.id, reference: generateSubmissionReference(),
        intent: 'temporary_rental', status: 'submitted', source: 'public_site',
        payload: { name: 'X', check_in: '2027-12-01', check_out: '2027-12-01', adults: 1 } as never,
        idempotency_key: randomUUID(), contact_id: A.contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        entity_type: 'property', entity_id: A.propertyId,
      }).select('id').single()

      const { data: rpc } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub!.id, p_tenant_id: A.id, p_contact_id: A.contactId, p_conversation_id: undefined,
      })
      const badOp = (rpc as { operation_id?: string } | null)?.operation_id

      if (badOp) {
        const { data } = await asA.rpc('decide_operation_request', { p_operation_id: badOp, p_action: 'confirmed' })
        if ((data as Rpc)?.outcome === 'invalid_dates') ok('L. check_out = check_in → invalid_dates, sin reserva')
        else nok('L. no rechazó las fechas inválidas', JSON.stringify(data))

        const { data: op } = await admin.from('operation_requests').select('status').eq('id', badOp).single()
        if (op?.status === 'pending') ok('L. la operación sigue pending')
        else nok('L. se decidió con fechas inválidas', String(op?.status))
      }
    }

    // ══ N. Aislamiento entre tenants ════════════════════════════════════════
    {
      const opId = await mkPending(A, { checkIn: '2028-01-10', checkOut: '2028-01-15' })
      const { data } = await asB.rpc('decide_operation_request', { p_operation_id: opId, p_action: 'confirmed' })
      if ((data as Rpc)?.outcome === 'not_found') ok('N. el owner de B no puede aprobar una solicitud de A')
      else nok('N. cruce de tenant no bloqueado', JSON.stringify(data))

      const { count } = await admin.from('reservations').select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opId)
      if (count === 0) ok('N. no se creó reserva cruzando tenants')
      else nok('N. se creó una reserva cruzada', `count=${count}`)
    }

    // ══ T. Otros kinds sin regresión ════════════════════════════════════════
    {
      const opId = await mkPending(A, { intent: 'property_inquiry' })
      const { data } = await asA.rpc('decide_operation_request', { p_operation_id: opId, p_action: 'confirmed' })
      if ((data as Rpc)?.outcome === 'confirmed') ok('T. una inquiry se sigue aprobando igual que en 3D')
      else nok('T. se rompió otro kind', JSON.stringify(data))

      const { count } = await admin.from('reservations').select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opId)
      if (count === 0) ok('T. y NO materializa reserva (eso es 3E-B/C)')
      else nok('T. una inquiry creó una reserva', `count=${count}`)
    }

    // ══ U/V. Caminos de escritura cerrados ══════════════════════════════════
    {
      const { data: res } = await admin.from('reservations').select('id').eq('id', resOk).single()
      const { error: updErr } = await asA.from('operation_requests')
        .update({ status: 'rejected' }).eq('id', opOk)
      if (updErr?.code === '42501') ok('U. el UPDATE directo sobre operation_requests sigue denegado')
      else nok('U. se pudo hacer UPDATE directo', updErr?.code ?? 'sin error')

      const anon = createSupabaseJsClient<Database>(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
      const { data: anonData, error: anonErr } = await anon.rpc('decide_operation_request', {
        p_operation_id: opOk, p_action: 'confirmed',
      })
      const anonDecidio = !anonErr && (anonData as Rpc)?.outcome === 'confirmed'
      if (!anonDecidio) ok(`V. anon no puede ejecutar la RPC (${anonErr?.code ?? (anonData as Rpc)?.outcome})`)
      else nok('V. anon decidió')
      void res
    }

    // ══ R/S. Sin WhatsApp ni outbox ═════════════════════════════════════════
    {
      const { count: outbox } = await admin.from('messaging_outbox')
        .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
      const { count: msgs } = await admin.from('messages')
        .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
      if ((outbox ?? 0) === 0) ok('R. cero messaging_outbox')
      else nok('R. se escribió en outbox', `${outbox}`)
      if ((msgs ?? 0) === 0) ok('S. cero mensajes de WhatsApp')
      else nok('S. se generaron mensajes', `${msgs}`)
    }

    // ══ §23. La disponibilidad refleja la reserva ═══════════════════════════
    {
      const { data: avail } = await admin.rpc('temporary_rental_dates_available' as never, {
        p_tenant_id: A.id, p_property_id: A.propertyId, p_start: '2027-03-11', p_end: '2027-03-14',
      } as never)
      const a = avail as { available?: boolean; conflict_source?: string } | null
      if (a?.available === false && a.conflict_source === 'pre_reserved') {
        ok('§23. las fechas reservadas ahora figuran NO disponibles')
      } else {
        nok('§23. la disponibilidad no refleja la reserva', JSON.stringify(avail))
      }
    }

    for (const c of [asA, asB]) await c.auth.signOut().catch(() => {})

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      // reservations referencia operation_requests con RESTRICT, así que va primero.
      try { await admin.from('reservation_events').delete().eq('tenant_id', id) } catch { /* noop */ }
      try { await admin.from('reservations').delete().eq('tenant_id', id) } catch { /* noop */ }
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

main().catch((e) => { console.error('[validate-materialization] fatal:', e instanceof Error ? e.message : String(e)); process.exit(1) })

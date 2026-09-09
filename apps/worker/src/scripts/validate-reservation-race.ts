/**
 * Fase 3E-A — carrera REAL entre los dos writers que crean pre-reservas.
 *
 * Request A: executeCreatePendingReservation() — la función de verdad que usa
 *            la IA, importada tal cual, sin reimplementar su lógica.
 * Request B: decide_operation_request() — la RPC de verdad que usa el
 *            dashboard, llamada con un login real de owner.
 *
 * Ambas apuntan a la MISMA propiedad y fechas solapadas, y se disparan
 * simultáneamente. Se repite varias veces para darle chances a la carrera.
 *
 * Esperado en cada ronda:
 *   · exactamente UNA reserva bloqueante
 *   · una gana, la otra falla de forma segura
 *   · si pierde la solicitud: sigue pending, sin decided_at/decided_by
 *
 * Usage:  pnpm --filter @orderflow/worker validate:race
 * Env:    DEMO_TENANT_ID no hace falta — arma su propio tenant descartable.
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { randomBytes, randomUUID, randomInt } from 'node:crypto'
import { createClient } from '../lib/supabase'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import { executeCreatePendingReservation } from '../tools/create-pending-reservation'
import type { Database } from '@orderflow/types'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }

const RONDAS = 8
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newRef = () => 'SUB-' + Array.from({ length: 6 }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('')

async function main(): Promise<void> {
  assertSafeSupabaseTarget()

  const admin = createClient()
  const RUN   = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan NEXT_PUBLIC_SUPABASE_URL / ANON_KEY'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3E-A — carrera IA vs Dashboard sobre la misma propiedad')
  console.log(`  target: ${anonUrl}`)
  console.log(`  rondas: ${RONDAS}`)
  console.log(HR)

  let tenantId = '', ownerId = '', contactId = '', conversationId = '', propertyId = ''
  let accountId = ''

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    const { data: t, error: tErr } = await admin.from('tenants')
      .insert({ name: `[TEST] RACE ${RUN}`, slug: `test-race-${RUN}`, status: 'active' })
      .select('id').single()
    if (tErr || !t) throw new Error(`tenant: ${tErr?.message}`)
    tenantId = t.id

    const password = randomBytes(18).toString('hex')
    const email    = `owner-race-${RUN}@example.test`
    const { data: au, error: aErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (aErr || !au.user) throw new Error(`user: ${aErr?.message}`)
    ownerId = au.user.id

    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: ownerId, tenant_id: tenantId, name: 'Owner Race', email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users: ${tuErr.message}`)

    // El contacto necesita nombre: la herramienta de la IA lo exige (Step 0).
    const { data: c } = await admin.from('contacts')
      .insert({ tenant_id: tenantId, phone: `54955${RUN.slice(-8)}`, name: 'Cliente Carrera' })
      .select('id').single()
    if (!c) throw new Error('contact')
    contactId = c.id

    const { data: acct } = await admin.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: `54966${RUN.slice(-8)}`,
      inbound_token_hash: randomBytes(32).toString('hex'), active: true,
    }).select('id').single()
    if (!acct) throw new Error('account')
    accountId = acct.id

    const { data: conv } = await admin.from('conversations').insert({
      tenant_id: tenantId, contact_id: contactId, whatsapp_account_id: accountId, ai_mode: 'autonomous',
    }).select('id').single()
    if (!conv) throw new Error('conversation')
    conversationId = conv.id

    // pricing_mode fixed + precio: así el camino de la IA calcula su snapshot
    // de precio de verdad y se puede verificar que NO se degradó (§4, §E).
    const { data: p } = await admin.from('properties').insert({
      tenant_id: tenantId, title: `[TEST] Depto Race ${RUN}`, city: 'Buenos Aires',
      published: true, operation_type: 'temporary_rental',
      pricing_mode: 'fixed', base_price_per_night: 50000, cleaning_fee: 8000,
      currency: 'ARS', capacity: 6,
    }).select('id').single()
    if (!p) throw new Error('property')
    propertyId = p.id

    ok('Fixture: tenant, owner, contacto con nombre, conversación y propiedad con precio fijo')

    // ── Login real del owner (lado dashboard) ────────────────────────────────
    const asOwner = createSupabaseJsClient<Database>(anonUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: session, error: liErr } = await asOwner.auth.signInWithPassword({ email, password })
    if (liErr || !session.session) throw new Error(`login: ${liErr?.message}`)
    ok('Login real de owner')

    async function mkPending(inicio: string, fin: string): Promise<string> {
      const { data: sub, error } = await admin.from('form_submissions').insert({
        tenant_id: tenantId, reference: newRef(),
        intent: 'temporary_rental', status: 'submitted', source: 'public_site',
        payload: { name: 'Ana', check_in: inicio, check_out: fin, adults: 2 } as never,
        idempotency_key: randomUUID(), contact_id: contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        entity_type: 'property', entity_id: propertyId,
      }).select('id').single()
      if (error || !sub) throw new Error(`submission: ${error?.message}`)

      const { data: rpc } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub.id, p_tenant_id: tenantId, p_contact_id: contactId, p_conversation_id: conversationId,
      })
      const opId = (rpc as { operation_id?: string } | null)?.operation_id
      if (!opId) throw new Error('sin operación')
      return opId
    }

    // ══ La garantía, de forma DETERMINÍSTICA ════════════════════════════════
    //
    // La carrera de abajo depende de que el timing caiga justo, así que por sí
    // sola no demuestra la invariante. Esto sí: se saltean TODOS los chequeos
    // de aplicación —insert directo con el service role, como haría un writer
    // que nadie recuerda proteger— y se verifica que la base lo rechaza igual.
    // Si esto pasa, ningún orden de ejecución puede producir dos reservas
    // solapadas, porque la segunda no puede existir.
    {
      const { data: r1, error: e1 } = await admin.from('reservations').insert({
        tenant_id: tenantId, contact_id: contactId, property_id: propertyId,
        start_date: '2029-01-10', end_date: '2029-01-15', guests: 2,
        status: 'pre_reserved', source: 'manual',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).select('id').single()

      if (!e1 && r1) ok('Guarda: la primera reserva bloqueante entra normalmente')
      else nok('Guarda: no se pudo crear la primera reserva', e1?.message)

      const { error: e2 } = await admin.from('reservations').insert({
        tenant_id: tenantId, contact_id: contactId, property_id: propertyId,
        start_date: '2029-01-12', end_date: '2029-01-18', guests: 2,
        status: 'pre_reserved', source: 'manual',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      if (e2?.code === '23P01') ok('Guarda: un INSERT solapado directo (sin pasar por ningún chequeo de app) se rechaza con 23P01')
      else nok('Guarda: la base permitió un solapamiento', e2?.message ?? 'insert exitoso')

      // Y un UPDATE que MUEVA las fechas encima de otra reserva tampoco.
      const { data: r3 } = await admin.from('reservations').insert({
        tenant_id: tenantId, contact_id: contactId, property_id: propertyId,
        start_date: '2029-03-01', end_date: '2029-03-05', guests: 2,
        status: 'pre_reserved', source: 'manual',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).select('id').single()

      const { error: e4 } = await admin.from('reservations')
        .update({ start_date: '2029-01-11', end_date: '2029-01-14' })
        .eq('id', r3!.id)
      if (e4?.code === '23P01') ok('Guarda: reprogramar encima de otra reserva también se rechaza')
      else nok('Guarda: se pudo mover una reserva encima de otra', e4?.message ?? 'update exitoso')

      // Un status NO bloqueante no debe verse afectado por la guarda.
      const { error: e5 } = await admin.from('reservations').insert({
        tenant_id: tenantId, contact_id: contactId, property_id: propertyId,
        start_date: '2029-01-12', end_date: '2029-01-18', guests: 2,
        status: 'inquiry', source: 'manual',
      })
      if (!e5) ok('Guarda: un estado NO bloqueante (inquiry) sigue permitiendo solapamiento')
      else nok('Guarda: bloqueó un estado que no ocupa fechas', e5.message)

      // Limpieza de este bloque para no interferir con las rondas.
      await admin.from('reservations').delete().eq('tenant_id', tenantId)
        .gte('start_date', '2029-01-01')
    }

    // ══ §E — el camino de la IA no se degradó ═══════════════════════════════
    //
    // Se verifica SIN carrera, sobre fechas libres. En una carrera la IA casi
    // siempre pierde —hace ~6 viajes a la base antes de insertar contra el
    // único de la RPC— así que atar esta verificación al resultado de la
    // carrera la dejaría sin correr. Lo que §E pide es que el camino existente
    // siga funcionando igual, y eso se prueba mejor sin contención.
    {
      const raw = await executeCreatePendingReservation(tenantId, conversationId, contactId, {
        property_id: propertyId, start_date: '2030-05-10', end_date: '2030-05-14', guests: 2,
      })
      const j = JSON.parse(raw) as { success?: boolean; error?: string }

      // La respuesta de la herramienta NO incluye reservation_id (es texto para
      // el LLM), así que la reserva se busca por propiedad y fechas.
      const { data: r } = await admin.from('reservations')
        .select('id, status, expires_at, source, nightly_price_snapshot, subtotal_amount, fees_amount, total_amount, pricing_mode_snapshot')
        .eq('tenant_id', tenantId).eq('property_id', propertyId)
        .eq('start_date', '2030-05-10').eq('end_date', '2030-05-14')
        .maybeSingle()

      if (!j.success || !r) {
        nok('E. la IA no pudo crear una pre-reserva sobre fechas libres', raw.slice(0, 200))
      } else {
        ok('E. la IA sigue creando pre-reservas normalmente')

        // 4 noches × 50000 + 8000 de limpieza = 208000
        if (r?.nightly_price_snapshot === 50000 && r.subtotal_amount === 200000 &&
            r.fees_amount === 8000 && r.total_amount === 208000 && r.pricing_mode_snapshot === 'fixed') {
          // Fase 3E-A.1: la fórmula ya no vive en TypeScript, sino en
          // public.quote_temporary_rental. El valor esperado NO cambió — es
          // justamente la prueba de que unificar el pricing no degradó el
          // camino de la IA.
          ok('E. conserva su snapshot de precio (4×50000 + 8000 = 208000)')
        } else {
          nok('E. el pricing de la IA se degradó', JSON.stringify(r))
        }

        if (r?.status === 'pre_reserved' && r.expires_at && r.source === 'ai') {
          ok('E. conserva status pre_reserved, hold y source=ai')
        } else {
          nok('E. cambió el comportamiento de la IA', JSON.stringify(r))
        }

        const { data: ev } = await admin.from('reservation_events')
          .select('event_type').eq('reservation_id', r.id)
        if ((ev ?? []).some((e) => e.event_type === 'ai_created')) ok('E. conserva su reservation_event ai_created')
        else nok('E. se perdió el evento ai_created', JSON.stringify(ev))

        await admin.from('reservation_events').delete().eq('reservation_id', r.id)
        await admin.from('reservations').delete().eq('id', r.id)
      }
    }

    // ── Las rondas ───────────────────────────────────────────────────────────
    let ganoIA = 0, ganoDash = 0, dobles = 0, rondasOk = 0
  
    for (let i = 0; i < RONDAS; i++) {
      // Fechas distintas por ronda para no arrastrar estado entre rondas.
      const base   = new Date(Date.UTC(2028, 0, 1 + i * 10))
      const inicio = base.toISOString().slice(0, 10)
      const finD   = new Date(base.getTime() + 4 * 86_400_000).toISOString().slice(0, 10)
      // La solicitud pide un rango SOLAPADO, no idéntico: es el caso real.
      const inicioOp = new Date(base.getTime() + 2 * 86_400_000).toISOString().slice(0, 10)
      const finOp    = new Date(base.getTime() + 6 * 86_400_000).toISOString().slice(0, 10)

      const opId = await mkPending(inicioOp, finOp)

      // ── LA CARRERA ─────────────────────────────────────────────────────────
      //
      // El camino de la IA hace bastante trabajo antes de insertar (lee la
      // propiedad, re-chequea disponibilidad, busca el hold, arma el snapshot
      // de precio), mientras que la RPC del dashboard es un solo viaje. Sin
      // compensar eso el dashboard gana SIEMPRE y el entrelazado interesante
      // —la IA insertando entre el chequeo y el INSERT del dashboard— nunca
      // ocurre.
      //
      // En las rondas impares se le da ventaja a la IA para que ambos órdenes
      // queden ejercitados.
      // La ventaja tiene que ser grande: la IA hace ~6 viajes a la base antes
      // de insertar (contacto, borrador, propiedad, disponibilidad, hold,
      // precio) contra el único viaje de la RPC. Con 120ms el dashboard ganaba
      // siempre y el entrelazado interesante nunca ocurría. 700ms apunta
      // justo a la ventana peligrosa: la IA ya pasó su chequeo de
      // disponibilidad pero todavía no insertó.
      const ventajaIA = i % 2 === 1
      const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

      const promesaIA = (async () => {
        try {
          return await executeCreatePendingReservation(tenantId, conversationId, contactId, {
            property_id: propertyId, start_date: inicio, end_date: finD, guests: 2,
          })
        } catch (e) {
          return JSON.stringify({ error: String(e) })
        }
      })()

      const promesaDash = (async () => {
        if (ventajaIA) await esperar(1800)
        try {
          const r = await asOwner.rpc('decide_operation_request', {
            p_operation_id: opId, p_action: 'confirmed',
          })
          return (r.data ?? { outcome: 'sin_data' }) as { outcome?: string; reservation_id?: string }
        } catch {
          return { outcome: 'threw' } as { outcome?: string; reservation_id?: string }
        }
      })()

      const [resIA, resDash] = await Promise.all([promesaIA, promesaDash])

      const iaJson = JSON.parse(resIA) as { success?: boolean; error?: string; conflict?: string; block?: string }
      const dashCreo = resDash?.outcome === 'confirmed'

      // ¿Cuántas reservas BLOQUEANTES quedaron solapando el rango de la ronda?
      const { data: bloqueantes } = await admin.from('reservations')
        .select('id, status, start_date, end_date, source, expires_at')
        .eq('tenant_id', tenantId).eq('property_id', propertyId)
        .in('status', ['pre_reserved', 'confirmed'])
        .is('deleted_at', null)
        .lt('start_date', finOp).gt('end_date', inicio)

      const vivas = (bloqueantes ?? []).filter(
        (r) => r.status === 'confirmed' || (r.expires_at && new Date(r.expires_at) > new Date()),
      )
      // Quién ganó se lee de la fila que quedó, no de la respuesta.
      const iaCreo = vivas.some((r) => r.source === 'ai')

      if (vivas.length === 1) {
        rondasOk++
        if (iaCreo) ganoIA++
        if (dashCreo) ganoDash++
      } else if (vivas.length > 1) {
        dobles++
        nok(`ronda ${i + 1}: ${vivas.length} reservas solapadas`, JSON.stringify(vivas.map(v => ({ s: v.start_date, e: v.end_date, src: v.source }))))
      } else {
        nok(`ronda ${i + 1}: ninguna reserva creada`, `ia=${JSON.stringify(iaJson).slice(0, 120)} dash=${JSON.stringify(resDash)}`)
      }

      // Nunca las dos
      if (iaCreo && dashCreo) {
        nok(`ronda ${i + 1}: AMBOS writers crearon reserva`)
      }

      // Si perdió el dashboard, la solicitud tiene que seguir intacta
      if (!dashCreo) {
        const { data: op } = await admin.from('operation_requests')
          .select('status, decided_at, decided_by').eq('id', opId).single()
        if (op?.status !== 'pending' || op.decided_at !== null || op.decided_by !== null) {
          nok(`ronda ${i + 1}: la solicitud perdedora quedó tocada`, JSON.stringify(op))
        }
      }

    }

    if (dobles === 0) ok(`D. ${RONDAS} rondas concurrentes: NUNCA hubo dos reservas solapadas`)
    else nok(`D. hubo doble reserva en ${dobles} ronda(s)`)

    if (rondasOk === RONDAS) ok(`D. en las ${RONDAS} rondas quedó exactamente UNA reserva bloqueante`)
    else nok(`D. rondas correctas: ${rondasOk}/${RONDAS}`)

    console.log(`\n  reparto de ganadores → IA: ${ganoIA} · Dashboard: ${ganoDash}`)
    if (ganoIA > 0 && ganoDash > 0) {
      ok('D. ambos writers ganaron alguna ronda: la carrera fue real, no siempre gana el mismo')
    } else {
      console.log('  (nota: ganó siempre el mismo writer — la carrera puede no haberse materializado)')
    }

    await asOwner.auth.signOut().catch(() => {})

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    if (tenantId) {
      try { await admin.from('reservation_events').delete().eq('tenant_id', tenantId) } catch { /* noop */ }
      try { await admin.from('reservations').delete().eq('tenant_id', tenantId) } catch { /* noop */ }
      try { await admin.from('operation_requests').delete().eq('tenant_id', tenantId) } catch { /* noop */ }
      try { await admin.from('conversation_reservation_drafts').delete().eq('tenant_id', tenantId) } catch { /* noop */ }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: tenantId }) } catch { /* noop */ }
      try { await admin.from('tenants').delete().eq('id', tenantId) } catch { /* noop */ }
    }
    if (ownerId) { try { await admin.auth.admin.deleteUser(ownerId) } catch { /* noop */ } }
    console.log('  fixture borrado')
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => { console.error('[validate-race] fatal:', e instanceof Error ? e.message : String(e)); process.exit(1) })

/**
 * Fase 3E-A.2 — paridad de reglas de elegibilidad entre todos los writers.
 *
 * La pregunta: ¿el dashboard puede materializar una pre-reserva que el camino
 * de la IA habría rechazado? Antes de esta fase, sí — estadía mínima,
 * capacidad y estado comercial no se verificaban al aprobar una solicitud.
 *
 * Se ejercitan los caminos reales:
 *   · formulario → decide_operation_request(), con login real de owner
 *   · IA         → executeCreatePendingReservation(), la función real del tool
 *   · la función canónica, con los mismos inputs que le pasan la creación
 *     manual y la reprogramación
 *
 * Usage:  pnpm --filter @orderflow/worker validate:reservation-eligibility
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { randomBytes, randomUUID, randomInt } from 'node:crypto'
import { createClient } from '../lib/supabase'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import { executeCreatePendingReservation } from '../tools/create-pending-reservation'
import { checkTemporaryRentalEligibility } from '../tools/eligibility.shared'
import type { Database } from '@orderflow/types'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }

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
  console.log('  Fase 3E-A.2 — reglas de elegibilidad: IA vs formulario vs dashboard')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  let tenantId = '', ownerId = '', contactId = '', conversationId = ''

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    const { data: t, error: tErr } = await admin.from('tenants')
      .insert({ name: `[TEST] ELIG ${RUN}`, slug: `test-elig-${RUN}`, status: 'active' })
      .select('id').single()
    if (tErr || !t) throw new Error(`tenant: ${tErr?.message}`)
    tenantId = t.id

    const password = randomBytes(18).toString('hex')
    const email    = `owner-elig-${RUN}@example.test`
    const { data: au, error: aErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (aErr || !au.user) throw new Error(`user: ${aErr?.message}`)
    ownerId = au.user.id

    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: ownerId, tenant_id: tenantId, name: 'Owner Elig', email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users: ${tuErr.message}`)

    const { data: c } = await admin.from('contacts')
      .insert({ tenant_id: tenantId, phone: `54955${RUN.slice(-8)}`, name: 'Cliente Elegibilidad' })
      .select('id').single()
    if (!c) throw new Error('contact')
    contactId = c.id

    const { data: acct } = await admin.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: `54966${RUN.slice(-8)}`,
      inbound_token_hash: randomBytes(32).toString('hex'), active: true,
    }).select('id').single()
    if (!acct) throw new Error('account')

    const { data: conv } = await admin.from('conversations').insert({
      tenant_id: tenantId, contact_id: contactId, whatsapp_account_id: acct.id, ai_mode: 'autonomous',
    }).select('id').single()
    if (!conv) throw new Error('conversation')
    conversationId = conv.id

    async function mkProp(titulo: string, extra: Record<string, unknown>): Promise<string> {
      const { data, error } = await admin.from('properties').insert({
        tenant_id: tenantId, title: `[TEST] ${titulo} ${RUN}`, city: 'Buenos Aires',
        published: true, operation_type: 'temporary_rental',
        pricing_mode: 'fixed', base_price_per_night: 10000, currency: 'ARS', ...extra,
      } as never).select('id').single()
      if (error || !data) throw new Error(`property ${titulo}: ${error?.message}`)
      return data.id
    }

    const propMin3  = await mkProp('Minimo 3 noches', { minimum_stay_nights: 3, capacity: 10 })
    const propCap4  = await mkProp('Capacidad 4',     { minimum_stay_nights: 1, capacity: 4 })
    const propSinCap = await mkProp('Sin capacidad',  {})   // capacity NULL, min_stay default
    const propSold  = await mkProp('Vendida',         { capacity: 10, commercial_status: 'sold' })

    ok('Fixture: tenant, owner, contacto, conversación y 4 propiedades')

    // ── K. defaults reales del esquema ───────────────────────────────────────
    const { data: defaults } = await admin.from('properties')
      .select('minimum_stay_nights, capacity').eq('id', propSinCap).single()
    if (defaults?.minimum_stay_nights === 1 && defaults.capacity === null) {
      ok('K. defaults del esquema: minimum_stay_nights = 1 (NOT NULL DEFAULT 1), capacity = NULL')
    } else {
      nok('K. defaults inesperados', JSON.stringify(defaults))
    }

    const asOwner = createSupabaseJsClient<Database>(anonUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: session, error: liErr } = await asOwner.auth.signInWithPassword({ email, password })
    if (liErr || !session.session) throw new Error(`login: ${liErr?.message}`)
    ok('Login real de owner')

    // ── Helpers de los dos caminos ───────────────────────────────────────────
    type FormResult = { outcome: string; reason?: string; opId: string; reservas: number }

    async function viaFormulario(
      propertyId: string, inicio: string, fin: string,
      payload: Record<string, unknown>,
    ): Promise<FormResult> {
      const { data: sub, error: sErr } = await admin.from('form_submissions').insert({
        tenant_id: tenantId, reference: newRef(),
        intent: 'temporary_rental', status: 'submitted', source: 'public_site',
        payload: { name: 'Ana', check_in: inicio, check_out: fin, ...payload } as never,
        idempotency_key: randomUUID(), contact_id: contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        entity_type: 'property', entity_id: propertyId,
      }).select('id').single()
      if (sErr || !sub) throw new Error(`submission: ${sErr?.message}`)

      const { data: rpc } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub.id, p_tenant_id: tenantId,
        p_contact_id: contactId, p_conversation_id: conversationId,
      })
      const opId = (rpc as { operation_id?: string } | null)?.operation_id
      if (!opId) throw new Error('sin operación')

      const { data: dec } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed',
      })
      const d = dec as { outcome?: string; reason?: string } | null

      const { count } = await admin.from('reservations')
        .select('id', { count: 'exact', head: true })
        .eq('source_operation_request_id', opId)

      return { outcome: d?.outcome ?? 'unknown', reason: d?.reason, opId, reservas: count ?? 0 }
    }

    async function viaIA(propertyId: string, inicio: string, fin: string, guests: number): Promise<string> {
      await admin.from('conversation_reservation_drafts').delete()
        .eq('tenant_id', tenantId).eq('conversation_id', conversationId)
      const raw = await executeCreatePendingReservation(tenantId, conversationId, contactId, {
        property_id: propertyId, start_date: inicio, end_date: fin, guests,
      })
      const r = JSON.parse(raw) as { success?: boolean; error?: string }
      return r.success ? 'success' : (r.error ?? 'error')
    }

    /** C/F/P: la solicitud rechazada no se decidió y no dejó reserva. */
    async function assertPending(opId: string, label: string): Promise<void> {
      const { data: op } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by').eq('id', opId).single()
      const intacta = op?.status === 'pending' && op.decided_at === null && op.decided_by === null
      if (intacta) ok(`${label}: la solicitud sigue pending, sin decided_at ni decided_by`)
      else nok(`${label}: la solicitud quedó tocada`, JSON.stringify(op))
    }

    // ══ A/B/C/H — ESTADÍA MÍNIMA ════════════════════════════════════════════
    console.log(`\n${HR}\n  Estadía mínima (propiedad con minimum_stay_nights = 3)\n`)

    const bAB = await viaFormulario(propMin3, '2029-06-01', '2029-06-05', { adults: 2 })
    if (bAB.outcome === 'confirmed' && bAB.reservas === 1) {
      ok('A. estadía válida (4 noches ≥ 3): el formulario materializa la reserva')
    } else {
      nok('A. una estadía válida no materializó', `${bAB.outcome}/${bAB.reason} reservas=${bAB.reservas}`)
    }

    const bB = await viaFormulario(propMin3, '2029-08-01', '2029-08-02', { adults: 2 })
    if (bB.outcome === 'ineligible' && bB.reason === 'minimum_stay_not_met') {
      ok('B. estadía insuficiente (1 noche < 3): outcome ineligible / minimum_stay_not_met')
    } else {
      nok('B. una estadía insuficiente no fue rechazada', `${bB.outcome}/${bB.reason}`)
    }
    if (bB.reservas === 0) ok('P. estadía insuficiente: 0 reservas creadas')
    else nok('P. se creó una reserva pese al rechazo', String(bB.reservas))
    await assertPending(bB.opId, 'C')

    // H. borde exacto: exactamente el mínimo entra; uno menos no.
    const bH1 = await viaFormulario(propMin3, '2029-09-01', '2029-09-04', { adults: 2 })  // 3 noches
    const bH2 = await viaFormulario(propMin3, '2029-10-01', '2029-10-03', { adults: 2 })  // 2 noches
    if (bH1.outcome === 'confirmed' && bH2.outcome === 'ineligible' && bH2.reason === 'minimum_stay_not_met') {
      ok('H. borde exacto: 3 noches entra (noches ≥ mínimo), 2 noches no')
    } else {
      nok('H. el borde de estadía mínima no es el esperado',
          `3n=${bH1.outcome} · 2n=${bH2.outcome}/${bH2.reason}`)
    }

    // G. el mismo caso por IA da el mismo outcome semántico.
    const iaMin = await viaIA(propMin3, '2029-11-01', '2029-11-02', 2)
    if (iaMin !== 'success' && /estad[íi]a m[íi]nima/i.test(iaMin)) {
      ok('G. la IA rechaza la misma estadía insuficiente, hablando de estadía mínima')
    } else {
      nok('G. la IA no rechazó la estadía insuficiente igual que el formulario', iaMin.slice(0, 140))
    }

    // ══ D/E/F/I/J — CAPACIDAD ═══════════════════════════════════════════════
    console.log(`\n${HR}\n  Capacidad (propiedad con capacity = 4)\n`)

    const bD = await viaFormulario(propCap4, '2029-06-01', '2029-06-05', { adults: 2, children: 1 })
    if (bD.outcome === 'confirmed' && bD.reservas === 1) {
      ok('D. 3 huéspedes ≤ capacidad 4: el formulario materializa la reserva')
    } else {
      nok('D. una capacidad válida no materializó', `${bD.outcome}/${bD.reason}`)
    }

    const bE = await viaFormulario(propCap4, '2029-08-01', '2029-08-05', { adults: 5 })
    if (bE.outcome === 'ineligible' && bE.reason === 'capacity_exceeded') {
      ok('E. 5 huéspedes > capacidad 4: outcome ineligible / capacity_exceeded')
    } else {
      nok('E. una capacidad excedida no fue rechazada', `${bE.outcome}/${bE.reason}`)
    }
    if (bE.reservas === 0) ok('P. capacidad excedida: 0 reservas creadas')
    else nok('P. se creó una reserva pese al rechazo', String(bE.reservas))
    await assertPending(bE.opId, 'F')

    // I. borde exacto de capacidad.
    const bI1 = await viaFormulario(propCap4, '2029-09-01', '2029-09-05', { adults: 4 })
    const bI2 = await viaFormulario(propCap4, '2029-10-01', '2029-10-05', { adults: 4, children: 1 })
    if (bI1.outcome === 'confirmed' && bI2.outcome === 'ineligible' && bI2.reason === 'capacity_exceeded') {
      ok('I. borde exacto: 4 huéspedes entra (huéspedes ≤ capacidad), 5 no')
    } else {
      nok('I. el borde de capacidad no es el esperado', `4=${bI1.outcome} · 5=${bI2.outcome}/${bI2.reason}`)
    }

    // J. bebés — la regla real del repo cuenta a todas las personas.
    const bJ = await viaFormulario(propCap4, '2029-11-01', '2029-11-05', { adults: 2, children: 1, infants: 2 })
    if (bJ.outcome === 'ineligible' && bJ.reason === 'capacity_exceeded') {
      ok('J. bebés: adultos+niños+bebés = 5 > capacidad 4 → rechazado (los bebés cuentan, semántica vigente)')
    } else {
      nok('J. el tratamiento de bebés cambió', `${bJ.outcome}/${bJ.reason}`)
    }

    // G (capacidad). Ojo: antes de esta fase, create_pending_reservation leía
    // capacity y NUNCA la comparaba — este caso pasaba de largo.
    const iaCap = await viaIA(propCap4, '2029-12-01', '2029-12-05', 9)
    if (iaCap !== 'success' && /capacidad/i.test(iaCap)) {
      ok('G. la IA ahora también rechaza por capacidad al CREAR (antes solo al cotizar)')
    } else {
      nok('G. la IA creó una reserva por encima de la capacidad', iaCap.slice(0, 140))
    }

    // ══ K — capacity NULL = sin límite ══════════════════════════════════════
    console.log(`\n${HR}\n  Defaults y ausencia de límite\n`)

    const bK = await viaFormulario(propSinCap, '2029-06-01', '2029-06-03', { adults: 20 })
    if (bK.outcome === 'confirmed') {
      ok('K. capacity NULL: no hay límite declarado, 20 huéspedes entran')
    } else {
      nok('K. capacity NULL rechazó', `${bK.outcome}/${bK.reason}`)
    }

    // ══ Estado comercial ════════════════════════════════════════════════════
    const bSold = await viaFormulario(propSold, '2029-06-01', '2029-06-05', { adults: 2 })
    if (bSold.outcome === 'ineligible' && bSold.reason === 'property_not_available') {
      ok('Estado comercial: una propiedad vendida no materializa (ineligible / property_not_available)')
    } else {
      nok('Estado comercial: una propiedad vendida materializó', `${bSold.outcome}/${bSold.reason}`)
    }
    await assertPending(bSold.opId, 'P')

    // ══ FECHA DE INICIO PASADA — regla propia del flujo formulario ══════════
    //
    // "Hoy" = la fecha UTC, que es la semántica que usa todo el proyecto
    // (new Date().toISOString().split('T')[0]). tenants.timezone existe pero su
    // propio COMMENT dice que ningún código la consume todavía.
    console.log(`\n${HR}\n  Fecha de inicio pasada (solo el flujo formulario → aprobación)\n`)

    const ymd = (offsetDays: number) =>
      new Date(Date.now() + offsetDays * 86_400_000).toISOString().split('T')[0]!

    const ayer   = ymd(-1)
    const hoy    = ymd(0)
    const mañana = ymd(1)

    // A/B/C/D — check-in de ayer.
    const bPast = await viaFormulario(propSinCap, ayer, mañana, { adults: 2 })
    if (bPast.outcome === 'past_start_date') {
      ok(`A. check-in de ayer (${ayer}): outcome past_start_date, no se materializa`)
    } else {
      nok('A. una solicitud con check-in pasado se aprobó', `${bPast.outcome}/${bPast.reason}`)
    }
    if (bPast.reservas === 0) ok('C. check-in pasado: 0 reservas creadas')
    else nok('C. se creó una reserva con check-in pasado', String(bPast.reservas))
    await assertPending(bPast.opId, 'B/D')

    // Y no dejó ningún reservation_event colgado (§5).
    const { count: evCount } = await admin.from('reservation_events')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .contains('metadata', { operation_request_id: bPast.opId })
    if ((evCount ?? 0) === 0) ok('C. check-in pasado: tampoco se generó reservation_event')
    else nok('C. se generó un reservation_event pese al rechazo', String(evCount))

    // E — check-in HOY sigue siendo aprobable (la comparación es estricta).
    const bHoy = await viaFormulario(propSinCap, hoy, ymd(2), { adults: 2 })
    if (bHoy.outcome === 'confirmed' && bHoy.reservas === 1) {
      ok(`E. check-in HOY (${hoy}): se aprueba normalmente — la regla es "< hoy", no "<= hoy"`)
    } else {
      nok('E. una solicitud con check-in hoy fue rechazada', `${bHoy.outcome}/${bHoy.reason}`)
    }

    // F — check-in futuro materializa (ya probado arriba en A de estadía, pero
    // se afirma explícito sobre esta misma propiedad).
    const bFut = await viaFormulario(propSinCap, ymd(30), ymd(33), { adults: 2 })
    if (bFut.outcome === 'confirmed' && bFut.reservas === 1) {
      ok('F. check-in futuro: materializa normalmente')
    } else {
      nok('F. una solicitud futura no materializó', `${bFut.outcome}/${bFut.reason}`)
    }

    // G/I — la función canónica NO conoce esta regla: para el MISMO rango
    // pasado dice que es elegible. Eso es lo que le permite a la creación
    // manual seguir registrando reservas retroactivas.
    const eligPasada = await checkTemporaryRentalEligibility(
      admin, tenantId, propSinCap, ayer, mañana, 2,
    )
    if (eligPasada.eligible) {
      ok('G/I. la elegibilidad canónica acepta un rango pasado: la creación manual conserva la carga retroactiva')
    } else {
      nok('G/I. la regla de fecha pasada se filtró al core general', JSON.stringify(eligPasada))
    }

    // H — la IA sigue rechazando fecha pasada con su propio chequeo.
    const iaPast = await viaIA(propSinCap, ayer, mañana, 2)
    if (iaPast !== 'success' && /PAST_DATE_NOT_ALLOWED|ya pas[óo]/i.test(iaPast)) {
      ok('H. la IA sigue rechazando fecha pasada, sin cambios')
    } else {
      nok('H. la IA cambió su comportamiento con fechas pasadas', iaPast.slice(0, 140))
    }

    // ══ O — creación manual y reprogramación ════════════════════════════════
    //
    // Las server actions necesitan una request de Next (cookies de sesión), así
    // que desde un script no se pueden invocar. Se verifica la MISMA función
    // canónica con los mismos argumentos que ellas le pasan, y con el mismo rol
    // (authenticated), que es donde vivía la divergencia.
    console.log(`\n${HR}\n  O. creación manual y reprogramación (función canónica, como authenticated)\n`)

    const { data: mMin } = await asOwner.rpc('check_temporary_rental_eligibility', {
      p_tenant_id: tenantId, p_property_id: propMin3,
      p_start: '2030-01-01', p_end: '2030-01-02', p_guests: 2,
    })
    const { data: mCap } = await asOwner.rpc('check_temporary_rental_eligibility', {
      p_tenant_id: tenantId, p_property_id: propCap4,
      p_start: '2030-01-01', p_end: '2030-01-05', p_guests: 6,
    })
    const { data: mOk } = await asOwner.rpc('check_temporary_rental_eligibility', {
      p_tenant_id: tenantId, p_property_id: propCap4,
      p_start: '2030-01-01', p_end: '2030-01-05', p_guests: 4,
    })
    const rMin = mMin as { reason?: string } | null
    const rCap = mCap as { reason?: string } | null
    const rOk  = mOk  as { eligible?: boolean; nights?: number } | null

    if (rMin?.reason === 'minimum_stay_not_met' && rCap?.reason === 'capacity_exceeded' && rOk?.eligible === true) {
      ok('O. como authenticated, la función rechaza estadía corta y exceso de capacidad, y acepta lo válido')
    } else {
      nok('O. la función canónica responde distinto como authenticated',
          `${JSON.stringify(rMin)} · ${JSON.stringify(rCap)} · ${JSON.stringify(rOk)}`)
    }

    if (rOk?.nights === 4) ok('O. la función devuelve nights = 4, el mismo cálculo que usa el pricing')
    else nok('O. nights inesperado', JSON.stringify(rOk))

    // Aislamiento entre tenants.
    const { data: ajeno } = await asOwner.rpc('check_temporary_rental_eligibility', {
      p_tenant_id: '00000000-0000-0000-0000-000000000000', p_property_id: propCap4,
      p_start: '2030-01-01', p_end: '2030-01-05', p_guests: 2,
    })
    if ((ajeno as { reason?: string } | null)?.reason === 'property_not_found') {
      ok('O. un tenant_id ajeno no puede verificar propiedades de otro (RLS + filtro)')
    } else {
      nok('O. se pudo verificar con un tenant_id ajeno', JSON.stringify(ajeno))
    }

    // ══ L/M — pricing y disponibilidad intactos ═════════════════════════════
    console.log(`\n${HR}\n  L/M. pricing y disponibilidad siguen funcionando\n`)

    const { data: resA } = await admin.from('reservations')
      .select('nights_count, nightly_price_snapshot, subtotal_amount, total_amount, status')
      .eq('source_operation_request_id', bAB.opId).single()
    if (Number(resA?.nights_count) === 4 && Number(resA?.subtotal_amount) === 40000 &&
        Number(resA?.total_amount) === 40000 && Number(resA?.nightly_price_snapshot) === 10000) {
      ok('L. pricing sigue idéntico: 4 noches × 10.000 = 40.000, sin fees')
    } else {
      nok('L. el pricing cambió', JSON.stringify(resA))
    }

    // La reserva de A ocupa 2029-06-01→05 en propMin3: otra solicitud igual
    // debe chocar por disponibilidad, no por elegibilidad.
    const bM = await viaFormulario(propMin3, '2029-06-02', '2029-06-06', { adults: 2 })
    if (bM.outcome === 'availability_conflict') {
      ok('M. disponibilidad: un rango solapado da availability_conflict (la elegibilidad no la reemplazó)')
    } else {
      nok('M. el solapamiento no fue detectado', `${bM.outcome}/${bM.reason}`)
    }
    if (bM.reservas === 0) ok('M. el solapamiento no creó reserva')
    else nok('M. el solapamiento creó reserva', String(bM.reservas))

    // Elegibilidad y disponibilidad son cosas distintas: la elegibilidad no
    // mira reservas y sigue diciendo que sí sobre fechas ya ocupadas.
    const eligSolapada = await checkTemporaryRentalEligibility(
      admin, tenantId, propMin3, '2029-06-02', '2029-06-06', 2,
    )
    if (eligSolapada.eligible) {
      ok('M. la elegibilidad NO mira disponibilidad: sobre fechas ocupadas sigue siendo elegible')
    } else {
      nok('M. la elegibilidad se mezcló con la disponibilidad', JSON.stringify(eligSolapada))
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

main().catch((e) => {
  console.error('[validate-reservation-eligibility] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

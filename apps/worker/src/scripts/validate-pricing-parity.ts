/**
 * Fase 3E-A.1 — paridad de pricing entre el camino de IA y el de formulario.
 *
 * La pregunta que responde: para la MISMA propiedad, fechas equivalentes y los
 * mismos datos, ¿una reserva creada por la IA y una creada al aprobar una
 * solicitud de formulario quedan con los mismos snapshots financieros?
 *
 * Los dos caminos se ejercitan de verdad, sin reimplementar nada:
 *   · IA         → executeCreatePendingReservation(), la función real del tool
 *   · Formulario → decide_operation_request(), la RPC real, con un login real
 *                  de owner (authenticated, no service role)
 *
 * Se cubren los DOS pricing modes que existen en el repo — 'fixed' y 'consult'
 * (properties_pricing_mode_check) — más el borde "fixed sin precio cargado",
 * que no es un modo nuevo pero se comporta distinto.
 *
 * Las fechas de cada camino son distintas y NO se solapan a propósito: si se
 * pisaran, la guarda de solapamiento haría fallar al segundo y no habría nada
 * que comparar. Se eligen con la misma cantidad de noches para que el subtotal
 * sea comparable.
 *
 * Usage:  pnpm --filter @orderflow/worker validate:pricing-parity
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { randomBytes, randomUUID, randomInt } from 'node:crypto'
import { createClient } from '../lib/supabase'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import { executeCreatePendingReservation } from '../tools/create-pending-reservation'
import { quoteTemporaryRental } from '../tools/pricing.shared'
import type { Database } from '@orderflow/types'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newRef = () => 'SUB-' + Array.from({ length: 6 }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('')

/** Los siete campos que §14 pide comparar. */
const CAMPOS = [
  'pricing_mode_snapshot',
  'nightly_price_snapshot',
  'subtotal_amount',
  'fees_amount',
  'total_amount',
  'deposit_required_amount',
  'currency',
] as const

type Snapshot = Record<string, unknown>

/** NUMERIC vuelve como string desde PostgREST; se compara por valor numérico. */
function norm(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v)
  return v
}

function comparar(label: string, ia: Snapshot, form: Snapshot): void {
  const difs: string[] = []
  for (const campo of CAMPOS) {
    const a = norm(ia[campo]), b = norm(form[campo])
    if (a !== b) difs.push(`${campo}: IA=${JSON.stringify(a)} formulario=${JSON.stringify(b)}`)
  }
  if (difs.length === 0) {
    ok(`${label}: los 7 campos financieros son idénticos entre IA y formulario`)
  } else {
    nok(`${label}: divergencia IA vs formulario`, difs.join(' · '))
  }
}

async function main(): Promise<void> {
  assertSafeSupabaseTarget()

  const admin = createClient()
  const RUN   = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan NEXT_PUBLIC_SUPABASE_URL / ANON_KEY'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3E-A.1 — paridad de pricing: IA vs formulario aprobado')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  let tenantId = '', ownerId = '', contactId = '', conversationId = ''

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    const { data: t, error: tErr } = await admin.from('tenants')
      .insert({ name: `[TEST] PRICING ${RUN}`, slug: `test-pricing-${RUN}`, status: 'active' })
      .select('id').single()
    if (tErr || !t) throw new Error(`tenant: ${tErr?.message}`)
    tenantId = t.id

    const password = randomBytes(18).toString('hex')
    const email    = `owner-pricing-${RUN}@example.test`
    const { data: au, error: aErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (aErr || !au.user) throw new Error(`user: ${aErr?.message}`)
    ownerId = au.user.id

    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: ownerId, tenant_id: tenantId, name: 'Owner Pricing', email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users: ${tuErr.message}`)

    const { data: c } = await admin.from('contacts')
      .insert({ tenant_id: tenantId, phone: `54955${RUN.slice(-8)}`, name: 'Cliente Paridad' })
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

    // Tres propiedades: los dos modos reales + el borde "fixed sin precio".
    // La de precio fijo lleva cleaning_fee Y seña por porcentaje, así se
    // ejercitan de verdad los conceptos que sí existen en el producto (§8).
    async function mkProp(titulo: string, extra: Record<string, unknown>): Promise<string> {
      const { data, error } = await admin.from('properties').insert({
        tenant_id: tenantId, title: `[TEST] ${titulo} ${RUN}`, city: 'Buenos Aires',
        published: true, operation_type: 'temporary_rental',
        currency: 'ARS', capacity: 6, ...extra,
      } as never).select('id').single()
      if (error || !data) throw new Error(`property ${titulo}: ${error?.message}`)
      return data.id
    }

    const propFixed = await mkProp('Fijo', {
      pricing_mode: 'fixed', base_price_per_night: 50000,
      cleaning_fee: 8000, temporary_deposit_percent: 30,
    })
    const propConsult = await mkProp('Consulta', { pricing_mode: 'consult' })
    const propSinPrecio = await mkProp('Fijo sin precio', { pricing_mode: 'fixed' })

    ok('Fixture: tenant, owner, contacto, conversación y 3 propiedades (fixed, consult, fixed-sin-precio)')

    const asOwner = createSupabaseJsClient<Database>(anonUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: session, error: liErr } = await asOwner.auth.signInWithPassword({ email, password })
    if (liErr || !session.session) throw new Error(`login: ${liErr?.message}`)
    ok('Login real de owner (las aprobaciones corren como authenticated, no service role)')

    // ── Camino IA ────────────────────────────────────────────────────────────
    async function viaIA(propertyId: string, inicio: string, fin: string): Promise<Snapshot | null> {
      // Sin draft previo: se fuerza la rama que cotiza al momento, que es la
      // comparable con el formulario (la rama de draft honra una cotización ya
      // mostrada al cliente — diferencia deliberada, ver reporte §H).
      await admin.from('conversation_reservation_drafts').delete()
        .eq('tenant_id', tenantId).eq('conversation_id', conversationId)

      const raw = await executeCreatePendingReservation(tenantId, conversationId, contactId, {
        property_id: propertyId, start_date: inicio, end_date: fin, guests: 2,
      })
      const res = JSON.parse(raw) as { success?: boolean; error?: string }
      if (!res.success) { nok(`IA no pudo crear la reserva (${inicio})`, res.error); return null }

      const { data } = await admin.from('reservations')
        .select(CAMPOS.join(', ') + ', nights_count, pricing_breakdown, source')
        .eq('tenant_id', tenantId).eq('property_id', propertyId)
        .eq('start_date', inicio).eq('source', 'ai').maybeSingle()
      return data as Snapshot | null
    }

    // ── Camino formulario ────────────────────────────────────────────────────
    async function viaFormulario(propertyId: string, inicio: string, fin: string): Promise<Snapshot | null> {
      const { data: sub, error: sErr } = await admin.from('form_submissions').insert({
        tenant_id: tenantId, reference: newRef(),
        intent: 'temporary_rental', status: 'submitted', source: 'public_site',
        payload: { name: 'Ana', check_in: inicio, check_out: fin, adults: 2 } as never,
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

      const { data: dec, error: dErr } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: opId, p_action: 'confirmed',
      })
      const outcome = (dec as { outcome?: string } | null)?.outcome
      if (dErr || outcome !== 'confirmed') {
        nok(`El formulario no se pudo aprobar (${inicio})`, dErr?.message ?? JSON.stringify(dec)); return null
      }

      const { data } = await admin.from('reservations')
        .select(CAMPOS.join(', ') + ', nights_count, pricing_breakdown, source')
        .eq('source_operation_request_id', opId).maybeSingle()
      return data as Snapshot | null
    }

    // ══ 1. pricing_mode = fixed ═════════════════════════════════════════════
    console.log(`\n${HR}\n  1. pricing_mode = fixed (50.000/noche, limpieza 8.000, seña 30%)\n`)

    const iaFixed   = await viaIA(propFixed, '2029-06-01', '2029-06-05')
    const formFixed = await viaFormulario(propFixed, '2029-07-01', '2029-07-05')

    if (iaFixed && formFixed) {
      comparar('fixed', iaFixed, formFixed)

      // §9 — valores concretos, no solo "son iguales entre sí". Si el motor se
      // rompiera de la misma forma en los dos caminos, la comparación de arriba
      // seguiría pasando y esto no.
      const esperado = {
        pricing_mode_snapshot:   'fixed',
        nightly_price_snapshot:  50000,
        subtotal_amount:         200000,   // 50.000 × 4 noches
        fees_amount:             8000,     // cleaning_fee
        total_amount:            208000,   // 200.000 + 8.000
        deposit_required_amount: 62400,    // 30% de 208.000
        currency:                'ARS',
      }
      for (const [via, snap] of [['IA', iaFixed], ['formulario', formFixed]] as const) {
        const difs = Object.entries(esperado)
          .filter(([k, v]) => norm(snap[k]) !== v)
          .map(([k, v]) => `${k}: esperado ${v}, real ${JSON.stringify(norm(snap[k]))}`)
        if (difs.length === 0) ok(`fixed · ${via}: valores concretos correctos (4 noches → 200.000 + 8.000 = 208.000, seña 62.400)`)
        else nok(`fixed · ${via}: valores incorrectos`, difs.join(' · '))
      }

      if (norm(iaFixed['nights_count']) === 4 && norm(formFixed['nights_count']) === 4) {
        ok('fixed: nights_count = 4 en ambos caminos')
      } else {
        nok('fixed: nights_count difiere', `IA=${iaFixed['nights_count']} formulario=${formFixed['nights_count']}`)
      }

      const bIA = JSON.stringify(iaFixed['pricing_breakdown'] ?? {})
      const bFO = JSON.stringify(formFixed['pricing_breakdown'] ?? {})
      if (bIA === bFO) ok('fixed: pricing_breakdown idéntico en ambos caminos')
      else nok('fixed: pricing_breakdown difiere', `IA=${bIA} · formulario=${bFO}`)
    }

    // ══ 2. pricing_mode = consult ═══════════════════════════════════════════
    console.log(`\n${HR}\n  2. pricing_mode = consult (precio desconocido)\n`)

    const iaConsult   = await viaIA(propConsult, '2029-06-01', '2029-06-05')
    const formConsult = await viaFormulario(propConsult, '2029-07-01', '2029-07-05')

    if (iaConsult && formConsult) {
      comparar('consult', iaConsult, formConsult)

      for (const [via, snap] of [['IA', iaConsult], ['formulario', formConsult]] as const) {
        const nulos = ['nightly_price_snapshot', 'subtotal_amount', 'total_amount', 'deposit_required_amount']
        const malos = nulos.filter(k => norm(snap[k]) !== null)
        const modoOk = snap['pricing_mode_snapshot'] === 'consult'
        // §7: precio DESCONOCIDO, no precio cero. fees es la excepción y no es
        // una decisión: reservations.fees_amount es NOT NULL DEFAULT 0.
        if (malos.length === 0 && modoOk) {
          ok(`consult · ${via}: importes en NULL (desconocido), no en 0; modo 'consult'`)
        } else {
          nok(`consult · ${via}: no respeta NULL`, `modo=${snap['pricing_mode_snapshot']} no-nulos=${malos.join(',')}`)
        }
        if (norm(snap['fees_amount']) === 0) ok(`consult · ${via}: fees_amount = 0 (columna NOT NULL DEFAULT 0)`)
        else nok(`consult · ${via}: fees_amount inesperado`, String(snap['fees_amount']))
      }
    }

    // ══ 3. borde: fixed sin precio cargado ══════════════════════════════════
    console.log(`\n${HR}\n  3. borde: pricing_mode = fixed pero sin base_price_per_night\n`)

    const iaSinPrecio   = await viaIA(propSinPrecio, '2029-06-01', '2029-06-05')
    const formSinPrecio = await viaFormulario(propSinPrecio, '2029-07-01', '2029-07-05')

    if (iaSinPrecio && formSinPrecio) {
      comparar('fixed-sin-precio', iaSinPrecio, formSinPrecio)
      const ambosNull =
        norm(iaSinPrecio['total_amount']) === null && norm(formSinPrecio['total_amount']) === null
      if (ambosNull) ok('fixed-sin-precio: ambos caminos dejan los importes en NULL en vez de inventar 0')
      else nok('fixed-sin-precio: algún camino fabricó un importe')
    }

    // ══ 4. el motor es el mismo que ve el dashboard ═════════════════════════
    console.log(`\n${HR}\n  4. el motor canónico responde igual a service_role y a authenticated\n`)

    const qAdmin = await quoteTemporaryRental(admin, tenantId, propFixed, '2029-09-01', '2029-09-05')
    const { data: qOwnerRaw } = await asOwner.rpc('quote_temporary_rental', {
      p_tenant_id: tenantId, p_property_id: propFixed, p_start: '2029-09-01', p_end: '2029-09-05',
    })
    if (JSON.stringify(qAdmin) === JSON.stringify(qOwnerRaw)) {
      ok('quote_temporary_rental devuelve exactamente lo mismo por service_role (worker) que por authenticated (dashboard)')
    } else {
      nok('El motor responde distinto según el rol', `worker=${JSON.stringify(qAdmin)} dashboard=${JSON.stringify(qOwnerRaw)}`)
    }

    // Aislamiento entre tenants: un owner no puede cotizar propiedades ajenas.
    const { data: qAjeno } = await asOwner.rpc('quote_temporary_rental', {
      p_tenant_id: '00000000-0000-0000-0000-000000000000',
      p_property_id: propFixed, p_start: '2029-09-01', p_end: '2029-09-05',
    })
    if ((qAjeno as { ok?: boolean } | null)?.ok === false) {
      ok('Un tenant_id que no es el propio no devuelve cotización (RLS + filtro por tenant)')
    } else {
      nok('Se pudo cotizar con un tenant_id ajeno', JSON.stringify(qAjeno))
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
  console.error('[validate-pricing-parity] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

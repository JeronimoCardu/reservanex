/**
 * Cierre 3E-A.2 §7 — fixture para la prueba MANUAL de navegador de
 * createReservationAction / rescheduleReservationAction.
 *
 * Por qué existe: esas dos son Server Actions de Next. Necesitan una request
 * real con cookies de sesión, así que no se pueden invocar desde un script, y
 * el repo no tiene Playwright ni Cypress (solo vitest para unit tests). Montar
 * infraestructura de E2E solo para este caso sería desproporcionado, así que
 * este script deja el escenario listo para hacerlo a mano en dos minutos.
 *
 * Crea, en el tenant demo:
 *   · una propiedad de alquiler temporal, publicada, con capacity = 4
 *   · sobre fechas futuras verificadas como libres
 *
 * NO crea usuarios: se usa el owner demo que ya existe. NO toca ninguna
 * submission ni reserva existente — solo agrega una propiedad, y la limpieza
 * borra exactamente eso.
 *
 * Usage:
 *   pnpm --filter @orderflow/web fixture:manual-eligibility
 *   pnpm --filter @orderflow/web fixture:manual-eligibility -- --cleanup
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'

const HR = '─'.repeat(78)

const TENANT_DEMO = 'ace547bb-3a72-4ed6-8ff5-de49d001cd68'
const TITULO      = '[FIXTURE 3E-A.2] Cabaña capacidad 4'

/** Referencias históricas que no se deben tocar bajo ninguna circunstancia. */
const INTOCABLES = ['SUB-2AN6JL', 'SUB-BKSA5W', 'SUB-3EATST']

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const cleanup = process.argv.includes('--cleanup')

  console.log(HR)
  console.log(`  Fixture manual de elegibilidad — ${cleanup ? 'LIMPIEZA' : 'PREPARACIÓN'}`)
  console.log(`  target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)
  console.log(HR)

  const { data: tenant } = await admin
    .from('tenants').select('id, name, slug').eq('id', TENANT_DEMO).maybeSingle()
  if (!tenant) { console.error('  ✗ El tenant demo no existe en este proyecto.'); process.exit(1) }
  console.log(`  tenant: ${tenant.name} (${tenant.slug})`)

  // Fotografía de la evidencia histórica, antes y después.
  async function snapshotHistorico(): Promise<string> {
    const { data } = await admin
      .from('form_submissions')
      .select('reference, status, confirmed_at, updated_at')
      .in('reference', INTOCABLES)
      .order('reference')
    return JSON.stringify(data)
  }
  const antes = await snapshotHistorico()

  const { data: existentes } = await admin
    .from('properties').select('id, title').eq('tenant_id', TENANT_DEMO).eq('title', TITULO)

  if (cleanup) {
    if (!existentes || existentes.length === 0) {
      console.log('  no hay fixture para borrar')
    } else {
      for (const p of existentes) {
        // Las reservas que la prueba manual haya creado sobre la propiedad se
        // borran con ella; si no, quedaría una propiedad huérfana referenciada.
        const { data: res } = await admin
          .from('reservations').select('id').eq('property_id', p.id)
        for (const r of res ?? []) {
          await admin.from('reservation_events').delete().eq('reservation_id', r.id)
        }
        const { count: borradas } = await admin
          .from('reservations').delete({ count: 'exact' }).eq('property_id', p.id)
        const { error } = await admin.from('properties').delete().eq('id', p.id)
        if (error) console.error(`  ✗ no se pudo borrar la propiedad ${p.id}: ${error.message}`)
        else console.log(`  ✓ propiedad borrada (${borradas ?? 0} reserva(s) de prueba con ella)`)
      }
    }

    const despues = await snapshotHistorico()
    console.log(antes === despues
      ? '  ✓ evidencia histórica intacta (SUB-2AN6JL, SUB-BKSA5W, SUB-3EATST)'
      : '  ✗ LA EVIDENCIA HISTÓRICA CAMBIÓ')

    const { count: quedan } = await admin
      .from('properties').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TENANT_DEMO).eq('title', TITULO)
    console.log(`  fixtures remanentes: ${quedan ?? 0}`)
    console.log(HR)
    process.exit(antes === despues && (quedan ?? 0) === 0 ? 0 : 1)
  }

  // ── Preparación ───────────────────────────────────────────────────────────
  if (existentes && existentes.length > 0) {
    console.log('  ya existe un fixture; se reutiliza (corré con --cleanup para borrarlo)')
  }

  let propertyId = existentes?.[0]?.id ?? ''

  if (!propertyId) {
    const { data: prop, error } = await admin.from('properties').insert({
      tenant_id:            TENANT_DEMO,
      title:                TITULO,
      city:                 'Buenos Aires',
      published:            true,
      operation_type:       'temporary_rental',
      commercial_status:    'available',
      pricing_mode:         'fixed',
      base_price_per_night: 120,
      currency:             'USD',
      capacity:             4,
      minimum_stay_nights:  1,
    } as never).select('id').single()
    if (error || !prop) { console.error(`  ✗ no se pudo crear la propiedad: ${error?.message}`); process.exit(1) }
    propertyId = prop.id
    console.log('  ✓ propiedad creada')
  }

  // Fechas futuras libres, verificadas con el mecanismo canónico de la DB.
  const ymd = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().split('T')[0]!
  let inicio = '', fin = ''
  for (let offset = 60; offset <= 400; offset += 10) {
    const a = ymd(offset), b = ymd(offset + 3)
    const { data } = await admin.rpc('temporary_rental_dates_available', {
      p_tenant_id: TENANT_DEMO, p_property_id: propertyId, p_start: a, p_end: b,
    })
    if ((data as { available?: boolean } | null)?.available) { inicio = a; fin = b; break }
  }
  if (!inicio) { console.error('  ✗ no se encontró un rango libre'); process.exit(1) }

  const { data: elig4 } = await admin.rpc('check_temporary_rental_eligibility', {
    p_tenant_id: TENANT_DEMO, p_property_id: propertyId,
    p_start: inicio, p_end: fin, p_guests: 4,
  })
  const { data: elig5 } = await admin.rpc('check_temporary_rental_eligibility', {
    p_tenant_id: TENANT_DEMO, p_property_id: propertyId,
    p_start: inicio, p_end: fin, p_guests: 5,
  })

  const despues = await snapshotHistorico()

  console.log('')
  console.log(HR)
  console.log('  ESCENARIO LISTO')
  console.log(HR)
  console.log(`  propiedad     : ${TITULO}`)
  console.log(`  property_id   : ${propertyId}`)
  console.log('  capacity      : 4')
  console.log('  precio        : USD 120/noche (pricing_mode fixed)')
  console.log(`  fechas libres : ${inicio} → ${fin}  (3 noches)`)
  console.log(`  owner         : owner.demo@reservanex.test`)
  console.log('')
  console.log('  Lo que la DB ya confirma para esas fechas:')
  console.log(`    4 huéspedes → ${JSON.stringify(elig4)}`)
  console.log(`    5 huéspedes → ${JSON.stringify(elig5)}`)
  console.log('')
  console.log('  PASOS EN EL NAVEGADOR')
  console.log('  ─────────────────────')
  console.log('  1. Entrá al dashboard como owner.demo@reservanex.test')
  console.log('  2. Reservas → Crear reserva. Elegí la propiedad del fixture,')
  console.log(`     las fechas ${inicio} → ${fin}, estado "Confirmada" (o Pre-reservada),`)
  console.log('     y 5 personas.')
  console.log('     ESPERADO: se rechaza con "No se puede crear la reserva. La cantidad de')
  console.log('     huéspedes (5) supera la capacidad de la propiedad (4)."')
  console.log('  3. Cambiá a 4 personas y volvé a guardar.')
  console.log('     ESPERADO: la reserva se crea.')
  console.log('  4. (Opcional) Reprogramá esa reserva a 5 personas → mismo rechazo.')
  console.log('')
  console.log('  AL TERMINAR, para no dejar residuos:')
  console.log('    pnpm --filter @orderflow/web fixture:manual-eligibility -- --cleanup')
  console.log('')
  console.log(antes === despues
    ? '  ✓ evidencia histórica intacta (SUB-2AN6JL, SUB-BKSA5W, SUB-3EATST)'
    : '  ✗ LA EVIDENCIA HISTÓRICA CAMBIÓ')
  console.log(HR)
  process.exit(antes === despues ? 0 : 1)
}

main().catch(e => {
  console.error('[fixture-manual-eligibility] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

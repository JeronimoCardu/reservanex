/**
 * Fase 3E-C2 §26 — escenario para la prueba de navegador de reservas de mesa.
 *
 * El tenant demo existente es real_estate y no tiene los formularios de
 * gastronomía, así que reutilizarlo contaminaría verticales. Este script crea un
 * tenant food_service propio, con su owner, y tres solicitudes de mesa pending
 * creadas por el camino real (form_submission →
 * confirm_submission_and_create_operation, la misma RPC que corre cuando el
 * cliente confirma por WhatsApp):
 *
 *   1. confirmar → editar → marcar realizada
 *   2. confirmar → cancelar
 *   3. confirmar → marcar ausencia
 *
 * SOBRE LA CONTRASEÑA: el script NO inventa ni imprime ninguna. Crea el usuario
 * y te dice cómo establecerla vos de forma segura desde el panel de Supabase.
 *
 * NO toca el tenant demo inmobiliario ni SUB-2AN6JL / SUB-BKSA5W / SUB-3EATST,
 * y lo verifica antes y después.
 *
 * Usage:
 *   pnpm --filter @orderflow/web fixture:table-reservations-demo
 *   pnpm --filter @orderflow/web fixture:table-reservations-demo -- --cleanup
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { generateSubmissionReference } from '../src/lib/forms/submission-reference'

const HR = '─'.repeat(78)

const SLUG        = 'demo-gastronomia'
const NOMBRE      = '[DEMO] Gastronomía QA'
const OWNER_EMAIL = 'owner.gastro@reservanex.test'
const INTOCABLES  = ['SUB-2AN6JL', 'SUB-BKSA5W', 'SUB-3EATST']
const DEMO_INMOB  = 'ace547bb-3a72-4ed6-8ff5-de49d001cd68'

const futuro = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toISOString().split('T')[0]!

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const cleanup = process.argv.includes('--cleanup')

  console.log(HR)
  console.log(`  Fixture de reservas de mesa — ${cleanup ? 'LIMPIEZA' : 'PREPARACIÓN'}`)
  console.log(`  target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)
  console.log(HR)

  async function snapshotHistorico(): Promise<string> {
    const { data } = await admin
      .from('form_submissions')
      .select('reference, status, confirmed_at, updated_at')
      .in('reference', INTOCABLES).order('reference')
    const { count: inmob } = await admin.from('form_submissions')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', DEMO_INMOB)
    return JSON.stringify({ data, inmob })
  }
  const antes = await snapshotHistorico()

  const { data: existente } = await admin.from('tenants')
    .select('id, name, slug, vertical, timezone').eq('slug', SLUG).maybeSingle()

  // ── Limpieza ──────────────────────────────────────────────────────────────
  if (cleanup) {
    if (!existente) {
      console.log('  no hay tenant de fixture para borrar')
    } else {
      // Guarda dura: solo se borra si es exactamente el tenant esperado.
      if (existente.name !== NOMBRE || existente.vertical !== 'food_service') {
        console.error('  ✗ ABORTADO: el tenant no coincide con lo esperado:', JSON.stringify(existente))
        process.exit(1)
      }
      const { data: users } = await admin.from('tenant_users').select('id').eq('tenant_id', existente.id)
      for (const tb of ['table_reservations', 'operation_requests', 'notes', 'tasks'] as const) {
        const { count } = await admin.from(tb).delete({ count: 'exact' }).eq('tenant_id', existente.id)
        if ((count ?? 0) > 0) console.log(`  ✓ ${tb}: ${count}`)
      }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: existente.id }) } catch { /* noop */ }
      await admin.from('tenants').delete().eq('id', existente.id)
      for (const u of users ?? []) { try { await admin.auth.admin.deleteUser(u.id) } catch { /* noop */ } }
      console.log(`  ✓ tenant borrado · usuarios auth: ${users?.length ?? 0}`)
    }

    const despues = await snapshotHistorico()
    console.log(antes === despues
      ? '  ✓ evidencia histórica y tenant inmobiliario intactos'
      : '  ✗ ALGO DEL TENANT INMOBILIARIO CAMBIÓ')

    const { count: quedan } = await admin.from('tenants')
      .select('id', { count: 'exact', head: true }).eq('vertical', 'food_service')
    const { count: reservas } = await admin.from('table_reservations')
      .select('id', { count: 'exact', head: true })
    console.log(`  tenants food_service: ${quedan ?? 0} · reservas de mesa: ${reservas ?? 0}`)
    console.log(HR)
    process.exit(antes === despues && (quedan ?? 0) === 0 ? 0 : 1)
  }

  // ── Preparación ───────────────────────────────────────────────────────────
  let tenantId = existente?.id ?? ''

  if (!tenantId) {
    const { data: t, error } = await admin.from('tenants').insert({
      name: NOMBRE, slug: SLUG, status: 'active',
      vertical: 'food_service',
      timezone: 'America/Argentina/Buenos_Aires',
      public_slug: SLUG, public_name: 'Gastronomía QA',
    } as never).select('id').single()
    if (error || !t) { console.error(`  ✗ tenant: ${error?.message}`); process.exit(1) }
    tenantId = t.id
    console.log('  ✓ tenant food_service creado')
  } else {
    console.log('  ya existe el tenant de fixture; se reutiliza')
  }

  // ── Owner, SIN contraseña generada acá ────────────────────────────────────
  let ownerNuevo = false
  const { data: yaEsta } = await admin.from('tenant_users')
    .select('id, email').eq('tenant_id', tenantId).eq('role', 'owner').maybeSingle()

  if (!yaEsta) {
    const { data: au, error: ae } = await admin.auth.admin.createUser({
      email: OWNER_EMAIL, email_confirm: true,
    })
    if (ae || !au.user) { console.error(`  ✗ owner: ${ae?.message}`); process.exit(1) }
    const { error: tue } = await admin.from('tenant_users').insert({
      id: au.user.id, tenant_id: tenantId, name: 'Owner Gastro',
      email: OWNER_EMAIL, role: 'owner', active: true,
    } as never)
    if (tue) { console.error(`  ✗ tenant_users: ${tue.message}`); process.exit(1) }
    ownerNuevo = true
    console.log('  ✓ owner creado (sin contraseña — ver abajo)')
  }

  const { data: contacto } = await admin.from('contacts')
    .select('id').eq('tenant_id', tenantId).limit(1).maybeSingle()
  const contactId = contacto?.id ?? (await admin.from('contacts')
    .insert({ tenant_id: tenantId, phone: '5491199887766', name: null } as never)
    .select('id').single()).data!.id

  const CASOS = [
    { etiqueta: 'confirmar → editar → realizada', nombre: 'Ana Gómez',  dias: 10, hora: '20:30', people: 4 },
    { etiqueta: 'confirmar → cancelar',           nombre: 'Bruno Díaz', dias: 12, hora: '21:00', people: 2 },
    { etiqueta: 'confirmar → no asistió',         nombre: 'Carla Ruiz', dias: 14, hora: '13:30', people: 6 },
  ]

  const { data: yaHay } = await admin.from('form_submissions')
    .select('id').eq('tenant_id', tenantId).eq('intent', 'table_reservation')

  const creadas: { reference: string; etiqueta: string; pidio: string }[] = []

  for (let i = (yaHay?.length ?? 0); i < CASOS.length; i++) {
    const caso = CASOS[i]!
    const reference = generateSubmissionReference()
    const fecha = futuro(caso.dias)

    const { data: sub, error: se } = await admin.from('form_submissions').insert({
      tenant_id: tenantId, reference,
      intent: 'table_reservation', status: 'submitted', source: 'public_site',
      payload: {
        name: caso.nombre, date: fecha, time: caso.hora, people: caso.people,
        notes: 'Si se puede, mesa tranquila.',
      } as never,
      idempotency_key: randomUUID(), contact_id: contactId,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    } as never).select('id').single()
    if (se || !sub) { console.error(`  ✗ submission: ${se?.message}`); process.exit(1) }

    const { error: re } = await admin.rpc('confirm_submission_and_create_operation', {
      p_submission_id: sub.id, p_tenant_id: tenantId,
      p_contact_id: contactId, p_conversation_id: undefined,
    })
    if (re) { console.error(`  ✗ confirm: ${re.message}`); process.exit(1) }

    creadas.push({ reference, etiqueta: caso.etiqueta, pidio: `${fecha} ${caso.hora} · ${caso.people} personas` })
    console.log(`  ✓ ${reference} — ${caso.etiqueta} (pidió ${fecha} ${caso.hora}, ${caso.people} personas)`)
  }

  const despues = await snapshotHistorico()

  console.log('')
  console.log(HR)
  console.log('  ESCENARIO LISTO')
  console.log(HR)
  console.log(`  tenant   : ${NOMBRE} (${SLUG}) · vertical food_service`)
  console.log(`  zona     : America/Argentina/Buenos_Aires`)
  console.log(`  owner    : ${OWNER_EMAIL}`)
  for (const c of creadas) console.log(`  ${c.reference} → ${c.etiqueta}`)

  if (ownerNuevo) {
    console.log('')
    console.log('  ⚠ EL OWNER NO TIENE CONTRASEÑA TODAVÍA')
    console.log('  No la genero ni la imprimo acá. Establecela vos:')
    console.log('    Supabase → Authentication → Users → buscá ' + OWNER_EMAIL)
    console.log('    → "Reset password" (te manda el mail) o "Update user" → contraseña nueva.')
    console.log('  Es el mismo procedimiento que usaste para owner.demo@reservanex.test.')
  }

  console.log('')
  console.log('  PASOS EN EL NAVEGADOR')
  console.log('  ─────────────────────')
  console.log('  1. Entrá como el owner de gastronomía. Dashboard → Solicitudes.')
  console.log('     Las tres aparecen como "Solicitud de mesa", con chips de Fecha,')
  console.log('     Hora y Cantidad de personas.')
  console.log('  2. Abrí la primera: el botón dice "Confirmar reserva", no "Aprobar".')
  console.log('  3. Tocalo. El diálogo precarga fecha, HORA y personas de lo que pidió')
  console.log('     el cliente. Cambiá la hora y/o las personas —eso registra lo')
  console.log('     ACORDADO— y confirmá.')
  console.log('     ESPERADO: toast "Reserva confirmada" y el badge queda "Reservada".')
  console.log('  4. Menú → Reservas de mesa. Tiene que estar en Próximas con lo acordado.')
  console.log('  5. Abrila → Editar → cambiá fecha/hora/personas → guardá.')
  console.log('  6. Abrila → Marcar como realizada. Los botones desaparecen.')
  console.log('  7. Volvé a Solicitudes y abrí esa solicitud: dice "Reservada para')
  console.log('     DD/MM/AAAA HH:mm · N personas", y abajo sigue lo que pidió el cliente.')
  console.log('  8. Con la SEGUNDA: confirmá y después cancelá con un motivo.')
  console.log('  9. Con la TERCERA: confirmá y después "No asistió".')
  console.log('     ESPERADO en 8 y 9: la solicitud SIGUE "Reservada" — cancelar o marcar')
  console.log('     ausencia no reescribe que el restaurante la había aceptado.')
  console.log(' 10. (Opcional) Ajustes → Usuarios → permisos: "Gestionar reservas de mesa".')
  console.log('')
  console.log('  AL TERMINAR (borra el tenant completo):')
  console.log('    pnpm --filter @orderflow/web fixture:table-reservations-demo -- --cleanup')
  console.log('')
  console.log(antes === despues
    ? '  ✓ evidencia histórica y tenant inmobiliario intactos'
    : '  ✗ ALGO DEL TENANT INMOBILIARIO CAMBIÓ')
  console.log(HR)
  process.exit(antes === despues ? 0 : 1)
}

main().catch((e) => {
  console.error('[fixture-table-reservations-demo] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

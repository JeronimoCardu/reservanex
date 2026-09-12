/**
 * Fase 3E-B2 §28 — escenario para la prueba de navegador de las visitas.
 *
 * Deja en el tenant demo DOS solicitudes de visita pending, creadas por el
 * camino real (form_submission → confirm_submission_and_create_operation, la
 * misma RPC que corre cuando el cliente confirma por WhatsApp):
 *
 *   · una para agendar → reagendar → marcar como realizada
 *   · otra para agendar → cancelar
 *
 * Por qué un fixture y no un test automático: las dos se operan con la sesión
 * del owner demo, cuya contraseña definiste vos de forma segura. El equivalente
 * automatizado corre en validate:visits con logins reales, en tenants
 * descartables.
 *
 * NO toca SUB-2AN6JL, SUB-BKSA5W ni SUB-3EATST, y lo verifica antes y después.
 *
 * Usage:
 *   pnpm --filter @orderflow/web fixture:visits-demo
 *   pnpm --filter @orderflow/web fixture:visits-demo -- --cleanup
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { generateSubmissionReference } from '../src/lib/forms/submission-reference'

const HR = '─'.repeat(78)

const TENANT_DEMO = 'ace547bb-3a72-4ed6-8ff5-de49d001cd68'
const MARCA       = '[FIXTURE 3E-B2]'
const INTOCABLES  = ['SUB-2AN6JL', 'SUB-BKSA5W', 'SUB-3EATST']

const futuro = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toISOString().split('T')[0]!

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const cleanup = process.argv.includes('--cleanup')

  console.log(HR)
  console.log(`  Fixture de visitas — ${cleanup ? 'LIMPIEZA' : 'PREPARACIÓN'}`)
  console.log(`  target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)
  console.log(HR)

  const { data: tenant } = await admin
    .from('tenants').select('id, name, slug, timezone').eq('id', TENANT_DEMO).maybeSingle()
  if (!tenant) { console.error('  ✗ El tenant demo no existe en este proyecto.'); process.exit(1) }
  console.log(`  tenant: ${tenant.name} (${tenant.slug}) · zona: ${tenant.timezone}`)

  async function snapshotHistorico(): Promise<string> {
    const { data } = await admin
      .from('form_submissions')
      .select('reference, status, confirmed_at, updated_at')
      .in('reference', INTOCABLES).order('reference')
    return JSON.stringify(data)
  }
  const antes = await snapshotHistorico()

  const { data: subs } = await admin
    .from('form_submissions')
    .select('id, reference, intent, status')
    .eq('tenant_id', TENANT_DEMO)
    .contains('payload', { fixture: MARCA })

  if (cleanup) {
    if (!subs || subs.length === 0) {
      console.log('  no hay fixture para borrar')
    } else {
      for (const s of subs) {
        if (INTOCABLES.includes(s.reference)) {
          console.error(`  ✗ ABORTADO: ${s.reference} es evidencia histórica`)
          process.exit(1)
        }
        const { data: ops } = await admin.from('operation_requests')
          .select('id').eq('source_submission_id', s.id)
        for (const o of ops ?? []) {
          const { count: v } = await admin.from('property_visits')
            .delete({ count: 'exact' }).eq('source_operation_request_id', o.id)
          console.log(`  ✓ visitas borradas: ${v ?? 0}`)
        }
        await admin.from('operation_requests').delete().eq('source_submission_id', s.id)
        await admin.from('form_submissions').delete().eq('id', s.id)
        console.log(`  ✓ ${s.reference} borrada`)
      }
    }

    const despues = await snapshotHistorico()
    console.log(antes === despues
      ? '  ✓ evidencia histórica intacta (SUB-2AN6JL, SUB-BKSA5W, SUB-3EATST)'
      : '  ✗ LA EVIDENCIA HISTÓRICA CAMBIÓ')

    const { count: quedan } = await admin.from('form_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', TENANT_DEMO).contains('payload', { fixture: MARCA })
    const { count: visitas } = await admin.from('property_visits')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', TENANT_DEMO)
    console.log(`  fixtures remanentes: ${quedan ?? 0} · visitas del tenant: ${visitas ?? 0}`)
    console.log(HR)
    process.exit(antes === despues && (quedan ?? 0) === 0 ? 0 : 1)
  }

  // ── Preparación ───────────────────────────────────────────────────────────
  if (subs && subs.length > 0) {
    console.log(`  ya hay ${subs.length} solicitud(es) de fixture; se reutilizan (--cleanup para borrarlas)`)
  }

  const { data: contact } = await admin.from('contacts')
    .select('id, name, phone').eq('tenant_id', TENANT_DEMO)
    .order('created_at').limit(1).maybeSingle()
  if (!contact) { console.error('  ✗ El tenant demo no tiene contactos.'); process.exit(1) }

  const { data: prop } = await admin.from('properties')
    .select('id, title').eq('tenant_id', TENANT_DEMO)
    .is('deleted_at', null).order('created_at').limit(1).maybeSingle()
  if (!prop) { console.error('  ✗ El tenant demo no tiene propiedades.'); process.exit(1) }

  const CASOS = [
    { etiqueta: 'ciclo completo (agendar → reagendar → realizada)', nombre: 'Ana Gómez',  dias: 12 },
    { etiqueta: 'cancelación (agendar → cancelar)',                 nombre: 'Bruno Díaz', dias: 18 },
  ]

  const creadas: { reference: string; etiqueta: string; preferida: string }[] = []
  const yaHay = subs?.length ?? 0

  for (let i = yaHay; i < CASOS.length; i++) {
    const caso = CASOS[i]!
    const reference = generateSubmissionReference()
    const preferida = futuro(caso.dias)

    const { data: sub, error: se } = await admin.from('form_submissions').insert({
      tenant_id: TENANT_DEMO, reference,
      intent: 'property_visit', status: 'submitted', source: 'public_site',
      payload: {
        fixture: MARCA,
        name: caso.nombre,
        preferred_date: preferida,
        preferred_time_range: 'afternoon',
        notes: 'Prefiero después de las 15.',
      } as never,
      idempotency_key: randomUUID(), contact_id: contact.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      entity_type: 'property', entity_id: prop.id,
    } as never).select('id').single()
    if (se || !sub) { console.error(`  ✗ submission: ${se?.message}`); process.exit(1) }

    const { error: re } = await admin.rpc('confirm_submission_and_create_operation', {
      p_submission_id: sub.id, p_tenant_id: TENANT_DEMO,
      p_contact_id: contact.id, p_conversation_id: undefined,
    })
    if (re) { console.error(`  ✗ confirm: ${re.message}`); process.exit(1) }

    creadas.push({ reference, etiqueta: caso.etiqueta, preferida })
    console.log(`  ✓ ${reference} — ${caso.etiqueta} (pidió ${preferida}, franja tarde)`)
  }

  const despues = await snapshotHistorico()

  console.log('')
  console.log(HR)
  console.log('  ESCENARIO LISTO')
  console.log(HR)
  console.log(`  contacto  : ${contact.name ?? contact.phone}`)
  console.log(`  propiedad : ${prop.title}`)
  console.log(`  zona      : ${tenant.timezone}  (la hora que elijas se interpreta ahí)`)
  for (const c of creadas) console.log(`  ${c.reference} → ${c.etiqueta}`)
  console.log('')
  console.log('  PASOS EN EL NAVEGADOR (owner.demo@reservanex.test)')
  console.log('  ──────────────────────────────────────────────────')
  console.log('  1. Dashboard → Solicitudes. Las dos aparecen en Pendientes como')
  console.log('     "Solicitud de visita", con chips de "Día preferido" y "Horario')
  console.log('     preferido: Tarde (12 a 18)".')
  console.log('  2. Abrí la primera. El botón dice "Agendar visita", no "Aprobar".')
  console.log('  3. Tocalo: el diálogo pre-carga la fecha que pidió el cliente y deja la')
  console.log('     HORA vacía a propósito. Elegí una hora — probá una FUERA de la franja,')
  console.log(`     por ejemplo 09:30, para confirmar que se permite. Confirmá.`)
  console.log('     ESPERADO: toast "Visita agendada" y el badge queda "Agendada".')
  console.log('  4. Andá a Visitas (nuevo ítem del menú). Tiene que estar en Próximas,')
  console.log('     con la fecha y la hora que elegiste.')
  console.log('  5. Abrila → Reagendar → otra fecha/hora → ESPERADO: se actualiza.')
  console.log('  6. Abrila → Marcar como realizada → ESPERADO: pasa a "Realizada" y')
  console.log('     desaparecen los botones de acción.')
  console.log('  7. Volvé a Solicitudes y abrí esa solicitud: tiene que decir')
  console.log('     "Agendada para DD/MM/AAAA HH:mm".')
  console.log('  8. Con la SEGUNDA solicitud: agendala y después cancelala con un motivo.')
  console.log('     ESPERADO: la visita queda "Cancelada" y la solicitud SIGUE "Agendada"')
  console.log('     (cancelar la cita no reescribe la decisión de haberla agendado).')
  console.log('  9. (Opcional) Ajustes → Usuarios → permisos: tiene que aparecer')
  console.log('     "Gestionar visitas".')
  console.log('')
  console.log('  AL TERMINAR:')
  console.log('    pnpm --filter @orderflow/web fixture:visits-demo -- --cleanup')
  console.log('')
  console.log(antes === despues
    ? '  ✓ evidencia histórica intacta (SUB-2AN6JL, SUB-BKSA5W, SUB-3EATST)'
    : '  ✗ LA EVIDENCIA HISTÓRICA CAMBIÓ')
  console.log(HR)
  process.exit(antes === despues ? 0 : 1)
}

main().catch((e) => {
  console.error('[fixture-visits-demo] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

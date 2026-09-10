/**
 * Fase 3E-B1 §16 — escenario para la prueba de navegador de las consultas.
 *
 * Deja en el tenant demo DOS consultas pending, una de cada intent, listas para
 * gestionar desde /dashboard/requests con el owner real:
 *
 *   · property_inquiry       → "Consulta por propiedad"
 *   · monthly_rental_inquiry → "Consulta alquiler mensual", con mudanza y ocupantes
 *
 * Por qué un fixture y no un test automático: las dos operan con la sesión del
 * owner demo, y su contraseña la definiste vos de forma segura — no está en el
 * repo ni la conozco. El equivalente automatizado de estos dos casos SÍ corre en
 * validate:inquiries (tests A, B y C), con login real de owner, solo que en un
 * tenant descartable en lugar del demo.
 *
 * Las consultas se crean por el camino real: form_submission →
 * confirm_submission_and_create_operation, la misma RPC que usa el cliente al
 * confirmar por WhatsApp. No se insertan operation_requests a mano.
 *
 * NO toca SUB-2AN6JL, SUB-BKSA5W ni SUB-3EATST, y lo verifica antes y después.
 *
 * Usage:
 *   pnpm --filter @orderflow/web fixture:inquiries-demo
 *   pnpm --filter @orderflow/web fixture:inquiries-demo -- --cleanup
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
const MARCA       = '[FIXTURE 3E-B1]'
const INTOCABLES  = ['SUB-2AN6JL', 'SUB-BKSA5W', 'SUB-3EATST']

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const cleanup = process.argv.includes('--cleanup')

  console.log(HR)
  console.log(`  Fixture de consultas — ${cleanup ? 'LIMPIEZA' : 'PREPARACIÓN'}`)
  console.log(`  target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)
  console.log(HR)

  const { data: tenant } = await admin
    .from('tenants').select('id, name, slug').eq('id', TENANT_DEMO).maybeSingle()
  if (!tenant) { console.error('  ✗ El tenant demo no existe en este proyecto.'); process.exit(1) }
  console.log(`  tenant: ${tenant.name} (${tenant.slug})`)

  async function snapshotHistorico(): Promise<string> {
    const { data } = await admin
      .from('form_submissions')
      .select('reference, status, confirmed_at, updated_at')
      .in('reference', INTOCABLES).order('reference')
    return JSON.stringify(data)
  }
  const antes = await snapshotHistorico()

  // Todo lo del fixture se reconoce por la marca en el payload.
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
        const { count: ops } = await admin.from('operation_requests')
          .delete({ count: 'exact' }).eq('source_submission_id', s.id)
        await admin.from('form_submissions').delete().eq('id', s.id)
        console.log(`  ✓ ${s.reference} (${s.intent}) borrada · operaciones: ${ops ?? 0}`)
      }
    }

    const despues = await snapshotHistorico()
    console.log(antes === despues
      ? '  ✓ evidencia histórica intacta (SUB-2AN6JL, SUB-BKSA5W, SUB-3EATST)'
      : '  ✗ LA EVIDENCIA HISTÓRICA CAMBIÓ')

    const { count: quedan } = await admin.from('form_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', TENANT_DEMO).contains('payload', { fixture: MARCA })
    console.log(`  fixtures remanentes: ${quedan ?? 0}`)
    console.log(HR)
    process.exit(antes === despues && (quedan ?? 0) === 0 ? 0 : 1)
  }

  // ── Preparación ───────────────────────────────────────────────────────────
  if (subs && subs.length > 0) {
    console.log(`  ya hay ${subs.length} consulta(s) de fixture; se reutilizan (--cleanup para borrarlas)`)
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
    {
      intent:  'property_inquiry' as const,
      payload: {
        fixture: MARCA,
        name:    'Ana Gómez',
        message: '¿La propiedad sigue disponible? ¿Acepta mascotas chicas?',
      },
    },
    {
      intent:  'monthly_rental_inquiry' as const,
      payload: {
        fixture:      MARCA,
        name:         'Bruno Díaz',
        move_in_date: new Date(Date.now() + 60 * 86_400_000).toISOString().split('T')[0]!,
        occupants:    3,
        notes:        'Tengo garantía propietaria.',
      },
    },
  ]

  const creadas: { reference: string; intent: string; opId: string }[] = []

  for (const caso of CASOS) {
    const yaExiste = subs?.some((s) => s.intent === caso.intent && s.status !== 'expired')
    if (yaExiste) {
      console.log(`  ${caso.intent}: ya existe, no se duplica`)
      continue
    }

    const reference = generateSubmissionReference()
    const { data: sub, error: se } = await admin.from('form_submissions').insert({
      tenant_id: TENANT_DEMO, reference,
      intent: caso.intent, status: 'submitted', source: 'public_site',
      payload: caso.payload as never, idempotency_key: randomUUID(),
      contact_id: contact.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      entity_type: 'property', entity_id: prop.id,
    } as never).select('id').single()
    if (se || !sub) { console.error(`  ✗ submission ${caso.intent}: ${se?.message}`); process.exit(1) }

    // Camino real: la misma RPC que corre cuando el cliente confirma por WhatsApp.
    const { data: rpc, error: re } = await admin.rpc('confirm_submission_and_create_operation', {
      p_submission_id: sub.id, p_tenant_id: TENANT_DEMO,
      p_contact_id: contact.id, p_conversation_id: undefined,
    })
    if (re) { console.error(`  ✗ confirm ${caso.intent}: ${re.message}`); process.exit(1) }
    const opId = (rpc as { operation_id?: string } | null)?.operation_id ?? ''

    creadas.push({ reference, intent: caso.intent, opId })
    console.log(`  ✓ ${caso.intent} → ${reference} (operación pending)`)
  }

  const despues = await snapshotHistorico()

  console.log('')
  console.log(HR)
  console.log('  ESCENARIO LISTO')
  console.log(HR)
  console.log(`  contacto  : ${contact.name ?? contact.phone}`)
  console.log(`  propiedad : ${prop.title}`)
  for (const c of creadas) console.log(`  ${c.intent.padEnd(23)} ${c.reference}`)
  console.log('')
  console.log('  PASOS EN EL NAVEGADOR (owner.demo@reservanex.test)')
  console.log('  ──────────────────────────────────────────────────')
  console.log('  1. Dashboard → Solicitudes. Las dos consultas nuevas están en Pendientes.')
  console.log('     ESPERADO en la fila: "Consulta por propiedad" y "Consulta alquiler mensual"')
  console.log('     (no "Consulta" a secas), y en la mensual dos chips con')
  console.log('     "Fecha estimada de mudanza" y "¿Cuántas personas vivirían?".')
  console.log('  2. Abrí la consulta por propiedad.')
  console.log('     ESPERADO: el detalle muestra "Tu nombre" y "Tu consulta" con el texto,')
  console.log('     y los botones dicen "Descartar" y "Marcar como gestionada".')
  console.log('  3. Tocá "Marcar como gestionada".')
  console.log('     ESPERADO: el diálogo dice "Marcar la consulta como gestionada" y aclara')
  console.log('     que no se crea ninguna reserva. Al confirmar, el badge queda "Gestionada".')
  console.log('  4. Repetí con la consulta de alquiler mensual.')
  console.log('  5. (Opcional) Ajustes → Usuarios → permisos de una recepcionista:')
  console.log('     tiene que aparecer "Gestionar consultas".')
  console.log('')
  console.log('  AL TERMINAR:')
  console.log('    pnpm --filter @orderflow/web fixture:inquiries-demo -- --cleanup')
  console.log('')
  console.log(antes === despues
    ? '  ✓ evidencia histórica intacta (SUB-2AN6JL, SUB-BKSA5W, SUB-3EATST)'
    : '  ✗ LA EVIDENCIA HISTÓRICA CAMBIÓ')
  console.log(HR)
  process.exit(antes === despues ? 0 : 1)
}

main().catch((e) => {
  console.error('[fixture-inquiries-demo] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

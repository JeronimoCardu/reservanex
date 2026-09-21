/**
 * Onboarding multi-tipo + topes de plan + capacidades gastronómicas.
 *
 * Corre contra el proyecto real. Crea tenants temporales por el camino
 * productivo (repo.createTenant, el mismo que usa createPlatformTenantAction),
 * prueba los límites FÍSICAMENTE —incluida la concurrencia— y los purga con
 * purgeTenantWithStorage().
 *
 * Lo que se prueba acá y no se puede probar en un test unitario: que el tope lo
 * aplique la BASE. Contar en la app y después insertar es el patrón que dos
 * requests simultáneas rompen; lo único que lo impide es el trigger que bloquea
 * la fila del tenant. Por eso los casos de concurrencia lanzan las inserciones
 * con Promise.all de verdad.
 *
 * Uso:  pnpm --filter @orderflow/web validate:tenant-kinds
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes, randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import {
  mappingForTenantKind,
  planLimitsForTenantKind,
  foodCapabilitiesFrom,
  tenantKindFrom,
  DEFAULT_FOOD_CAPABILITIES,
  type TenantKind,
  type FoodCapabilities,
} from '@orderflow/validators'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import * as repo from '../src/lib/repositories/platform.repository'
import { purgeTenantWithStorage } from '../src/lib/repositories/tenant-storage.repository'
import { tenantLimitMessage } from '../src/lib/tenant-limits'
import { deriveAutoResponderStatus } from '../src/lib/autoresponder-platform'
import { deriveDeviceStatus } from '../src/lib/autoresponder-device-health'
import { deriveTenantSetupChecklist } from '../src/lib/tenant-setup-status'

const HR = '─'.repeat(78)
let passed = 0
let failed = 0
function ok(s: string): void { console.log(`  ✓ ${s}`); passed++ }
function nok(s: string, detalle?: string): void {
  console.error(`  ✗ ${s}`)
  if (detalle) console.error(`      ${detalle}`)
  failed++
}

const RUN = `${Date.now()}`
const creados: string[] = []

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — onboarding multi-tipo, topes y capacidades')
  console.log(HR)

  assertSafeSupabaseTarget()
  const admin = createAdminClient()

  /** Alta por el camino productivo: la misma función que llama la server action. */
  async function crear(kind: TenantKind, caps?: FoodCapabilities) {
    const { vertical, clientType } = mappingForTenantKind(kind)
    const slug = `test-kind-${kind.replace('_', '-')}-${RUN}-${randomBytes(2).toString('hex')}`
    const t = await repo.createTenant({
      name: `[TEST] ${kind} ${RUN}`, slug,
      country: 'AR', language: 'es', currency: 'ARS',
      timezone: 'America/Argentina/Buenos_Aires',
      activate_immediately: true,
      onboarding_notes: null,
      primary_owner_name: 'Owner prueba',
      primary_owner_email: `owner-${slug}@example.test`,
      primary_owner_phone: null,
      assigned_seller_id: null, created_by_seller_id: null,
      vertical, client_type: clientType,
      limits: planLimitsForTenantKind(kind),
      capabilities: kind === 'food_business' ? (caps ?? DEFAULT_FOOD_CAPABILITIES) : null,
    })
    creados.push(t.id)
    return t
  }

  async function fila(id: string) {
    const { data } = await admin.from('tenants').select('*').eq('id', id).single()
    return data as Record<string, unknown>
  }

  try {
    // ══ A. Los tres tipos persisten como corresponde ═══════════════════════
    console.log('\n  A · Persistencia de los tres tipos\n')

    const agency  = await crear('agency')
    const partic  = await crear('private_owner')
    const gastro  = await crear('food_business', { delivery: true, takeaway: false, tableReservations: true })

    const fA = await fila(agency.id)
    const fP = await fila(partic.id)
    const fG = await fila(gastro.id)

    if (fA.vertical === 'real_estate' && fA.client_type === 'agency') {
      ok('28. agency → vertical=real_estate, client_type=agency')
    } else nok('28. agency mal persistida', JSON.stringify({ v: fA.vertical, c: fA.client_type }))

    if (fP.vertical === 'real_estate' && fP.client_type === 'private_owner') {
      ok('28. private_owner → vertical=real_estate, client_type=private_owner')
    } else nok('28. private_owner mal persistido', JSON.stringify({ v: fP.vertical, c: fP.client_type }))

    if (fG.vertical === 'food_service' && fG.client_type === null) {
      ok('28. gastronomía → vertical=food_service, client_type=NULL')
    } else nok('28. gastronomía mal persistida', JSON.stringify({ v: fG.vertical, c: fG.client_type }))

    // ── Topes ────────────────────────────────────────────────────────────
    if (fP.max_properties === 5 && fP.max_users === 3 && fP.max_owners === 1 && fP.max_receptionists === 2) {
      ok('29. particular nace con 5 propiedades / 3 usuarios / 1 owner / 2 agentes')
    } else nok('29. topes del particular', JSON.stringify(fP.max_properties))

    if (fA.max_properties === null && fA.max_users === null) {
      ok('29. agency nace SIN topes (NULL = sin límite)')
    } else nok('29. la agency heredó topes', JSON.stringify({ p: fA.max_properties, u: fA.max_users }))

    // ── Capacidades ──────────────────────────────────────────────────────
    const capsG = foodCapabilitiesFrom(fG)
    if (capsG.delivery && !capsG.takeaway && capsG.tableReservations) {
      ok('30. las capacidades elegidas en el alta se guardan tal cual')
    } else nok('30. capacidades mal guardadas', JSON.stringify(capsG))

    // ── El CHECK de coherencia ───────────────────────────────────────────
    const { error: eIncoherente } = await admin.from('tenants')
      .update({ client_type: 'agency' } as never).eq('id', gastro.id)
    if (eIncoherente) {
      ok('la base rechaza (food_service + agency): el par incoherente no puede existir')
    } else {
      nok('el CHECK de coherencia no actuó')
      await admin.from('tenants').update({ client_type: null } as never).eq('id', gastro.id)
    }

    const { error: eSinTipo } = await admin.from('tenants')
      .update({ client_type: null } as never).eq('id', agency.id)
    if (eSinTipo) ok('y rechaza un real_estate sin client_type')
    else nok('un real_estate quedó sin client_type')

    // ══ B. Tope de propiedades del particular ══════════════════════════════
    console.log('\n  B · Tope de propiedades (particular)\n')

    async function nuevaPropiedad(tenantId: string, n: number) {
      return admin.from('properties').insert({
        tenant_id: tenantId, title: `[TEST] Prop ${n} ${RUN}`, city: 'CABA',
        published: true, operation_type: 'sale', pricing_mode: 'consult', currency: 'ARS',
      } as never).select('id').single()
    }

    let creadas = 0
    for (let i = 1; i <= 5; i++) {
      const { error } = await nuevaPropiedad(partic.id, i)
      if (!error) creadas++
      else nok(`29. la propiedad ${i} debería haber entrado`, error.message)
    }
    if (creadas === 5) ok('29. 1..5 propiedades entran sin problema')

    const { error: eSexta } = await nuevaPropiedad(partic.id, 6)
    if (eSexta && tenantLimitMessage(eSexta)) {
      ok(`29. la sexta se rechaza con error de dominio: "${tenantLimitMessage(eSexta)}"`)
    } else nok('29. la sexta propiedad NO fue rechazada', eSexta?.message ?? '(entró)')

    const { count: tras6 } = await admin.from('properties')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', partic.id).is('deleted_at', null)
    if (tras6 === 5) ok('29. y no quedó una propiedad a medias: siguen siendo 5')
    else nok('29. el conteo quedó mal', `hay ${tras6}`)

    // ── Concurrencia real ────────────────────────────────────────────────
    const partic2 = await crear('private_owner')
    for (let i = 1; i <= 4; i++) await nuevaPropiedad(partic2.id, i)

    // Cuatro cargadas, dos intentos SIMULTÁNEOS por el quinto y el sexto lugar.
    const carrera = await Promise.all([
      nuevaPropiedad(partic2.id, 90),
      nuevaPropiedad(partic2.id, 91),
      nuevaPropiedad(partic2.id, 92),
    ])
    const entraron = carrera.filter((r) => !r.error).length
    const { count: finales } = await admin.from('properties')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', partic2.id).is('deleted_at', null)

    if (finales === 5 && entraron === 1) {
      ok('4 y 29. concurrencia: 3 inserciones simultáneas sobre 4 ocupadas → entró 1, quedaron 5')
    } else {
      nok('4. la concurrencia superó el tope', `entraron=${entraron} total=${finales}`)
    }

    // ── El archivado libera cupo, restaurar lo vuelve a consumir ──────────
    const { data: unaProp } = await admin.from('properties')
      .select('id').eq('tenant_id', partic.id).is('deleted_at', null).limit(1).single()
    await admin.from('properties')
      .update({ deleted_at: new Date().toISOString() } as never).eq('id', unaProp!.id)

    const { error: eTrasArchivar } = await nuevaPropiedad(partic.id, 7)
    if (!eTrasArchivar) ok('3A. una propiedad archivada no ocupa lugar: la siguiente entra')
    else nok('3A. archivar no liberó cupo', eTrasArchivar.message)

    const { error: eRestaurar } = await admin.from('properties')
      .update({ deleted_at: null } as never).eq('id', unaProp!.id)
    if (eRestaurar && tenantLimitMessage(eRestaurar)) {
      ok('3A. y desarchivar por encima del tope se rechaza: el límite no se esquiva')
    } else nok('3A. se pudo desarchivar por encima del tope', eRestaurar?.message ?? '(pasó)')

    // ══ C. Tope de usuarios del particular ═════════════════════════════════
    console.log('\n  C · Tope de usuarios (particular)\n')

    const authIds: string[] = []
    async function nuevoUsuario(tenantId: string, rol: 'owner' | 'receptionist', n: number) {
      const email = `u${n}-${tenantId.slice(0, 8)}-${RUN}@example.test`
      const { data: au } = await admin.auth.admin.createUser({
        email, password: randomBytes(18).toString('hex'), email_confirm: true,
      })
      if (au?.user) authIds.push(au.user.id)
      const res = await admin.from('tenant_users').insert({
        id: au!.user!.id, tenant_id: tenantId, name: `U${n}`, email, role: rol, active: true,
      } as never).select('id').single()
      // Si el tenant_users no entró, el auth user no debe quedar huérfano.
      if (res.error && au?.user) {
        await admin.auth.admin.deleteUser(au.user.id).catch(() => {})
        authIds.splice(authIds.indexOf(au.user.id), 1)
      }
      return res
    }

    const partic3 = await crear('private_owner')
    const u1 = await nuevoUsuario(partic3.id, 'owner', 1)
    const u2 = await nuevoUsuario(partic3.id, 'receptionist', 2)
    const u3 = await nuevoUsuario(partic3.id, 'receptionist', 3)

    if (!u1.error && !u2.error && !u3.error) ok('29. owner + 2 agentes entran')
    else nok('29. los tres primeros usuarios deberían entrar', u1.error?.message ?? u2.error?.message ?? u3.error?.message)

    const u4 = await nuevoUsuario(partic3.id, 'receptionist', 4)
    if (u4.error && tenantLimitMessage(u4.error)) {
      ok(`29. el cuarto se rechaza: "${tenantLimitMessage(u4.error)}"`)
    } else nok('29. el cuarto usuario NO fue rechazado', u4.error?.message ?? '(entró)')

    const segundoOwner = await nuevoUsuario(partic3.id, 'owner', 5)
    if (segundoOwner.error && tenantLimitMessage(segundoOwner.error)) {
      ok('29. y un segundo owner también: max_owners = 1')
    } else nok('29. entró un segundo owner', segundoOwner.error?.message ?? '(entró)')

    const { count: usuariosFinales } = await admin.from('tenant_users')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', partic3.id).eq('active', true)
    if (usuariosFinales === 3) ok('29. quedaron exactamente 3 usuarios activos')
    else nok('29. conteo de usuarios', `hay ${usuariosFinales}`)

    // ── Concurrencia de usuarios ─────────────────────────────────────────
    const partic4 = await crear('private_owner')
    await nuevoUsuario(partic4.id, 'owner', 10)
    await nuevoUsuario(partic4.id, 'receptionist', 11)

    const carreraU = await Promise.all([
      nuevoUsuario(partic4.id, 'receptionist', 20),
      nuevoUsuario(partic4.id, 'receptionist', 21),
      nuevoUsuario(partic4.id, 'receptionist', 22),
    ])
    const entraronU = carreraU.filter((r) => !r.error).length
    const { count: totalU } = await admin.from('tenant_users')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', partic4.id).eq('active', true)

    if (totalU === 3 && entraronU === 1) {
      ok('4 y 29. concurrencia de usuarios: 3 simultáneos sobre 2 ocupados → entró 1, quedaron 3')
    } else nok('4. la concurrencia superó el tope de usuarios', `entraron=${entraronU} total=${totalU}`)

    // ══ D. Agency NO hereda los topes ══════════════════════════════════════
    console.log('\n  D · Agency sin topes\n')

    let agencyProps = 0
    for (let i = 1; i <= 7; i++) {
      const { error } = await nuevaPropiedad(agency.id, i)
      if (!error) agencyProps++
    }
    if (agencyProps === 7) ok('29. una agency carga 7 propiedades sin toparse (y seguiría)')
    else nok('29. la agency se topó', `entraron ${agencyProps}`)

    let agencyUsers = 0
    for (let i = 1; i <= 6; i++) {
      const rol = i === 1 ? 'owner' : 'receptionist'
      const { error } = await nuevoUsuario(agency.id, rol as 'owner' | 'receptionist', 100 + i)
      if (!error) agencyUsers++
    }
    if (agencyUsers === 6) ok('29. y 6 usuarios, por encima del viejo tope de 5 del plan starter')
    else nok('29. la agency se topó en usuarios', `entraron ${agencyUsers}`)

    // ══ E. Cambiar capacidades después ═════════════════════════════════════
    console.log('\n  E · Cambio posterior de capacidades\n')

    await admin.from('tenants').update({ delivery_enabled: false } as never).eq('id', gastro.id)
    const capsTras = foodCapabilitiesFrom(await fila(gastro.id))
    if (!capsTras.delivery && capsTras.tableReservations) {
      ok('31. apagar delivery no toca las otras capacidades')
    } else nok('31. el cambio afectó a otras', JSON.stringify(capsTras))

    await admin.from('tenants')
      .update({ delivery_enabled: true, takeaway_enabled: true } as never).eq('id', gastro.id)
    const capsVuelta = foodCapabilitiesFrom(await fila(gastro.id))
    if (capsVuelta.delivery && capsVuelta.takeaway) ok('31. volver a encenderlas restituye la funcionalidad')
    else nok('31. no se pudo volver a encender', JSON.stringify(capsVuelta))

    // ══ G. Readiness de la ficha, por tipo ═════════════════════════════════
    //
    // El MISMO camino que usa /platform/tenants/[id]: getTenantSetupSignals +
    // deriveTenantSetupChecklist con el rubro del tenant. No se simula nada.
    console.log('\n  G · Readiness de la ficha por tipo\n')

    async function readiness(tenantId: string) {
      const t = await repo.getTenantById(tenantId)
      if (!t) throw new Error('readiness: tenant no encontrado')
      const s = await repo.getTenantSetupSignals(tenantId)
      const whatsappStatus = deriveAutoResponderStatus(
        s.whatsapp ? {
          phone_number: s.whatsapp.phone_number, active: s.whatsapp.active,
          has_device_token: s.whatsapp.has_device_token,
        } : null,
      )
      const deviceStatus = deriveDeviceStatus({ configStatus: whatsappStatus, lastDeviceSeenAt: s.lastDeviceSeenAt })
      return deriveTenantSetupChecklist({
        kind: tenantKindFrom(t.vertical, t.client_type),
        tenantActive: t.status === 'trial' || t.status === 'active',
        ownerActive: s.ownerActive, aiConfigured: s.aiConfigured,
        whatsappStatus, deviceStatus, lastDeviceSeenAt: s.lastDeviceSeenAt,
        publishedPropertyCount: s.publishedPropertyCount,
        publishedMenuItemCount: s.publishedMenuItemCount,
      })
    }

    // Gastronomía: el catálogo es el menú, y las 7 propiedades de la agency
    // de arriba no le sirven a nadie más.
    const rG0 = await readiness(gastro.id)
    if (rG0.catalogTitle === 'Menú' && !rG0.catalog.ok && rG0.catalog.label === 'Sin productos publicados') {
      ok('3. gastronomía: el checklist pide Menú, no Propiedades')
    } else nok('3. gastronomía pide lo que no corresponde', JSON.stringify({ t: rG0.catalogTitle, l: rG0.catalog.label }))

    if (!/propiedad/i.test([rG0.catalogTitle, rG0.catalog.label, rG0.catalogHint, rG0.tenant.label].join(' '))) {
      ok('12. y ninguna línea del checklist gastronómico nombra propiedades')
    } else nok('12. el checklist gastronómico nombra propiedades')

    // Un producto publicado y el catálogo queda cumplido.
    const { data: catG } = await admin.from('menu_categories')
      .insert({ tenant_id: gastro.id, name: 'Pizzas' } as never).select('id').single()
    await admin.from('menu_items').insert({
      tenant_id: gastro.id, category_id: catG!.id, name: 'Muzzarella',
      base_price: 10000, published: true, available: true,
    } as never)
    const rG1 = await readiness(gastro.id)
    if (rG1.catalog.ok && rG1.catalog.label === '1 producto publicado') {
      ok('3. con un producto publicado el renglón de Menú se cumple')
    } else nok('3. el producto publicado no cumplió el catálogo', JSON.stringify(rG1.catalog))

    // Con D=0 T=0 R=0 el catálogo sigue cumplido: las capacidades no entran.
    await admin.from('tenants').update({
      delivery_enabled: false, takeaway_enabled: false, table_reservations_enabled: false,
    } as never).eq('id', gastro.id)
    const rG2 = await readiness(gastro.id)
    if (rG2.catalog.ok) ok('3 y 14. con D=0 T=0 R=0 el readiness no cambia: las capacidades no son requisito')
    else nok('3. apagar las capacidades rompió el readiness', JSON.stringify(rG2.catalog))

    // El resto de lo que falta es lo COMPARTIDO, no propiedades.
    if (rG2.state === 'not_started' || rG2.state === 'setup_incomplete') {
      ok(`3. lo que le falta a la gastronomía es lo compartido (owner/WhatsApp): estado=${rG2.state}`)
    } else nok('3. estado inesperado para gastronomía sin owner', rG2.state)

    // Inmobiliario: propiedades, y el menú no cuenta.
    const rA = await readiness(agency.id)
    if (rA.catalogTitle === 'Propiedades' && rA.catalog.ok && rA.catalog.label === '7 propiedades publicadas') {
      ok('14. agency: el catálogo son sus 7 propiedades publicadas')
    } else nok('14. agency catálogo', JSON.stringify({ t: rA.catalogTitle, l: rA.catalog.label }))

    const rP = await readiness(partic.id)
    if (rP.catalogTitle === 'Propiedades' && rP.catalog.ok) {
      ok('14. private_owner: el catálogo también son propiedades, y las suyas cuentan')
    } else nok('14. private_owner catálogo', JSON.stringify({ t: rP.catalogTitle, l: rP.catalog.label }))

    // El owner PROSPECTO no cuenta como owner activo. Los tres tienen
    // primary_owner_email cargado; private_owner y food NO tienen tenant_users
    // owner, y la agency SÍ (la sección D le creó uno real). Las dos
    // direcciones a la vez: el mail anotado no cuenta, la membresía sí.
    for (const [nombre, r] of [['private_owner', rP], ['food', rG2]] as const) {
      if (!r.owner.ok) ok(`7. ${nombre}: primary_owner_email cargado pero sin owner activo → checklist ✗ (correcto)`)
      else nok(`7. ${nombre}: el prospecto se contó como owner activo`)
    }
    if (rA.owner.ok) ok('7. agency: con un tenant_users owner real el checklist sí lo marca ✓')
    else nok('7. agency: tiene owner real y el checklist no lo ve')

    // Y el conteo que usa la tarjeta de límites, con el mismo criterio que el trigger.
    const nProps = await repo.countActiveProperties(partic.id)
    const { count: nPropsDB } = await admin.from('properties')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', partic.id).is('deleted_at', null)
    if (nProps === nPropsDB) ok(`10. countActiveProperties coincide con la base: ${nProps} vigentes`)
    else nok('10. countActiveProperties difiere de la base', `${nProps} vs ${nPropsDB}`)

    // ══ F. Purge productivo de todos ═══════════════════════════════════════
    console.log('\n  F · Purge productivo\n')

    for (const uid of authIds) await admin.auth.admin.deleteUser(uid).catch(() => {})

    let purgados = 0
    for (const id of creados) {
      const r = await purgeTenantWithStorage(id)
      if (!r.dbError) purgados++
      else nok(`el purge falló para ${id}`, r.dbError)
    }
    if (purgados === creados.length) {
      ok(`32. los ${creados.length} tenants temporales se purgaron con el mecanismo productivo`)
    }

    const { count: restantes } = await admin.from('tenants')
      .select('id', { count: 'exact', head: true }).like('name', '[TEST]%')
    if ((restantes ?? 0) === 0) ok('32. 0 [TEST] restantes')
    else nok('32. quedaron tenants de prueba', `${restantes}`)

  } catch (err) {
    nok('fatal', err instanceof Error ? err.message : String(err))
  } finally {
    // Red de seguridad: lo que no se haya purgado arriba se purga acá.
    for (const id of creados) {
      const { data } = await admin.from('tenants').select('id').eq('id', id).maybeSingle()
      if (data) await purgeTenantWithStorage(id).catch(() => {})
    }
    const { data: sobras } = await admin.from('tenant_users').select('id').like('email', '%@example.test')
    for (const u of sobras ?? []) await admin.auth.admin.deleteUser(u.id).catch(() => {})
  }

  console.log(`\n${HR}`)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n  [validate-tenant-kinds] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

/**
 * Fase 3E-C3A1 §24 — escenario para la prueba de navegador del catálogo.
 *
 * Crea un tenant food_service descartable con su owner, y nada más: la carta la
 * vas a cargar vos desde /dashboard/menu, que es justamente lo que hay que
 * probar. El script NO siembra categorías ni productos.
 *
 * Reutiliza la misma identidad de tenant que el fixture de 3E-C2
 * ([DEMO] Gastronomía QA / demo-gastronomia / food_service), que es la que ya
 * está en la lista blanca de setup:demo-owner --reset-link. Así el owner puede
 * recuperar su acceso por el camino normal.
 *
 * SOBRE LA CONTRASEÑA: el script NO inventa ni imprime ninguna. Crea los
 * usuarios y te dice cómo establecerla vos de forma segura.
 *
 * NO toca el tenant demo inmobiliario ni SUB-2AN6JL / SUB-BKSA5W / SUB-3EATST,
 * y lo verifica antes y después.
 *
 * Usage:
 *   pnpm --filter @orderflow/web fixture:menu-demo
 *   pnpm --filter @orderflow/web fixture:menu-demo -- --cleanup
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'

const HR = '─'.repeat(78)

const SLUG        = 'demo-gastronomia'
const NOMBRE      = '[DEMO] Gastronomía QA'
const VERTICAL    = 'food_service'
const OWNER_EMAIL = 'owner.gastro@reservanex.test'
const RECEP_EMAIL = 'recep.gastro@reservanex.test'
const INTOCABLES  = ['SUB-2AN6JL', 'SUB-BKSA5W', 'SUB-3EATST']
const DEMO_INMOB  = 'ace547bb-3a72-4ed6-8ff5-de49d001cd68'

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const cleanup = process.argv.includes('--cleanup')

  console.log(HR)
  console.log(`  Fixture del catálogo gastronómico — ${cleanup ? 'LIMPIEZA' : 'PREPARACIÓN'}`)
  console.log(`  target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)
  console.log(HR)

  /** Huella de lo que NO se puede tocar. Se compara antes y después. */
  async function snapshotHistorico(): Promise<string> {
    const { data } = await admin
      .from('form_submissions')
      .select('reference, status, confirmed_at, updated_at')
      .in('reference', INTOCABLES).order('reference')
    const { count: subs } = await admin.from('form_submissions')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', DEMO_INMOB)
    const { count: ops } = await admin.from('operation_requests')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', DEMO_INMOB)
    const { count: res } = await admin.from('reservations')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', DEMO_INMOB)
    return JSON.stringify({ data, subs, ops, res })
  }
  const antes = await snapshotHistorico()

  const { data: existente } = await admin.from('tenants')
    .select('id, name, slug, vertical').eq('slug', SLUG).maybeSingle()

  // ── Limpieza ──────────────────────────────────────────────────────────────
  if (cleanup) {
    if (!existente) {
      console.log('  no hay tenant de fixture para borrar')
    } else {
      // Guarda dura: la TERNA completa tiene que coincidir. Un slug que casualmente
      // coincidiera con el de un tenant real no alcanza para borrarlo.
      if (existente.name !== NOMBRE || existente.vertical !== VERTICAL || existente.slug !== SLUG) {
        console.error('  ✗ ABORTADO: el tenant no coincide con lo esperado.')
        console.error(`    esperado: name="${NOMBRE}" slug="${SLUG}" vertical="${VERTICAL}"`)
        console.error(`    encontrado: ${JSON.stringify(existente)}`)
        process.exitCode = 1
        return
      }

      const { data: users } = await admin.from('tenant_users')
        .select('id, email').eq('tenant_id', existente.id)

      // Orden importante: items antes que categorías, porque category_id es
      // ON DELETE RESTRICT y borrar la categoría primero fallaría.
      for (const tb of ['menu_items', 'menu_categories', 'table_reservations', 'operation_requests', 'notes', 'tasks'] as const) {
        const { count, error } = await admin.from(tb).delete({ count: 'exact' }).eq('tenant_id', existente.id)
        if (error) console.error(`  ✗ ${tb}: ${error.message}`)
        else if ((count ?? 0) > 0) console.log(`  ✓ ${tb}: ${count}`)
      }

      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: existente.id }) } catch { /* noop */ }
      await admin.from('tenants').delete().eq('id', existente.id)

      // Solo los usuarios de ESTE tenant, y solo los del fixture.
      let borrados = 0
      for (const u of users ?? []) {
        if (u.email !== OWNER_EMAIL && u.email !== RECEP_EMAIL) {
          console.log(`  ! usuario ajeno al fixture, NO se borra: ${u.email}`)
          continue
        }
        try { await admin.auth.admin.deleteUser(u.id); borrados++ } catch { /* noop */ }
      }
      console.log(`  ✓ tenant borrado · usuarios auth borrados: ${borrados}`)
    }

    // ── Verificación post-limpieza ──────────────────────────────────────────
    const despues = await snapshotHistorico()
    const historicoOk = antes === despues
    console.log(historicoOk
      ? '  ✓ evidencia histórica y tenant inmobiliario intactos'
      : '  ✗ ALGO DEL TENANT INMOBILIARIO CAMBIÓ')

    const { count: cats }  = await admin.from('menu_categories').select('id', { count: 'exact', head: true })
    const { count: items } = await admin.from('menu_items').select('id', { count: 'exact', head: true })
    const { count: food }  = await admin.from('tenants')
      .select('id', { count: 'exact', head: true }).eq('vertical', VERTICAL)

    // Huérfanos: filas de catálogo cuyo tenant ya no existe. Las FK con
    // ON DELETE CASCADE lo hacen imposible, pero se comprueba igual — es la
    // clase de cosa que uno cree que está garantizada hasta que no lo está.
    const { data: tenantsVivos } = await admin.from('tenants').select('id')
    const idsVivos = new Set((tenantsVivos ?? []).map((t) => t.id))
    const { data: catsTodas }  = await admin.from('menu_categories').select('id, tenant_id')
    const { data: itemsTodos } = await admin.from('menu_items').select('id, tenant_id, category_id')
    const catsHuerfanas  = (catsTodas ?? []).filter((c) => !idsVivos.has(c.tenant_id))
    const itemsHuerfanos = (itemsTodos ?? []).filter((i) => !idsVivos.has(i.tenant_id))

    // Y items apuntando a una categoría inexistente (lo impide la FK, se verifica).
    const idsCats = new Set((catsTodas ?? []).map((c) => c.id))
    const itemsSinCategoria = (itemsTodos ?? []).filter((i) => !idsCats.has(i.category_id))

    const sinHuerfanos =
      catsHuerfanas.length === 0 && itemsHuerfanos.length === 0 && itemsSinCategoria.length === 0

    console.log(`  categorías: ${cats ?? 0} · productos: ${items ?? 0} · tenants ${VERTICAL}: ${food ?? 0}`)
    console.log(sinHuerfanos
      ? '  ✓ 0 huérfanos (ni categorías ni productos sin tenant, ni productos sin categoría)'
      : `  ✗ huérfanos: cats=${catsHuerfanas.length} items=${itemsHuerfanos.length} sinCat=${itemsSinCategoria.length}`)

    console.log(HR)
    process.exitCode = historicoOk && sinHuerfanos && (food ?? 0) === 0 ? 0 : 1
    return
  }

  // ── Preparación ───────────────────────────────────────────────────────────
  let tenantId = existente?.id ?? ''

  if (!tenantId) {
    const { data: t, error } = await admin.from('tenants').insert({
      name: NOMBRE, slug: SLUG, status: 'active',
      vertical: VERTICAL,
      timezone: 'America/Argentina/Buenos_Aires',
      currency: 'ARS',
      public_slug: SLUG, public_name: 'Gastronomía QA',
    } as never).select('id').single()
    if (error || !t) { console.error(`  ✗ tenant: ${error?.message}`); process.exitCode = 1; return }
    tenantId = t.id
    console.log(`  ✓ tenant ${VERTICAL} creado (moneda ARS, zona Buenos Aires)`)
  } else {
    if (existente!.name !== NOMBRE || existente!.vertical !== VERTICAL) {
      console.error('  ✗ ABORTADO: ya existe un tenant con ese slug que no es el del fixture.')
      console.error(`    ${JSON.stringify(existente)}`)
      process.exitCode = 1
      return
    }
    console.log('  ya existe el tenant de fixture; se reutiliza')
  }

  /** Crea el usuario si falta. NUNCA genera ni imprime una contraseña. */
  async function asegurarUsuario(
    email: string, nombre: string, role: 'owner' | 'receptionist',
    permisos: Record<string, boolean> = {},
  ): Promise<boolean> {
    const { data: ya } = await admin.from('tenant_users')
      .select('id').eq('tenant_id', tenantId).eq('email', email).maybeSingle()
    if (ya) return false

    const { data: au, error: ae } = await admin.auth.admin.createUser({ email, email_confirm: true })
    if (ae || !au.user) { console.error(`  ✗ ${email}: ${ae?.message}`); process.exitCode = 1; return false }

    const { error: tue } = await admin.from('tenant_users').insert({
      id: au.user.id, tenant_id: tenantId, name: nombre, email, role, active: true,
      ...permisos,
    } as never)
    if (tue) { console.error(`  ✗ tenant_users ${email}: ${tue.message}`); process.exitCode = 1; return false }
    return true
  }

  const ownerNuevo = await asegurarUsuario(OWNER_EMAIL, 'Owner Gastro', 'owner')
  if (ownerNuevo) console.log('  ✓ owner creado (sin contraseña — ver abajo)')
  else console.log('  el owner ya existía; no se toca')

  // Recepcionista SIN can_manage_menu: sirve para comprobar en el navegador que
  // ve la carta y no puede editarla. Es opcional para la prueba manual.
  //
  // Los permisos que NO se listan acá quedan en el default de la columna, igual
  // que en producción (createTenantUser omite todas las can_*). Desde
  // 20260917000004 eso significa TODO en false, incluido can_confirm_reservations
  // —que hasta esa migración nacía en true y le daba a cualquier recepcionista
  // gastronómica la capacidad de confirmar un order_request sin que nadie se la
  // hubiera concedido.
  //
  // Ojo con una fila que venga de una corrida anterior: este script no la
  // modifica, así que puede seguir teniendo el true legacy. Eso no es un bug —
  // es lo que permite ver en el navegador el caso "permiso fuera de rubro
  // concedido → sigue visible para poder apagarlo".
  const recepNuevo = await asegurarUsuario(
    RECEP_EMAIL, 'Recep Gastro', 'receptionist',
    { can_manage_menu: false, can_manage_table_reservations: true },
  )
  if (recepNuevo) console.log('  ✓ recepcionista creada SIN can_manage_menu (opcional, para probar solo-lectura)')

  const { count: cats }  = await admin.from('menu_categories')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
  const { count: items } = await admin.from('menu_items')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)

  const despues = await snapshotHistorico()

  console.log(`\n${HR}`)
  console.log('  LISTO')
  console.log(HR)
  console.log(`  tenant        ${NOMBRE}  (${VERTICAL})`)
  console.log(`  catálogo      ${cats ?? 0} categorías · ${items ?? 0} productos`)
  console.log('                (a propósito vacío: la carta se carga desde el navegador)')
  console.log(`  owner         ${OWNER_EMAIL}`)
  console.log(`  recepcionista ${RECEP_EMAIL}  (sin can_manage_menu)`)
  console.log(HR)

  if (ownerNuevo || recepNuevo) {
    console.log('  CONTRASEÑA — el script no define ninguna. Dos caminos seguros:')
    console.log('')
    console.log(`    a) pnpm --filter @orderflow/web setup:demo-owner ${OWNER_EMAIL} --reset-link`)
    console.log('       (genera un link de recuperación de un solo uso y lo imprime en tu terminal)')
    console.log('')
    console.log('    b) Supabase Studio → Authentication → Users → el usuario → Reset password')
    console.log('')
    console.log('  Para la recepcionista, el camino b) — el --reset-link es solo para owners.')
    console.log(HR)
  }

  console.log('  QUÉ PROBAR')
  console.log('    /dashboard/menu   crear Entradas, Pizzas, Bebidas')
  console.log('                      intentar " bebidas " con Bebidas ya creada → debe rechazarse')
  console.log('                      productos: Empanada de carne 1500 · Pizza Muzzarella Chica 10000')
  console.log('                                 Pizza Muzzarella Grande 15000 · Agua 500ml 2000')
  console.log('                                 Pan de cortesía 0')
  console.log('                      editar · publicar · no disponible · reordenar')
  console.log('                      desactivar categoría · archivar · restaurar')
  console.log('    navegación        NO tienen que aparecer Propiedades, Reservas, Visitas')
  console.log('                      ni Alquileres mensuales (ni en escritorio ni en móvil)')
  console.log('    /dashboard/properties   escrita a mano → 404')
  console.log(HR)
  console.log(antes === despues
    ? '  ✓ evidencia histórica y tenant inmobiliario intactos'
    : '  ✗ ALGO DEL TENANT INMOBILIARIO CAMBIÓ')
  console.log(HR)
}

main().catch((e) => {
  console.error('[prepare-menu-demo-fixture] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

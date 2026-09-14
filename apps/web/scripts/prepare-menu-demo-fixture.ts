/**
 * Fase 3E-C3A2 §24 — escenario para la prueba de navegador del menú.
 *
 * Crea un tenant food_service descartable con su owner, una recepcionista y una
 * carta pensada para ejercitar TODOS los casos que el sitio público distingue:
 *
 *   Pizzas   (activa)    Muzzarella        publicado · disponible · CON foto
 *                        Napolitana        publicado · NO disponible · sin foto
 *                        Fugazzeta         BORRADOR  → no debe verse en público
 *   Bebidas  (activa)    Agua 500ml        publicado · disponible · CON foto
 *                        Gaseosa 1.5L      publicado · disponible · sin foto
 *   Entradas (activa)    Pan de cortesía   publicado · disponible · precio 0
 *   Postres  (INACTIVA)  Flan casero       publicado → no debe verse en público
 *
 * Las fotos son un PNG de color generado acá: es un marcador de posición
 * honesto, no una foto de stock bajada de ningún lado.
 *
 * SOBRE LA CONTRASEÑA: el script NO inventa ni imprime ninguna.
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

import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'

const HR = '─'.repeat(78)

const SLUG        = 'demo-gastronomia'
const NOMBRE      = '[DEMO] Gastronomía QA'
const VERTICAL    = 'food_service'
const OWNER_EMAIL = 'owner.gastro@reservanex.test'
const RECEP_EMAIL = 'recep.gastro@reservanex.test'
const BUCKET      = 'menu-images'
const INTOCABLES  = ['SUB-2AN6JL', 'SUB-BKSA5W', 'SUB-3EATST']
const DEMO_INMOB  = 'ace547bb-3a72-4ed6-8ff5-de49d001cd68'

// ── PNG sólido generado, sin dependencias ───────────────────────────────────
//
// Un marcador de posición de verdad: N×N de un color, comprimido como PNG
// válido. Sirve para ver la miniatura en la grilla y la foto en la carta sin
// bajar imágenes de ningún lado ni comprometer derechos de nadie.
function pngSolido(lado: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTabla = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTabla[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (tipo: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cuerpo))
    return Buffer.concat([len, cuerpo, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0  // 8-bit RGB

  // Cada fila lleva un byte de filtro (0) por delante de sus píxeles.
  const fila = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(lado).fill(Buffer.from([r, g, b])))])
  const bruto = Buffer.concat(Array(lado).fill(fila))

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(bruto)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

type ItemSeed = {
  nombre:      string
  descripcion: string | null
  precio:      string
  publicado:   boolean
  disponible:  boolean
  color:       [number, number, number] | null   // null = sin foto
}

const CARTA: { categoria: string; activa: boolean; items: ItemSeed[] }[] = [
  {
    categoria: 'Pizzas', activa: true,
    items: [
      { nombre: 'Muzzarella', descripcion: 'Salsa de tomate, muzzarella y orégano.', precio: '10000.00', publicado: true,  disponible: true,  color: [217, 119, 66] },
      { nombre: 'Napolitana', descripcion: 'Muzzarella, tomate en rodajas y ajo.',    precio: '12500.50', publicado: true,  disponible: false, color: null },
      { nombre: 'Fugazzeta',  descripcion: 'Cebolla y muzzarella. Todavía en prueba.', precio: '13000.00', publicado: false, disponible: true,  color: null },
    ],
  },
  {
    categoria: 'Bebidas', activa: true,
    items: [
      { nombre: 'Agua 500ml',   descripcion: 'Sin gas.',              precio: '2000.00', publicado: true, disponible: true, color: [80, 150, 200] },
      { nombre: 'Gaseosa 1.5L', descripcion: 'Línea Coca-Cola.',      precio: '3500.00', publicado: true, disponible: true, color: null },
    ],
  },
  {
    categoria: 'Entradas', activa: true,
    items: [
      { nombre: 'Pan de cortesía', descripcion: 'Con chimichurri de la casa.', precio: '0.00', publicado: true, disponible: true, color: null },
    ],
  },
  {
    categoria: 'Postres', activa: false,
    items: [
      { nombre: 'Flan casero', descripcion: 'Con dulce de leche.', precio: '4500.00', publicado: true, disponible: true, color: null },
    ],
  },
]

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const cleanup = process.argv.includes('--cleanup')

  console.log(HR)
  console.log(`  Fixture del menú gastronómico — ${cleanup ? 'LIMPIEZA' : 'PREPARACIÓN'}`)
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
      // Guarda dura: la TERNA completa tiene que coincidir.
      if (existente.name !== NOMBRE || existente.vertical !== VERTICAL || existente.slug !== SLUG) {
        console.error('  ✗ ABORTADO: el tenant no coincide con lo esperado.')
        console.error(`    esperado: name="${NOMBRE}" slug="${SLUG}" vertical="${VERTICAL}"`)
        console.error(`    encontrado: ${JSON.stringify(existente)}`)
        process.exitCode = 1
        return
      }

      const { data: users } = await admin.from('tenant_users')
        .select('id, email').eq('tenant_id', existente.id)

      // ── Storage PRIMERO ────────────────────────────────────────────────────
      // Storage NO tiene ON DELETE CASCADE: si los archivos no se borran acá,
      // sobreviven al tenant para siempre. Se listan por carpeta en vez de
      // confiar en las filas, así también caen los que quedaron sin referencia.
      const { data: objetos, error: eList } = await admin.storage
        .from(BUCKET).list(existente.id, { limit: 1000 })
      if (eList) console.error(`  ✗ no se pudo listar ${BUCKET}: ${eList.message}`)
      const paths = (objetos ?? []).map((o) => `${existente.id}/${o.name}`)
      if (paths.length > 0) {
        const { error } = await admin.storage.from(BUCKET).remove(paths)
        if (error) console.error(`  ✗ ${BUCKET}: ${error.message}`)
        else console.log(`  ✓ ${BUCKET}: ${paths.length} archivo(s)`)
      }

      // Orden importante: items antes que categorías (ON DELETE RESTRICT).
      for (const tb of ['menu_items', 'menu_categories', 'table_reservations', 'operation_requests', 'notes', 'tasks'] as const) {
        const { count, error } = await admin.from(tb).delete({ count: 'exact' }).eq('tenant_id', existente.id)
        if (error) console.error(`  ✗ ${tb}: ${error.message}`)
        else if ((count ?? 0) > 0) console.log(`  ✓ ${tb}: ${count}`)
      }

      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: existente.id }) } catch { /* noop */ }
      await admin.from('tenants').delete().eq('id', existente.id)

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

    const { data: tenantsVivos } = await admin.from('tenants').select('id')
    const idsVivos = new Set((tenantsVivos ?? []).map((t) => t.id))
    const { data: catsTodas }  = await admin.from('menu_categories').select('id, tenant_id')
    const { data: itemsTodos } = await admin.from('menu_items').select('id, tenant_id, category_id')
    const catsHuerfanas  = (catsTodas ?? []).filter((c) => !idsVivos.has(c.tenant_id))
    const itemsHuerfanos = (itemsTodos ?? []).filter((i) => !idsVivos.has(i.tenant_id))
    const idsCats = new Set((catsTodas ?? []).map((c) => c.id))
    const itemsSinCategoria = (itemsTodos ?? []).filter((i) => !idsCats.has(i.category_id))

    // Archivos que sobrevivieron a un tenant que ya no existe.
    const { data: carpetas } = await admin.storage.from(BUCKET).list('', { limit: 1000 })
    let archivosHuerfanos = 0
    for (const carpeta of carpetas ?? []) {
      if (idsVivos.has(carpeta.name)) continue
      const { data: objs } = await admin.storage.from(BUCKET).list(carpeta.name, { limit: 1000 })
      archivosHuerfanos += (objs ?? []).length
    }

    const sinHuerfanos =
      catsHuerfanas.length === 0 && itemsHuerfanos.length === 0 &&
      itemsSinCategoria.length === 0 && archivosHuerfanos === 0

    console.log(`  categorías: ${cats ?? 0} · productos: ${items ?? 0} · tenants ${VERTICAL}: ${food ?? 0}`)
    console.log(sinHuerfanos
      ? '  ✓ 0 huérfanos (ni filas sin tenant, ni productos sin categoría, ni archivos sin tenant)'
      : `  ✗ huérfanos: cats=${catsHuerfanas.length} items=${itemsHuerfanos.length} sinCat=${itemsSinCategoria.length} archivos=${archivosHuerfanos}`)

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
      // El sitio público tiene que estar PRENDIDO para poder verlo: es lo que
      // getPublicTenant() exige, igual que para una inmobiliaria.
      public_slug: SLUG,
      public_site_enabled: true,
      public_name: 'Gastronomía QA',
      public_description: 'Pizzas al molde y bebidas frías.',
    } as never).select('id').single()
    if (error || !t) { console.error(`  ✗ tenant: ${error?.message}`); process.exitCode = 1; return }
    tenantId = t.id
    console.log(`  ✓ tenant ${VERTICAL} creado (ARS · sitio público habilitado)`)
  } else {
    if (existente!.name !== NOMBRE || existente!.vertical !== VERTICAL) {
      console.error('  ✗ ABORTADO: ya existe un tenant con ese slug que no es el del fixture.')
      console.error(`    ${JSON.stringify(existente)}`)
      process.exitCode = 1
      return
    }
    // Se asegura que el sitio público esté habilitado también al reutilizarlo.
    await admin.from('tenants').update({
      public_slug: SLUG, public_site_enabled: true,
    } as never).eq('id', tenantId)
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

  // Recepcionista CON can_manage_menu: sirve para comprobar en el navegador que
  // el camino de permiso —no solo el de rol— administra la carta y sube fotos.
  //
  // Los permisos que NO se listan quedan en el default de la columna, igual que
  // en producción (createTenantUser omite todas las can_*).
  const recepNuevo = await asegurarUsuario(
    RECEP_EMAIL, 'Recep Gastro', 'receptionist',
    { can_manage_menu: true, can_manage_table_reservations: true },
  )
  if (recepNuevo) console.log('  ✓ recepcionista creada CON can_manage_menu')

  // ── Carta ─────────────────────────────────────────────────────────────────
  const { count: yaHay } = await admin.from('menu_categories')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)

  if ((yaHay ?? 0) > 0) {
    console.log('  ya hay catálogo cargado; no se toca')
  } else {
    let nCats = 0, nItems = 0, nFotos = 0

    for (const [ci, grupo] of CARTA.entries()) {
      const { data: cat, error: ec } = await admin.from('menu_categories').insert({
        tenant_id: tenantId, name: grupo.categoria, sort_order: ci, active: grupo.activa,
      } as never).select('id').single()
      if (ec || !cat) { console.error(`  ✗ categoría ${grupo.categoria}: ${ec?.message}`); process.exitCode = 1; return }
      nCats++

      for (const [ii, item] of grupo.items.entries()) {
        let imagen: { image_url: string; image_storage_path: string } | null = null

        if (item.color) {
          const path = `${tenantId}/${randomUUID()}.png`
          const bytes = pngSolido(320, item.color)
          const { error: eUp } = await admin.storage.from(BUCKET)
            .upload(path, bytes, { contentType: 'image/png', upsert: false })
          if (eUp) console.error(`  ! no se pudo subir la foto de ${item.nombre}: ${eUp.message}`)
          else {
            const { data: url } = admin.storage.from(BUCKET).getPublicUrl(path)
            imagen = { image_url: url.publicUrl, image_storage_path: path }
            nFotos++
          }
        }

        const { error: ei } = await admin.from('menu_items').insert({
          tenant_id: tenantId, category_id: cat.id,
          name: item.nombre, description: item.descripcion,
          base_price: item.precio,
          published: item.publicado, available: item.disponible,
          sort_order: ii,
          ...(imagen ?? {}),
        } as never)
        if (ei) { console.error(`  ✗ item ${item.nombre}: ${ei.message}`); process.exitCode = 1; return }
        nItems++
      }
    }
    console.log(`  ✓ carta cargada: ${nCats} categorías · ${nItems} productos · ${nFotos} con foto`)
  }

  const { count: cats }  = await admin.from('menu_categories')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
  const { count: items } = await admin.from('menu_items')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)

  const despues = await snapshotHistorico()

  console.log(`\n${HR}`)
  console.log('  LISTO')
  console.log(HR)
  console.log(`  tenant        ${NOMBRE}  (${VERTICAL} · ARS)`)
  console.log(`  catálogo      ${cats ?? 0} categorías · ${items ?? 0} productos`)
  console.log(`  owner         ${OWNER_EMAIL}`)
  console.log(`  recepcionista ${RECEP_EMAIL}  (con can_manage_menu)`)
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
  console.log('    /dashboard/menu          subir foto · reemplazar · quitar (menú ⋯)')
  console.log('                             la grilla sigue igual: buscar, filtrar, editar, guardar')
  console.log(`    /site/${SLUG}   la carta pública`)
  console.log('                             Pizzas · Bebidas · Entradas  (Postres NO: categoría inactiva)')
  console.log('                             Napolitana aparece atenuada y "No disponible"')
  console.log('                             Fugazzeta NO aparece: es borrador')
  console.log('                             Pan de cortesía dice "Gratis"')
  console.log('    /site/demo-autoresponder el sitio inmobiliario, sin cambios')
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

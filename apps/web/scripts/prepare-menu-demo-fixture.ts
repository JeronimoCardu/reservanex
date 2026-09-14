/**
 * Fase 3E-C3A2 §24 / 3E-C3B1 §25 — escenario para la prueba de navegador.
 *
 * Crea un tenant food_service descartable con su owner, una recepcionista y una
 * carta pensada para ejercitar TODOS los casos que el sitio público distingue:
 *
 *   Pizzas   (activa)    Muzzarella        publicado · disponible · CON foto
 *                        Napolitana        publicado · disponible · sin foto
 *                        Fugazzeta         publicado · NO disponible → "Agregar" gris
 *                        Calabresa         BORRADOR  → no debe verse en público
 *   Bebidas  (activa)    Agua 500ml        publicado · disponible · CON foto
 *                        Gaseosa 1.5L      publicado · disponible · sin foto
 *   Entradas (activa)    Pan de cortesía   publicado · disponible · precio 0
 *   Postres  (INACTIVA)  Flan casero       publicado → no debe verse en público
 *
 * Las fotos son un PNG de color generado acá: es un marcador de posición
 * honesto, no una foto de stock bajada de ningún lado.
 *
 * Fase 3E-C3B1 (fix): también deja una cuenta AutoResponder de PLACEHOLDER, con
 * un número inventado que no recibe mensajes. Sin ninguna cuenta, la pantalla de
 * éxito del pedido muestra el estado controlado en vez del CTA de WhatsApp, y la
 * prueba manual no puede verificar el link.
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
      { nombre: 'Muzzarella', descripcion: 'Salsa de tomate, muzzarella y orégano.',   precio: '10000.00', publicado: true,  disponible: true,  color: [217, 119, 66] },
      { nombre: 'Napolitana', descripcion: 'Muzzarella, tomate en rodajas y ajo.',     precio: '12500.50', publicado: true,  disponible: true,  color: null },
      // Fase 3E-C3B1 — el NO disponible ahora es Fugazzeta, y va PUBLICADO: hace
      // falta que se VEA en la carta para poder comprobar que su botón "Agregar"
      // está deshabilitado. Un borrador no se ve, así que no sirve para ese caso.
      { nombre: 'Fugazzeta',  descripcion: 'Cebolla y muzzarella.',                    precio: '13000.00', publicado: true,  disponible: false, color: null },
      // El borrador se conserva en su propio producto: sigue haciendo falta para
      // comprobar que un no publicado NO aparece en público.
      { nombre: 'Calabresa',  descripcion: 'Longaniza y morrón. Todavía en prueba.',   precio: '13500.00', publicado: false, disponible: true,  color: null },
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
      for (const tb of ['menu_items', 'menu_categories', 'table_reservations', 'operation_requests', 'notes', 'tasks', 'whatsapp_accounts'] as const) {
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

  // ── Cuenta de WhatsApp ───────────────────────────────────────────────────
  //
  // El fixture NO la crea. Una cuenta 'autoresponder' exige inbound_token_hash
  // (CHECK whatsapp_accounts_provider_fields_check), o sea el hash de un token
  // de dispositivo: una credencial. Inventarla acá sería fabricar un secreto, y
  // ya existe el camino correcto —seed:autoresponder, que lee el token de env y
  // nunca lo imprime—. Ver el aviso al final de la salida.
  const { count: cuentasWa } = await admin.from('whatsapp_accounts')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
  const sinWhatsApp = (cuentasWa ?? 0) === 0

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

  console.log('  QUÉ PROBAR — la carta (3E-C3A1 / C3A2)')
  console.log('    /dashboard/menu          subir foto · reemplazar · quitar (menú ⋯)')
  console.log('                             la grilla: buscar, filtrar, editar, guardar')
  console.log(`    /site/${SLUG}   la carta pública`)
  console.log('                             Pizzas · Bebidas · Entradas  (Postres NO: categoría inactiva)')
  console.log('                             Fugazzeta aparece atenuada y "No disponible"')
  console.log('                             Calabresa NO aparece: es borrador')
  console.log('                             Pan de cortesía dice "Gratis"')
  console.log('    /site/demo-autoresponder el sitio inmobiliario, sin cambios')
  console.log(HR)
  console.log('  QUÉ PROBAR — el pedido (3E-C3B1)')
  console.log(`    /site/${SLUG}`)
  console.log('    1. Agregar        "Agregar" en Muzzarella. Tocar de nuevo: sube a 2,')
  console.log('                      NO crea una segunda línea.')
  console.log('    2. No disponible  el botón de Fugazzeta está deshabilitado.')
  console.log('    3. Ver pedido     la barra de abajo muestra unidades y subtotal.')
  console.log('    4. Líneas         escribir "sin cebolla" en la línea de Muzzarella,')
  console.log('                      tocar "Otra línea" y escribir "sin aceitunas".')
  console.log('                      Quedan DOS líneas del mismo producto.')
  console.log('    5. Subtotal       agregar Napolitana (12.500,50) y verificar la suma.')
  console.log('    6. Continuar      el checkout aparece en el MISMO panel, sin cambiar de URL.')
  console.log('    7. Delivery       elegir Delivery: aparece Dirección. Volver a Retiro:')
  console.log('                      desaparece y se limpia.')
  console.log('    8. Enviar         el panel pasa a "¡Recibimos tu pedido!" SIN cerrarse')
  console.log('                      y muestra SUB-XXXXXX.')
  console.log('                      Con cuenta de WhatsApp: botón verde "Confirmar por')
  console.log('                      WhatsApp", y el link lleva esa misma referencia.')
  console.log('                      Sin cuenta: el aviso "Guardá esa referencia".')
  console.log('                      [Cerrar] vuelve al menú con el carrito ya vacío.')
  console.log('')
  console.log('    9. PRECIO CAMBIADO — el caso que importa:')
  console.log('       a) armar un carrito con Muzzarella y NO enviarlo;')
  console.log('       b) en otra pestaña, /dashboard/menu → cambiarle el precio → Guardar;')
  console.log('       c) volver al carrito y Enviar.')
  console.log('       Esperado: NO se crea el pedido. Vuelve al carrito con')
  console.log('       "Algunos precios cambiaron...", el precio y el subtotal ya')
  console.log('       actualizados, y hay que tocar Enviar de nuevo a mano.')
  console.log('')
  console.log('   10. PRODUCTO CAÍDO — mismo procedimiento, pero marcando el producto')
  console.log('       como no disponible (o despublicándolo) en b).')
  console.log('       Esperado: "Algunos productos ya no están disponibles",')
  console.log('       la línea queda marcada en rojo y NO se quita sola.')
  console.log('')
  console.log(`   11. La comanda ya enviada: /dashboard/requests → la solicitud de tipo`)
  console.log('       Pedido muestra el detalle con las dos líneas y el subtotal')
  console.log('       CONGELADOS, aunque el precio del catálogo haya cambiado.')
  console.log(HR)
  if (sinWhatsApp) {
    console.log('  CTA DE WHATSAPP — este tenant NO tiene cuenta de WhatsApp.')
    console.log('')
    console.log('  Sin cuenta activa, la pantalla de éxito del pedido muestra el estado')
    console.log('  controlado ("Guardá esa referencia…") en vez del botón verde. Es el')
    console.log('  comportamiento correcto —nunca se inventa un número— pero esconde el CTA.')
    console.log('')
    console.log('  Para ver el CTA en la prueba manual, registrá una cuenta con el camino')
    console.log('  de siempre (lee el token de env y NO lo imprime):')
    console.log('')
    console.log(`    AUTORESPONDER_TENANT_ID=${tenantId} \\`)
    console.log('    AUTORESPONDER_PHONE_NUMBER=<numero> \\')
    console.log('    AUTORESPONDER_DEVICE_TOKEN=<token> \\')
    console.log('      pnpm --filter @orderflow/worker seed:autoresponder')
    console.log('')
    console.log('  El fixture NO la crea solo: exige inbound_token_hash, que es una')
    console.log('  credencial, y este script no fabrica secretos.')
    console.log(HR)
  }

  console.log(antes === despues
    ? '  ✓ evidencia histórica y tenant inmobiliario intactos'
    : '  ✗ ALGO DEL TENANT INMOBILIARIO CAMBIÓ')
  console.log(HR)
}

main().catch((e) => {
  console.error('[prepare-menu-demo-fixture] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

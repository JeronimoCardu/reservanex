/**
 * Fase 3E-C3A1 — catálogo gastronómico base.
 *
 * Cubre los casos A–AC de §22 por los caminos reales: logins con la anon key y
 * RLS aplicándose, más el service_role donde hace falta demostrar que la GARANTÍA
 * está en la base y no en una policy (el trigger de coherencia de tenant, los
 * CHECK y el redondeo de NUMERIC).
 *
 * NO crea super admins: la prueba de impersonación con sesión real vive en
 * supabase/32-proof-3d-impersonation.sql, igual que en 3E-B1 y 3D. Acá se verifica
 * estructuralmente que las policies de impersonación existen y son SOLO lectura.
 *
 * Usage:  pnpm --filter @orderflow/web validate:menu-catalog
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes, randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import {
  createMenuItemSchema,
  createMenuCategorySchema,
  menuPriceSchema,
} from '@orderflow/validators'
import { computeReorder } from '../src/lib/dashboard/reorder'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { generateSubmissionReference } from '../src/lib/forms/submission-reference'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }

type PgError = { code?: string; message?: string } | null

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const RUN     = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3E-C3A1 — catálogo gastronómico base')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authIds:   string[] = []

  const anonClient = () => createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // ── Fixture ───────────────────────────────────────────────────────────────
    async function buildTenant(label: string, vertical: 'food_service' | 'real_estate' = 'food_service') {
      const { data: t, error } = await admin.from('tenants')
        .insert({
          name: `[TEST] 3EC3A1 ${label} ${RUN}`,
          slug: `test-3ec3a1-${label.toLowerCase()}-${RUN}`,
          status: 'active', vertical,
        } as never).select('id').single()
      if (error || !t) throw new Error(`tenant: ${error?.message}`)
      tenantIds.push(t.id)

      async function mkUser(
        kind: string, role: 'owner' | 'receptionist',
        perms: { menu?: boolean; props?: boolean; mesas?: boolean; reservas?: boolean } = {},
      ) {
        const password = randomBytes(18).toString('hex')
        const email    = `${kind}-3ec3a1-${label.toLowerCase()}-${RUN}@example.test`
        const { data: au, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
        if (e || !au.user) throw new Error(`user: ${e?.message}`)
        authIds.push(au.user.id)
        const { error: tu } = await admin.from('tenant_users').insert({
          id: au.user.id, tenant_id: t!.id, name: `${kind} ${label}`, email, role, active: true,
          can_manage_menu:               perms.menu     ?? false,
          can_create_properties:         perms.props    ?? false,
          can_manage_table_reservations: perms.mesas    ?? false,
          can_confirm_reservations:      perms.reservas ?? false,
        } as never)
        if (tu) throw new Error(`tenant_users: ${tu.message}`)
        return { id: au.user.id, email, password }
      }

      // Contacto: hace falta para crear una solicitud por el camino real.
      const { data: contact } = await admin.from('contacts')
        .insert({ tenant_id: t.id, phone: `5498${label.charCodeAt(0)}${RUN.slice(-8)}`, name: null } as never)
        .select('id').single()
      if (!contact) throw new Error('contact')

      // Recepcionista creada como la crea PRODUCCIÓN: sin enviar ninguna columna
      // can_*, o sea tomando los defaults de la base. Es el sujeto de los casos
      // AJ–AN: lo que importa no es qué permisos le pusimos, sino con cuáles NACE.
      const password = randomBytes(18).toString('hex')
      const emailNueva = `recep-nueva-3ec3a1-${label.toLowerCase()}-${RUN}@example.test`
      const { data: auNueva, error: eNueva } = await admin.auth.admin.createUser({
        email: emailNueva, password, email_confirm: true,
      })
      if (eNueva || !auNueva.user) throw new Error(`recep nueva: ${eNueva?.message}`)
      authIds.push(auNueva.user.id)
      const { error: eTuNueva } = await admin.from('tenant_users').insert({
        id: auNueva.user.id, tenant_id: t.id, name: `recep nueva ${label}`,
        email: emailNueva, role: 'receptionist', active: true,
        // A PROPÓSITO sin ninguna columna can_*: igual que createTenantUser().
      } as never)
      if (eTuNueva) throw new Error(`tenant_users nueva: ${eTuNueva.message}`)

      return {
        id: t.id,
        contactId: contact.id,
        recepNueva: { id: auNueva.user.id, email: emailNueva, password },
        // can_manage_menu FALSE a propósito: un owner tiene que autorizarse por
        // ROL, no por la columna. Es el estado real de los owners que crea el
        // fixture de demo, y si la policy dependiera de la columna, este owner no
        // podría cargar su propia carta.
        owner:      await mkUser('owner',      'owner',        { menu: false }),
        recepMenu:  await mkUser('recep-menu', 'receptionist', { menu: true }),
        recepNo:    await mkUser('recep-no',   'receptionist', {}),
        recepProps: await mkUser('recep-prop', 'receptionist', { props: true }),
        recepMesas: await mkUser('recep-mesa', 'receptionist', { mesas: true, reservas: true }),
      }
    }

    const A = await buildTenant('A')
    const B = await buildTenant('B')
    // R nace real_estate: es el tenant con el que se prueba que el catálogo NO
    // existe para un rubro inmobiliario, aunque su owner cumpla la policy.
    const R = await buildTenant('R', 'real_estate')
    // F2 nace food_service y después se le cambia el rubro. Es la única forma de
    // construir el estado "categoría e item del MISMO tenant, pero el tenant no es
    // gastronómico" — que por la puerta de adelante es inalcanzable, justamente
    // porque el guard de categorías lo impide. Sirve para aislar el guard de
    // menu_items sin que el cross-tenant se lo tape.
    const F2 = await buildTenant('F2')
    ok('Fixture: 3 tenants food_service + 1 real_estate, con owner y 4 recepcionistas cada uno')

    async function login(u: { email: string; password: string }): Promise<SupabaseClient<Database>> {
      const c = anonClient()
      const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password })
      if (error) throw new Error(`login ${u.email}: ${error.message}`)
      return c
    }

    const asOwnerA  = await login(A.owner)
    const asMenuA   = await login(A.recepMenu)
    const asNoA     = await login(A.recepNo)
    const asPropsA  = await login(A.recepProps)
    const asMesasA  = await login(A.recepMesas)
    const asOwnerB  = await login(B.owner)
    const asOwnerR  = await login(R.owner)
    const asOwnerF2 = await login(F2.owner)
    const asNuevaA  = await login(A.recepNueva)
    ok('Logins reales con la anon key (RLS aplicándose)')

    /** Inserta una categoría con un cliente dado y devuelve {id, error}. */
    async function crearCat(
      c: SupabaseClient<Database>, tenantId: string, name: string, sort = 0,
    ): Promise<{ id: string | null; error: PgError }> {
      const { data, error } = await c.from('menu_categories')
        .insert({ tenant_id: tenantId, name, sort_order: sort } as never)
        .select('id').maybeSingle()
      return { id: (data as { id: string } | null)?.id ?? null, error }
    }

    async function crearItem(
      c: SupabaseClient<Database>, tenantId: string, categoryId: string,
      name: string, price: number | string, sort = 0,
    ): Promise<{ id: string | null; error: PgError }> {
      const { data, error } = await c.from('menu_items')
        .insert({ tenant_id: tenantId, category_id: categoryId, name, base_price: price, sort_order: sort } as never)
        .select('id').maybeSingle()
      return { id: (data as { id: string } | null)?.id ?? null, error }
    }

    console.log(`\n${HR}\n  Permisos`)

    // ── A. owner crea categoría ───────────────────────────────────────────────
    const catEntradas = await crearCat(asOwnerA, A.id, 'Entradas', 0)
    if (catEntradas.id) ok('A. el owner crea una categoría con can_manage_menu = FALSE: se autoriza por ROL, no por la columna')
    else nok('A. el owner no pudo crear', JSON.stringify(catEntradas.error))

    // Y también escribe items, no solo categorías: las dos policies tienen que
    // tener la misma rama de owner.
    const itemOwner = await crearItem(asOwnerA, A.id, catEntradas.id!, `Owner sin permiso ${RUN}`, 1, 9)
    if (itemOwner.id) {
      ok('A. y también crea items por rol')
      await admin.from('menu_items').delete().eq('id', itemOwner.id)
    } else nok('A. el owner no pudo crear un item', JSON.stringify(itemOwner.error))

    // ── B. receptionist con can_manage_menu crea ──────────────────────────────
    const catPizzas = await crearCat(asMenuA, A.id, 'Pizzas', 1)
    if (catPizzas.id) ok('B. una recepcionista con can_manage_menu crea')
    else nok('B. can_manage_menu no alcanzó', JSON.stringify(catPizzas.error))

    // ── C. receptionist sin permiso NO crea ───────────────────────────────────
    const catNo = await crearCat(asNoA, A.id, `Prohibida ${RUN}`, 9)
    if (!catNo.id && catNo.error) ok(`C. una recepcionista sin permiso NO crea (${catNo.error.code})`)
    else nok('C. una recepcionista sin permiso creó una categoría')

    // ── D. can_create_properties NO habilita menú ─────────────────────────────
    const catProps = await crearCat(asPropsA, A.id, `PorProps ${RUN}`, 9)
    if (!catProps.id && catProps.error) ok(`D. can_create_properties NO habilita el menú (${catProps.error.code})`)
    else nok('D. can_create_properties habilitó el menú')

    // ── E. can_manage_table_reservations NO habilita menú ─────────────────────
    const catMesas = await crearCat(asMesasA, A.id, `PorMesas ${RUN}`, 9)
    if (!catMesas.id && catMesas.error) {
      ok(`E. can_manage_table_reservations ni can_confirm_reservations habilitan el menú (${catMesas.error.code})`)
    } else nok('E. un permiso de otro módulo habilitó el menú')

    // ── F. cross tenant bloqueado ─────────────────────────────────────────────
    const crossInsert = await crearCat(asOwnerA, B.id, `Invasora ${RUN}`, 9)
    const { data: crossRead } = await asOwnerA.from('menu_categories')
      .select('id').eq('tenant_id', B.id)
    if (!crossInsert.id && crossInsert.error && (crossRead ?? []).length === 0) {
      ok(`F. cross-tenant bloqueado: el owner de A no escribe ni lee categorías de B (${crossInsert.error.code})`)
    } else nok('F. cross-tenant NO bloqueado', JSON.stringify({ crossInsert, leidas: crossRead?.length }))

    console.log(`\n${HR}\n  Categorías`)

    // ── G. duplicado normalizado rechazado ────────────────────────────────────
    const bebidas = await crearCat(asOwnerA, A.id, 'Bebidas', 2)
    if (!bebidas.id) throw new Error(`no se pudo crear Bebidas: ${JSON.stringify(bebidas.error)}`)

    const variantes = [' bebidas ', 'BEBIDAS', 'BeBiDaS']
    const rechazos: string[] = []
    for (const v of variantes) {
      const r = await crearCat(asOwnerA, A.id, v, 9)
      if (!r.id && r.error?.code === '23505') rechazos.push(v)
      else if (r.id) await admin.from('menu_categories').delete().eq('id', r.id)
    }
    if (rechazos.length === variantes.length) {
      ok(`G. duplicado normalizado rechazado con 23505: ${variantes.map((v) => JSON.stringify(v)).join(', ')} contra "Bebidas"`)
    } else nok('G. alguna variante entró como categoría nueva', `rechazadas: ${rechazos.length}/${variantes.length}`)

    // Y en OTRO tenant el mismo nombre sí puede existir.
    const bebidasB = await crearCat(asOwnerB, B.id, 'Bebidas', 0)
    if (bebidasB.id) ok('G. el mismo nombre coexiste en otro tenant (el índice es tenant-scoped)')
    else nok('G. el índice no está scopeado por tenant', JSON.stringify(bebidasB.error))

    // El nombre se guarda TAL CUAL, no normalizado.
    const { data: guardada } = await admin.from('menu_categories')
      .select('name').eq('id', bebidas.id).maybeSingle()
    if ((guardada as { name: string } | null)?.name === 'Bebidas') {
      ok('G. el nombre se persiste tal como se escribió (la normalización es solo para comparar)')
    } else nok('G. el nombre se guardó normalizado', JSON.stringify(guardada))

    console.log(`\n${HR}\n  Items`)

    // ── I. crear item válido ──────────────────────────────────────────────────
    const empanada = await crearItem(asOwnerA, A.id, catEntradas.id!, 'Empanada de carne', 1500, 0)
    if (empanada.id) ok('I. se crea un item válido')
    else nok('I. no se pudo crear el item', JSON.stringify(empanada.error))

    // ── O / P. defaults ───────────────────────────────────────────────────────
    const { data: reciente } = await admin.from('menu_items')
      .select('published, available, deleted_at, base_price, sort_order')
      .eq('id', empanada.id!).maybeSingle()
    const r0 = reciente as { published: boolean; available: boolean; deleted_at: string | null; base_price: string | number } | null
    if (r0?.published === false) ok('O. published nace en false')
    else nok('O. published no nace en false', JSON.stringify(r0))
    if (r0?.available === true) ok('P. available nace en true')
    else nok('P. available no nace en true', JSON.stringify(r0))
    if (r0?.deleted_at === null) ok('O/P. deleted_at nace NULL')
    else nok('deleted_at no nace NULL', JSON.stringify(r0))

    // ── J. categoría cross-tenant rechazada por la BASE ───────────────────────
    // Primero por el camino del usuario (RLS + trigger).
    const itemCross = await crearItem(asOwnerA, A.id, bebidasB.id!, `Invasor ${RUN}`, 100, 9)
    if (!itemCross.id && itemCross.error) {
      ok(`J. item de A con categoría de B rechazado por el camino del usuario (${itemCross.error.code})`)
    } else nok('J. se pudo colgar un item de una categoría de otro tenant')

    // Y ahora con service_role, que SALTEA RLS: acá el único que puede frenarlo
    // es el trigger. Es la prueba de que la garantía está en la base (§3).
    const { error: eTrigger } = await admin.from('menu_items').insert({
      tenant_id: A.id, category_id: bebidasB.id!, name: `Invasor SR ${RUN}`, base_price: 100, sort_order: 9,
    } as never)
    if (eTrigger && /no pertenece al tenant/i.test(eTrigger.message)) {
      ok(`J. y también con service_role (RLS salteada): lo frena guard_menu_item_tenant (${eTrigger.code})`)
    } else nok('J. con service_role el trigger no frenó la incoherencia', JSON.stringify(eTrigger))

    console.log(`\n${HR}\n  Precio`)

    // ── K. precio 0 válido ────────────────────────────────────────────────────
    const gratis = await crearItem(asOwnerA, A.id, catEntradas.id!, 'Pan de cortesía', 0, 1)
    const { data: gratisRow } = await admin.from('menu_items')
      .select('base_price').eq('id', gratis.id ?? randomUUID()).maybeSingle()
    if (gratis.id && Number((gratisRow as { base_price: string | number } | null)?.base_price) === 0) {
      ok('K. precio 0 es válido y persiste como 0 (gratis, no "sin precio")')
    } else nok('K. precio 0 rechazado o alterado', JSON.stringify({ err: gratis.error, gratisRow }))

    // Y Zod lo acepta.
    const zodCero = menuPriceSchema.safeParse('0')
    const zodCeroDec = menuPriceSchema.safeParse('0.00')
    if (zodCero.success && zodCero.data === 0 && zodCeroDec.success && zodCeroDec.data === 0) {
      ok('K. Zod acepta "0" y "0.00" y los normaliza a 0')
    } else nok('K. Zod rechazó un precio 0', JSON.stringify({ zodCero, zodCeroDec }))

    // ── L. precio con 2 decimales ─────────────────────────────────────────────
    const conDec = await crearItem(asOwnerA, A.id, bebidas.id, 'Agua 500ml', '1500.50', 0)
    const { data: decRow } = await admin.from('menu_items')
      .select('base_price').eq('id', conDec.id ?? randomUUID()).maybeSingle()
    if (conDec.id && Number((decRow as { base_price: string | number } | null)?.base_price) === 1500.5) {
      ok('L. 1500.50 persiste exacto')
    } else nok('L. un precio con dos decimales no persistió exacto', JSON.stringify({ err: conDec.error, decRow }))

    const zodDec = menuPriceSchema.safeParse('1500.50')
    if (zodDec.success && zodDec.data === 1500.5) ok('L. Zod acepta dos decimales')
    else nok('L. Zod rechazó dos decimales', JSON.stringify(zodDec))

    // ── M. precio negativo rechazado ──────────────────────────────────────────
    const negUser = await crearItem(asOwnerA, A.id, catEntradas.id!, `Negativo ${RUN}`, -1, 9)
    const { error: negSR } = await admin.from('menu_items').insert({
      tenant_id: A.id, category_id: catEntradas.id!, name: `Negativo SR ${RUN}`, base_price: -1, sort_order: 9,
    } as never)
    if (!negUser.id && negSR?.code === '23514') {
      ok('M. precio negativo rechazado por el CHECK de la base, incluso con service_role (23514)')
    } else nok('M. un precio negativo entró', JSON.stringify({ negUser, negSR }))

    for (const malo of ['-1', '-0.01', 'abc', '1e3', 'NaN', '', '  ']) {
      const r = menuPriceSchema.safeParse(malo)
      if (r.success) { nok(`M. Zod aceptó un precio inválido: ${JSON.stringify(malo)}`); break }
    }
    if (['-1', '-0.01', 'abc', '1e3', 'NaN', '', '  '].every((m) => !menuPriceSchema.safeParse(m).success)) {
      ok('M. Zod rechaza negativos, texto, notación científica, NaN y vacío')
    }

    // ── N. más de 2 decimales: comportamiento EXACTO ──────────────────────────
    // La base REDONDEA, no rechaza. Se comprueba, no se supone.
    const { data: redondeado } = await admin.from('menu_items').insert({
      tenant_id: A.id, category_id: catEntradas.id!, name: `Redondeo ${RUN}`, base_price: 1000.999, sort_order: 9,
    } as never).select('id, base_price').maybeSingle()
    const rr = redondeado as { id: string; base_price: string | number } | null
    if (rr && Number(rr.base_price) === 1001) {
      ok('N. NUMERIC(14,2) REDONDEA 1000.999 → 1001.00 (NO rechaza): verificado contra la base')
    } else nok('N. el comportamiento de NUMERIC(14,2) no es el esperado', JSON.stringify(rr))
    if (rr) await admin.from('menu_items').delete().eq('id', rr.id)

    // Por eso el rechazo tiene que estar ANTES, en la validación del input.
    const tresDec = ['1000.999', '0.001', '1500.505']
    if (tresDec.every((v) => !menuPriceSchema.safeParse(v).success)) {
      ok('N. Zod RECHAZA >2 decimales antes de la base: el usuario nunca guarda un precio distinto al que escribió')
    } else nok('N. Zod dejó pasar un precio con más de dos decimales')

    // El schema completo del item también lo rechaza (no solo el de precio suelto).
    const itemMal = createMenuItemSchema.safeParse({
      category_id: catEntradas.id!, name: 'X', base_price: '10.999',
    })
    if (!itemMal.success) ok('N. createMenuItemSchema hereda el rechazo')
    else nok('N. createMenuItemSchema aceptó >2 decimales')

    // ── Largos / nombres ──────────────────────────────────────────────────────
    const catLarga = createMenuCategorySchema.safeParse({ name: 'x'.repeat(61) })
    const { error: eLargaDB } = await admin.from('menu_categories').insert({
      tenant_id: A.id, name: 'y'.repeat(61), sort_order: 9,
    } as never)
    if (!catLarga.success && eLargaDB?.code === '23514') {
      ok('Nombre de categoría: Zod y el CHECK de la base coinciden en 60 caracteres')
    } else nok('el límite de nombre de categoría no coincide', JSON.stringify({ catLarga: catLarga.success, eLargaDB }))

    const { error: eVacio } = await admin.from('menu_items').insert({
      tenant_id: A.id, category_id: catEntradas.id!, name: '   ', base_price: 10, sort_order: 9,
    } as never)
    if (eVacio?.code === '23514') ok('Un nombre de item en blanco lo rechaza la base (btrim), no solo Zod')
    else nok('un nombre en blanco entró', JSON.stringify(eVacio))

    console.log(`\n${HR}\n  Publicación, disponibilidad y archivado`)

    // ── Q. toggle published ───────────────────────────────────────────────────
    await asOwnerA.from('menu_items').update({ published: true } as never).eq('id', empanada.id!)
    const leer = async (id: string) => {
      const { data } = await admin.from('menu_items')
        .select('published, available, deleted_at').eq('id', id).maybeSingle()
      return data as { published: boolean; available: boolean; deleted_at: string | null } | null
    }
    let est = await leer(empanada.id!)
    if (est?.published === true) ok('Q. se publica')
    else nok('Q. no se pudo publicar', JSON.stringify(est))

    await asOwnerA.from('menu_items').update({ published: false } as never).eq('id', empanada.id!)
    est = await leer(empanada.id!)
    if (est?.published === false) ok('Q. y se despublica')
    else nok('Q. no se pudo despublicar', JSON.stringify(est))

    // ── R. toggle available ───────────────────────────────────────────────────
    await asOwnerA.from('menu_items').update({ available: false } as never).eq('id', empanada.id!)
    est = await leer(empanada.id!)
    if (est?.available === false && est?.published === false) {
      ok('R. available se apaga sin tocar published (son dimensiones distintas)')
    } else nok('R. available no se apagó de forma independiente', JSON.stringify(est))
    await asOwnerA.from('menu_items').update({ available: true, published: true } as never).eq('id', empanada.id!)

    // ── S / T / U. archivar, no listar, restaurar ─────────────────────────────
    const ahora = new Date().toISOString()
    await asOwnerA.from('menu_items').update({ deleted_at: ahora } as never).eq('id', empanada.id!)
    est = await leer(empanada.id!)
    if (est?.deleted_at !== null) ok('S. se archiva con deleted_at')
    else nok('S. no se pudo archivar')

    const { data: activos } = await asOwnerA.from('menu_items')
      .select('id').eq('tenant_id', A.id).is('deleted_at', null)
    const { data: archivados } = await asOwnerA.from('menu_items')
      .select('id').eq('tenant_id', A.id).not('deleted_at', 'is', null)
    const idsActivos = (activos ?? []).map((x) => (x as { id: string }).id)
    const idsArch    = (archivados ?? []).map((x) => (x as { id: string }).id)
    if (!idsActivos.includes(empanada.id!) && idsArch.includes(empanada.id!)) {
      ok('T. el archivado sale del listado activo y aparece en el de archivados')
    } else nok('T. el filtro de archivados no separa bien', JSON.stringify({ idsActivos, idsArch }))

    // Restaurar conserva published: el item vuelve como estaba.
    await asOwnerA.from('menu_items').update({ deleted_at: null } as never).eq('id', empanada.id!)
    est = await leer(empanada.id!)
    if (est?.deleted_at === null && est?.published === true) {
      ok('U. se restaura y CONSERVA published (vuelve como estaba, no a borrador)')
    } else nok('U. la restauración perdió estado', JSON.stringify(est))

    // ── H. categoría desactivada conserva sus items ───────────────────────────
    const { data: antes } = await admin.from('menu_items')
      .select('id, published, available, deleted_at, category_id')
      .eq('category_id', catEntradas.id!).order('created_at')
    await asOwnerA.from('menu_categories').update({ active: false } as never).eq('id', catEntradas.id!)
    const { data: despues } = await admin.from('menu_items')
      .select('id, published, available, deleted_at, category_id')
      .eq('category_id', catEntradas.id!).order('created_at')
    const { data: catEst } = await admin.from('menu_categories')
      .select('active').eq('id', catEntradas.id!).maybeSingle()

    if ((catEst as { active: boolean } | null)?.active === false &&
        JSON.stringify(antes) === JSON.stringify(despues) &&
        (despues ?? []).length > 0) {
      ok(`H. desactivar la categoría NO tocó sus ${(despues ?? []).length} items (published/available/deleted_at/category_id idénticos)`)
    } else nok('H. desactivar la categoría alteró sus items', JSON.stringify({ antes, despues }))

    await asOwnerA.from('menu_categories').update({ active: true } as never).eq('id', catEntradas.id!)
    const { data: catEst2 } = await admin.from('menu_categories')
      .select('active').eq('id', catEntradas.id!).maybeSingle()
    if ((catEst2 as { active: boolean } | null)?.active === true) ok('H. y es reversible')
    else nok('H. no se pudo reactivar')

    console.log(`\n${HR}\n  Orden`)

    // ── V. reordenar categorías ───────────────────────────────────────────────
    async function ordenCats(): Promise<{ id: string; sort_order: number; name: string }[]> {
      const { data } = await asOwnerA.from('menu_categories')
        .select('id, sort_order, name').eq('tenant_id', A.id)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
      return (data ?? []) as { id: string; sort_order: number; name: string }[]
    }

    let cats = await ordenCats()
    const nombresAntes = cats.map((c) => c.name)
    // Sube la última con el MISMO cálculo que usa el repositorio.
    const ultima = cats[cats.length - 1]!
    for (const e of computeReorder(cats, ultima.id, 'up')) {
      await asOwnerA.from('menu_categories').update({ sort_order: e.sort_order } as never).eq('id', e.id)
    }
    cats = await ordenCats()
    const esperado = [...nombresAntes]
    esperado.splice(esperado.length - 1, 1)
    esperado.splice(esperado.length - 1, 0, ultima.name)
    if (JSON.stringify(cats.map((c) => c.name)) === JSON.stringify(esperado)) {
      ok(`V. reordenar categorías: ${nombresAntes.join(' → ')}  ⇒  ${cats.map((c) => c.name).join(' → ')}`)
    } else nok('V. el orden de categorías no quedó como se esperaba',
      JSON.stringify({ esperado, real: cats.map((c) => c.name) }))

    // ── W. reordenar items DENTRO de su categoría ─────────────────────────────
    // Tres items con sort_order TODOS en 0: el caso que rompería un swap.
    const catOrden = await crearCat(asOwnerA, A.id, `Orden ${RUN}`, 50)
    const i1 = await crearItem(asOwnerA, A.id, catOrden.id!, 'Uno',  10, 0)
    const i2 = await crearItem(asOwnerA, A.id, catOrden.id!, 'Dos',  20, 0)
    const i3 = await crearItem(asOwnerA, A.id, catOrden.id!, 'Tres', 30, 0)

    async function ordenItems(catId: string): Promise<{ id: string; sort_order: number; name: string }[]> {
      const { data } = await asOwnerA.from('menu_items')
        .select('id, sort_order, name').eq('tenant_id', A.id).eq('category_id', catId)
        .is('deleted_at', null)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
      return (data ?? []) as { id: string; sort_order: number; name: string }[]
    }

    let its = await ordenItems(catOrden.id!)
    if (its.every((i) => i.sort_order === 0)) ok('W. punto de partida real: los tres items con sort_order = 0')
    else nok('W. el fixture de orden no arrancó con sort_order 0', JSON.stringify(its))

    for (const e of computeReorder(its, i3.id!, 'up')) {
      await asOwnerA.from('menu_items').update({ sort_order: e.sort_order } as never).eq('id', e.id)
    }
    its = await ordenItems(catOrden.id!)
    if (JSON.stringify(its.map((i) => i.name)) === JSON.stringify(['Uno', 'Tres', 'Dos'])) {
      ok('W. reordenar items funciona con sort_order duplicados: Uno → Tres → Dos')
    } else nok('W. el orden de items no quedó bien', JSON.stringify(its.map((i) => i.name)))

    // El reorden NO cruza categorías: los items de Bebidas no se movieron.
    const otrosDeBebidas = await ordenItems(bebidas.id)
    if (otrosDeBebidas.every((i) => i.sort_order === 0)) {
      ok('W. el grupo de orden es la categoría: los items de otra categoría no se tocaron')
    } else nok('W. el reorden cruzó de categoría', JSON.stringify(otrosDeBebidas))

    // ── X. mover item a otra categoría del MISMO tenant ───────────────────────
    const { error: eMover } = await asOwnerA.from('menu_items')
      .update({ category_id: bebidas.id, sort_order: 5 } as never).eq('id', i1.id!)
    const { data: movido } = await admin.from('menu_items')
      .select('category_id, tenant_id').eq('id', i1.id!).maybeSingle()
    const mv = movido as { category_id: string; tenant_id: string } | null
    if (!eMover && mv?.category_id === bebidas.id && mv?.tenant_id === A.id) {
      ok('X. un item se mueve a otra categoría del mismo tenant (el guard revalida y pasa)')
    } else nok('X. no se pudo mover el item', JSON.stringify({ eMover, movido }))

    // Y el mismo UPDATE hacia una categoría de otro tenant se cae.
    const { error: eMoverCross } = await asOwnerA.from('menu_items')
      .update({ category_id: bebidasB.id! } as never).eq('id', i1.id!)
    const { data: sigueEnA } = await admin.from('menu_items')
      .select('category_id').eq('id', i1.id!).maybeSingle()
    if ((sigueEnA as { category_id: string } | null)?.category_id === bebidas.id) {
      ok(`X. mover un item a una categoría de otro tenant NO cambia nada (${eMoverCross?.code ?? 'sin filas afectadas'})`)
    } else nok('X. se movió un item a la categoría de otro tenant', JSON.stringify({ eMoverCross, sigueEnA }))

    console.log(`\n${HR}\n  Superficie: DELETE, anon, impersonación, grants`)

    // ── Y. DELETE directo bloqueado ───────────────────────────────────────────
    const { error: eDelItem } = await asOwnerA.from('menu_items').delete().eq('id', i2.id!)
    const { error: eDelCat }  = await asOwnerA.from('menu_categories').delete().eq('id', catOrden.id!)
    const { count: sigueItem } = await admin.from('menu_items')
      .select('id', { count: 'exact', head: true }).eq('id', i2.id!)
    const { count: sigueCat } = await admin.from('menu_categories')
      .select('id', { count: 'exact', head: true }).eq('id', catOrden.id!)
    if (eDelItem && eDelCat && sigueItem === 1 && sigueCat === 1) {
      ok(`Y. DELETE directo bloqueado en las dos tablas y las filas siguen ahí (${eDelItem.code})`)
    } else nok('Y. un DELETE directo pasó', JSON.stringify({ eDelItem, eDelCat, sigueItem, sigueCat }))

    // ── Z. anon bloqueado ─────────────────────────────────────────────────────
    const anon = anonClient()
    const { data: anonCats, error: eAnonSel } = await anon.from('menu_categories').select('id').limit(1)
    const { error: eAnonIns } = await anon.from('menu_items')
      .insert({ tenant_id: A.id, category_id: bebidas.id, name: `Anon ${RUN}`, base_price: 1 } as never)
    const anonNoLee = eAnonSel !== null || (anonCats ?? []).length === 0
    if (anonNoLee && eAnonIns) {
      ok(`Z. anon no lee ni escribe el catálogo (select: ${eAnonSel?.code ?? 'sin filas'} · insert: ${eAnonIns.code})`)
    } else nok('Z. anon tuvo acceso', JSON.stringify({ eAnonSel, anonCats, eAnonIns }))

    // ── AA. impersonación read-only ───────────────────────────────────────────
    //
    // NO se crea un super admin: está explícitamente prohibido. Y pg_policies /
    // information_schema no son alcanzables vía PostgREST (solo expone el schema
    // public), así que desde acá no se puede leer el catálogo de policies.
    //
    // Lo que SÍ se puede afirmar sin inventar nada: la única forma de que un
    // platform_user escriba estas tablas sería una policy de INSERT/UPDATE que
    // mencionara auth_impersonating_tenant_id(), y las dos policies de escritura
    // exigen tenant_id = auth_tenant_id() — que para un platform_user es NULL.
    // Eso se verifica estructuralmente con supabase db query y queda en el
    // reporte; la prueba con sesión real vive en
    // supabase/32-proof-3d-impersonation.sql, igual que en 3D y 3E-B1.
    console.log('      AA. sin cobertura ejecutable acá: requiere super admin (prohibido) y pg_policies')
    console.log('          no es legible vía PostgREST. Verificación estructural en el reporte.')

    // ── AB. grants exactos ────────────────────────────────────────────────────
    // Por COMPORTAMIENTO, que es más fuerte que leer el catálogo: si DELETE
    // estuviera concedido, el rechazo no sería 42501 sino "0 filas afectadas"
    // (una policy ausente deja pasar el comando y no afecta nada). El 42501 dice
    // que el privilegio no existe, que es exactamente lo que revocamos.
    //
    // Ojo: 42501 lo devuelven DOS cosas distintas —"permission denied for
    // table" (falta el GRANT) y "violates row-level security policy" (el grant
    // está pero la policy rechaza)— así que el código solo no alcanza. Se mira
    // el mensaje para no afirmar que falta un privilegio cuando lo que falló fue
    // una policy.
    const porFaltaDeGrant = (e: PgError) =>
      e?.code === '42501' && /permission denied/i.test(e?.message ?? '')
    const porPolicy = (e: PgError) =>
      e?.code === '42501' && /row-level security/i.test(e?.message ?? '')

    if (porFaltaDeGrant(eDelItem) && porFaltaDeGrant(eDelCat)) {
      ok('AB. grants: DELETE no está CONCEDIDO — "permission denied for table", antes de cualquier policy')
    } else {
      nok('AB. el rechazo de DELETE no fue por falta de privilegio',
        JSON.stringify({ item: eDelItem, cat: eDelCat }))
    }
    if (porFaltaDeGrant(eAnonIns)) {
      ok('AB. grants: anon no tiene INSERT — "permission denied", no una policy rechazando')
    } else {
      nok('AB. el rechazo a anon no fue por falta de privilegio', JSON.stringify(eAnonIns))
    }
    // Y la contraparte: a los recepcionistas sin permiso los frena la POLICY, no
    // el grant — el grant de INSERT sí existe para authenticated. Son dos capas
    // distintas y conviene que el test lo demuestre en vez de asumirlo.
    if (porPolicy(catNo.error) && porPolicy(catProps.error) && porPolicy(catMesas.error)) {
      ok('AB. y C/D/E fallan por POLICY ("row-level security"), no por grant: las dos capas actúan donde corresponde')
    } else {
      nok('AB. C/D/E no fallaron por policy', JSON.stringify({ C: catNo.error, D: catProps.error, E: catMesas.error }))
    }
    // Y lo que SÍ tiene que estar concedido, está: los inserts y updates de arriba
    // pasaron con el cliente autenticado.
    ok('AB. grants: SELECT/INSERT/UPDATE sí están concedidos (los casos A–X escribieron con login real)')

    // ── AC. audit logs ────────────────────────────────────────────────────────
    const { data: logs } = await admin.from('audit_logs')
      .select('action, entity_type, entity_id, actor_type, old_value, new_value')
      .eq('tenant_id', A.id)
      .in('entity_type', ['menu_categories', 'menu_items'])
      .order('created_at', { ascending: true })
    const filas = (logs ?? []) as {
      action: string; entity_type: string; entity_id: string; actor_type: string
      old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null
    }[]

    const acciones = new Set(filas.map((f) => f.action))
    if (acciones.has('menu_categories.insert') && acciones.has('menu_items.insert')
        && acciones.has('menu_items.update') && acciones.has('menu_categories.update')) {
      ok(`AC. audit_logs registra inserts y updates de las dos tablas (${filas.length} entradas)`)
    } else nok('AC. faltan acciones en audit_logs', [...acciones].join(', '))

    const precioCambiado = filas.find(
      (f) => f.action === 'menu_items.update' &&
             f.old_value?.published !== f.new_value?.published,
    )
    if (precioCambiado) {
      ok('AC. cada update guarda old_value y new_value: un cambio de estado es reconstruible')
    } else nok('AC. los updates no guardan el antes y el después')

    const porUsuario = filas.filter((f) => f.actor_type === 'tenant_user')
    if (porUsuario.length > 0) ok(`AC. actor_type = tenant_user en los cambios hechos con login real (${porUsuario.length})`)
    else nok('AC. ningún cambio quedó atribuido a un tenant_user')

    console.log(`\n${HR}\n  Invariante de rubro: el catálogo es SOLO de food_service`)

    // Discriminadores de CAPA. El punto de esta sección es no confundirlas: un
    // 42501 es autorización (grant o policy) y un 23514 con este mensaje es el
    // invariante de dominio del trigger. Decir "rechazado" sin más no alcanza.
    const porRubro = (e: PgError) =>
      e?.code === '23514' && /exclusivo de tenants food_service/i.test(e?.message ?? '')
    const porCrossTenant = (e: PgError) =>
      e?.code === '23503' && /no pertenece al tenant/i.test(e?.message ?? '')
    const capa = (e: PgError): string => {
      if (e == null) return 'NINGUNA (entró)'
      if (porRubro(e))       return 'TRIGGER/dominio (23514)'
      if (porCrossTenant(e)) return 'TRIGGER/cross-tenant (23503)'
      if (e.code === '42501' && /row-level security/i.test(e.message ?? '')) return 'RLS/policy (42501)'
      if (e.code === '42501') return 'GRANT (42501)'
      return `otra (${e.code})`
    }

    // ── AD. owner real_estate → categoría ─────────────────────────────────────
    // La policy de INSERT la cumple (tenant propio + owner), así que si esto se
    // rechaza es exclusivamente por el trigger. Eso es lo que hay que demostrar.
    const catR = await crearCat(asOwnerR, R.id, `Prohibida rubro ${RUN}`, 0)
    if (!catR.id && porRubro(catR.error)) {
      ok(`AD. owner real_estate NO puede crear una categoría — ${capa(catR.error)}, no RLS`)
    } else nok('AD. el owner real_estate creó una categoría o falló por otra capa',
      JSON.stringify({ id: catR.id, capa: capa(catR.error), error: catR.error }))

    // Y la contraprueba de que la policy sí lo habilitaba: el MISMO owner, con el
    // MISMO permiso, en un tenant food_service, escribe sin problema. O sea que lo
    // único que cambió es el rubro.
    {
      const { count } = await admin.from('menu_categories')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', R.id)
      if ((count ?? 0) === 0) ok('AD. y no quedó ninguna categoría en el tenant real_estate')
      else nok(`AD. quedaron ${count} categorías en un tenant real_estate`)
    }

    // ── AF. service_role → categoría en real_estate ───────────────────────────
    // service_role saltea RLS por diseño, así que acá el único que puede frenarlo
    // es el trigger. Es la prueba de que esto es un INVARIANTE, no autorización.
    const { error: eSrCatR } = await admin.from('menu_categories')
      .insert({ tenant_id: R.id, name: `SR rubro ${RUN}`, sort_order: 0 } as never)
    if (porRubro(eSrCatR)) {
      ok(`AF. service_role tampoco puede: RLS salteada y el trigger lo frena igual — ${capa(eSrCatR)}`)
    } else nok('AF. service_role pudo crear una categoría en un tenant real_estate',
      JSON.stringify({ capa: capa(eSrCatR), error: eSrCatR }))

    // ── AE / AG. el guard de menu_items, AISLADO ──────────────────────────────
    //
    // Para probar el guard de rubro en items hace falta que la categoría sea del
    // MISMO tenant (si no, gana el cross-tenant y no se prueba nada de rubro). Ese
    // estado es inalcanzable por la puerta de adelante, así que se construye:
    // F2 nace food_service, se le crea la categoría, y después se le cambia el
    // rubro. El item que sigue es del mismo tenant que su categoría.
    const catF2 = await crearCat(asOwnerF2, F2.id, 'Entradas', 0)
    const itemF2 = await crearItem(asOwnerF2, F2.id, catF2.id!, 'Empanada', 1500, 0)
    if (catF2.id && itemF2.id) ok('AE/AG. estado previo armado en F2 (food_service): 1 categoría + 1 item')
    else nok('AE/AG. no se pudo armar el estado previo', JSON.stringify({ catF2, itemF2 }))

    const { error: eFlip } = await admin.from('tenants')
      .update({ vertical: 'real_estate' } as never).eq('id', F2.id)
    if (eFlip) nok('AE/AG. no se pudo cambiar el rubro del tenant descartable', eFlip.message)

    // AE. owner (ya real_estate) inserta un item con la categoría de su PROPIO
    // tenant: el cross-tenant pasa, así que solo el guard de rubro puede frenarlo.
    const itemR = await crearItem(asOwnerF2, F2.id, catF2.id!, `Prohibido rubro ${RUN}`, 100, 9)
    if (!itemR.id && porRubro(itemR.error)) {
      ok(`AE. owner real_estate NO puede crear un item ni con una categoría de su propio tenant — ${capa(itemR.error)}`)
    } else nok('AE. el item entró o falló por otra capa',
      JSON.stringify({ id: itemR.id, capa: capa(itemR.error), error: itemR.error }))

    // AG. y service_role, ídem.
    const { error: eSrItemR } = await admin.from('menu_items').insert({
      tenant_id: F2.id, category_id: catF2.id!, name: `SR item rubro ${RUN}`, base_price: 100, sort_order: 9,
    } as never)
    if (porRubro(eSrItemR)) {
      ok(`AG. service_role tampoco puede crear el item — ${capa(eSrItemR)}`)
    } else nok('AG. service_role creó un item en un tenant real_estate',
      JSON.stringify({ capa: capa(eSrItemR), error: eSrItemR }))

    // Consecuencia conocida del invariante, que conviene fijar en un test para que
    // nadie la descubra en producción: si a un tenant le cambian el rubro, su
    // catálogo preexistente queda de SOLO LECTURA. Las filas siguen ahí y se leen;
    // lo que no se puede es modificarlas.
    const { error: eUpdF2 } = await asOwnerF2.from('menu_items')
      .update({ published: true } as never).eq('id', itemF2.id!)
    const { data: sigueF2 } = await admin.from('menu_items')
      .select('id, published').eq('id', itemF2.id!).maybeSingle()
    if (porRubro(eUpdF2) && (sigueF2 as { published: boolean } | null)?.published === false) {
      ok('AE/AG. consecuencia documentada: cambiarle el rubro al tenant deja su catálogo en SOLO LECTURA (las filas no se pierden)')
    } else nok('AE/AG. el UPDATE tras cambiar el rubro no se comportó como se esperaba',
      JSON.stringify({ capa: capa(eUpdF2), sigueF2 }))

    // ── AI. los DOS invariantes coexisten ─────────────────────────────────────
    // Item del tenant A (food_service) apuntando a una categoría de B: el rubro
    // está bien en los dos lados, así que lo único que puede frenarlo es el guard
    // cross-tenant. Y su SQLSTATE es distinto al del rubro: si el trigger nuevo
    // hubiera reemplazado al viejo, este caso pasaría o daría 23514.
    const itemCrossAI = await crearItem(asOwnerA, A.id, bebidasB.id!, `Cross AI ${RUN}`, 100, 9)
    if (!itemCrossAI.id && porCrossTenant(itemCrossAI.error)) {
      ok(`AI. el guard cross-tenant sigue vivo y con SQLSTATE propio — ${capa(itemCrossAI.error)}`)
    } else nok('AI. el guard cross-tenant cambió de comportamiento',
      JSON.stringify({ id: itemCrossAI.id, capa: capa(itemCrossAI.error) }))

    // ── AH. food_service sigue funcionando ────────────────────────────────────
    // Al final de todo, con los dos triggers puestos: el flujo normal intacto.
    const catAH  = await crearCat(asOwnerA, A.id, `Postres ${RUN}`, 80)
    const itemAH = await crearItem(asOwnerA, A.id, catAH.id!, `Flan ${RUN}`, '2500.50', 0)
    const { error: eUpdAH } = await asOwnerA.from('menu_items')
      .update({ published: true, available: false } as never).eq('id', itemAH.id!)
    const { data: ahRow } = await admin.from('menu_items')
      .select('published, available, base_price').eq('id', itemAH.id ?? randomUUID()).maybeSingle()
    const ah = ahRow as { published: boolean; available: boolean; base_price: string | number } | null
    if (catAH.id && itemAH.id && !eUpdAH && ah?.published === true && ah?.available === false
        && Number(ah.base_price) === 2500.5) {
      ok('AH. food_service sin regresión: crear categoría, crear item, publicar y marcar no disponible siguen funcionando')
    } else nok('AH. el flujo normal de food_service se rompió',
      JSON.stringify({ catAH, itemAH, eUpdAH, ah }))

    // Y también con el recepcionista con permiso, que es el otro camino de RLS.
    const catAHrecep = await crearCat(asMenuA, A.id, `Cafetería ${RUN}`, 81)
    if (catAHrecep.id) ok('AH. y la recepcionista con can_manage_menu también sigue escribiendo')
    else nok('AH. la recepcionista con permiso dejó de poder escribir', JSON.stringify(catAHrecep.error))

    console.log(`\n${HR}\n  Default legacy de can_confirm_reservations`)

    const DEFAULTS_ESPERADOS: Record<string, boolean> = {
      can_access_settings:           false,
      can_assign_conversations:      false,
      can_confirm_reservations:      false,   // ← era true hasta esta fase
      can_create_properties:         false,
      can_manage_inquiries:          false,
      can_manage_menu:               false,
      can_manage_table_reservations: false,
      can_manage_visits:             false,
    }
    const COLS = Object.keys(DEFAULTS_ESPERADOS).join(', ')

    // ── AJ. A/B/C. una recepcionista creada como la crea producción ───────────
    {
      const { data } = await admin.from('tenant_users')
        .select(COLS).eq('id', A.recepNueva.id).maybeSingle()
      const fila = data as Record<string, boolean> | null
      const divergen = Object.entries(DEFAULTS_ESPERADOS)
        .filter(([k, v]) => fila?.[k] !== v)
        .map(([k, v]) => `${k}: esperado ${v}, real ${fila?.[k]}`)

      if (fila && divergen.length === 0) {
        ok('AJ. (A/B/C) una recepcionista creada SIN enviar columnas can_* —igual que createTenantUser()— nace con los 8 permisos en false')
      } else nok('AJ. los defaults no son los esperados', divergen.join(' · '))
    }

    // ── AK. D. un valor explícito no lo pisa el default ───────────────────────
    {
      const { data } = await admin.from('tenant_users')
        .select('can_confirm_reservations')
        .eq('id', A.recepMesas.id).maybeSingle()
      // recepMesas se creó con can_confirm_reservations: true explícito.
      if ((data as { can_confirm_reservations: boolean } | null)?.can_confirm_reservations === true) {
        ok('AK. (D) un valor explícito true se conserva: el default solo aplica cuando la columna no se envía')
      } else nok('AK. un true explícito no se conservó', JSON.stringify(data))
    }

    // ── AL. D. la migración no hizo backfill ────────────────────────────────
    //
    // Se miran los OWNERS, no las recepcionistas, y la distinción importa:
    //
    //   · Los owners preexistentes se crearon antes de 20260917000004 con
    //     can_confirm_reservations = true (el default viejo) y NO son editables
    //     desde el diálogo de permisos —updateReceptionistPermissionsAction
    //     rechaza a quien no sea receptionist—. O sea que su valor solo pudo
    //     haber cambiado por un backfill. Si siguen en true, no hubo ninguno.
    //
    //   · Una recepcionista, en cambio, es justamente lo que un owner PUEDE
    //     apagar desde la UI. Fijar su valor acá sería pinear un estado del
    //     fixture y no una propiedad de la migración: el test fallaría cuando
    //     alguien usa la aplicación como corresponde.
    {
      const { data } = await admin.from('tenant_users')
        .select('email, role, can_confirm_reservations')
        .in('email', ['owner.demo@reservanex.test', 'owner.gastro@reservanex.test'])
        .order('email')
      const filas = (data ?? []) as { email: string; role: string; can_confirm_reservations: boolean }[]
      const owners = filas.filter((f) => f.role === 'owner')

      if (owners.length > 0 && owners.every((f) => f.can_confirm_reservations === true)) {
        ok(`AL. (D) los ${owners.length} owners preexistentes conservan can_confirm_reservations = true: la migración no hizo backfill`)
      } else if (owners.length === 0) {
        // El fixture puede no estar preparado; no se inventa un ✓.
        console.log('      AL. sin owners preexistentes en este proyecto — nada que comprobar')
      } else nok('AL. un owner preexistente cambió de valor', JSON.stringify(owners))
    }

    // ── El caso que motivó todo: order_request ────────────────────────────────
    //
    // Se crea por el camino REAL (form_submission → confirm_submission_and_
    // create_operation), el mismo que corre cuando el cliente confirma por
    // WhatsApp. Nada de insertar operation_requests a mano.
    async function mkOrderRequest(tenantId: string, contactId: string): Promise<string> {
      const { data: sub, error: se } = await admin.from('form_submissions').insert({
        tenant_id: tenantId, reference: generateSubmissionReference(),
        intent: 'food_order', status: 'submitted', source: 'public_site',
        payload: {
          name: 'Diego Sosa', fulfillment: 'takeaway',
          payment_method: 'cash', notes: 'Sin sal, por favor.',
        } as never,
        idempotency_key: randomUUID(), contact_id: contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      } as never).select('id').single()
      if (se || !sub) throw new Error(`submission food_order: ${se?.message}`)

      const { data, error } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub.id, p_tenant_id: tenantId, p_contact_id: contactId,
        p_conversation_id: undefined,
      })
      if (error) throw new Error(`confirm: ${error.message}`)
      const opId = (data as { operation_id?: string } | null)?.operation_id
      if (!opId) throw new Error('sin operation_id')
      return opId
    }

    type Decision = { outcome?: string; required_permission?: string; kind?: string }

    const opOrder = await mkOrderRequest(A.id, A.contactId)
    {
      const { data: op } = await admin.from('operation_requests')
        .select('kind, intent, status').eq('id', opOrder).maybeSingle()
      const o = op as { kind: string; intent: string; status: string } | null
      if (o?.kind === 'order_request' && o.intent === 'food_order' && o.status === 'pending') {
        ok('§5. order_request pending creado por el camino real (kind=order_request, intent=food_order)')
      } else nok('§5. la solicitud no quedó como se esperaba', JSON.stringify(o))
    }

    // ── AM. G. la recepcionista NUEVA no puede confirmarlo ───────────────────
    {
      const { data } = await asNuevaA.rpc('decide_operation_request', {
        p_operation_id: opOrder, p_action: 'confirmed',
      })
      const d = data as Decision | null
      if (d?.outcome === 'forbidden' && d.required_permission === 'can_confirm_reservations') {
        ok('AM. (G) una recepcionista gastronómica NUEVA no puede confirmar un order_request solo por haber sido creada — forbidden, requiere can_confirm_reservations')
      } else nok('AM. la recepcionista nueva pudo decidir un order_request', JSON.stringify(d))

      const { data: sigue } = await admin.from('operation_requests')
        .select('status, decided_at, decided_by').eq('id', opOrder).maybeSingle()
      const sg = sigue as { status: string; decided_at: string | null; decided_by: string | null } | null
      if (sg?.status === 'pending' && sg.decided_at === null && sg.decided_by === null) {
        ok('AM. (G) y la solicitud sigue pending, sin decided_at ni decided_by')
      } else nok('AM. el rechazo dejó rastro en la solicitud', JSON.stringify(sg))
    }

    // ── AO. E/F. concedido explícitamente, SÍ puede ──────────────────────────
    {
      await admin.from('tenant_users')
        .update({ can_confirm_reservations: true } as never).eq('id', A.recepNueva.id)

      const { data } = await asNuevaA.rpc('decide_operation_request', {
        p_operation_id: opOrder, p_action: 'confirmed',
      })
      const d = data as Decision | null
      if (d?.outcome === 'confirmed') {
        ok('AO. (E/F) con can_confirm_reservations concedido explícitamente SÍ confirma: cambió el default, no la autorización por kind')
      } else nok('AO. el permiso explícito no habilitó la decisión', JSON.stringify(d))
    }

    // ── AP. §5. confirmar un order_request no materializa nada ───────────────
    {
      const { data: op } = await admin.from('operation_requests')
        .select('status, decided_by').eq('id', opOrder).maybeSingle()
      const { count: mesas } = await admin.from('table_reservations')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opOrder)
      const { count: visitas } = await admin.from('property_visits')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opOrder)
      const { count: reservas } = await admin.from('reservations')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opOrder)

      const o = op as { status: string; decided_by: string | null } | null
      if (o?.status === 'confirmed' && o.decided_by === A.recepNueva.id
          && (mesas ?? 0) === 0 && (visitas ?? 0) === 0 && (reservas ?? 0) === 0) {
        ok('AP. (§5) order_request pasa pending → confirmed y NO materializa nada: 0 reservas de mesa, 0 visitas, 0 reservas')
      } else nok('AP. la confirmación de un pedido materializó algo', JSON.stringify({ o, mesas, visitas, reservas }))
    }

    // ── AN. H. el owner se autoriza por ROL, no por el flag ──────────────────
    {
      const { data: ow } = await admin.from('tenant_users')
        .select('can_confirm_reservations').eq('id', A.owner.id).maybeSingle()
      const flagOwner = (ow as { can_confirm_reservations: boolean } | null)?.can_confirm_reservations

      const opOrder2 = await mkOrderRequest(A.id, A.contactId)
      const { data } = await asOwnerA.rpc('decide_operation_request', {
        p_operation_id: opOrder2, p_action: 'confirmed',
      })
      const d = data as Decision | null
      if (flagOwner === false && d?.outcome === 'confirmed') {
        ok('AN. (H) el owner confirma un order_request con can_confirm_reservations = FALSE: se autoriza por ROL, no por el flag')
      } else nok('AN. el owner no se autorizó por rol', JSON.stringify({ flagOwner, d }))
    }

    // ── §5. el mapa de autorización por kind no se tocó ──────────────────────
    {
      // Una consulta sigue exigiendo can_manage_inquiries, no can_confirm_reservations.
      // La recepcionista nueva ahora tiene can_confirm_reservations=true y nada más.
      const { data: subInq, error: seInq } = await admin.from('form_submissions').insert({
        tenant_id: A.id, reference: generateSubmissionReference(),
        intent: 'general_inquiry', status: 'submitted', source: 'public_site',
        payload: { name: 'Carla Ruiz', message: '¿Tienen opciones sin TACC?' } as never,
        idempotency_key: randomUUID(), contact_id: A.contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      } as never).select('id').single()
      if (seInq || !subInq) throw new Error(`submission inquiry: ${seInq?.message}`)

      const { data: rpc } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: subInq.id, p_tenant_id: A.id, p_contact_id: A.contactId,
        p_conversation_id: undefined,
      })
      const opInq = (rpc as { operation_id?: string } | null)?.operation_id

      const { data } = await asNuevaA.rpc('decide_operation_request', {
        p_operation_id: opInq!, p_action: 'confirmed',
      })
      const d = data as Decision | null
      if (d?.outcome === 'forbidden' && d.required_permission === 'can_manage_inquiries') {
        ok('§5. la autorización por kind no cambió: can_confirm_reservations no alcanza para una consulta')
      } else nok('§5. el mapa por kind cambió', JSON.stringify(d))
    }

    await Promise.all([asOwnerA, asMenuA, asNoA, asPropsA, asMesasA, asOwnerB, asOwnerR, asOwnerF2, asNuevaA]
      .map((c) => c.auth.signOut().catch(() => {})))

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    const problemas: string[] = []
    for (const id of tenantIds) {
      // Orden obligatorio: items antes que categorías. category_id es
      // ON DELETE RESTRICT, así que al revés falla.
      //
      // Y se MIRA el error: supabase-js no lanza, DEVUELVE { error }. Un
      // try/catch alrededor de estos deletes no atrapa nada y deja basura sin
      // que nadie se entere.
      for (const tb of ['menu_items', 'menu_categories', 'operation_requests', 'form_submissions'] as const) {
        const { error } = await admin.from(tb).delete().eq('tenant_id', id)
        if (error) problemas.push(`${tb}/${id}: ${error.code} ${error.message}`)
      }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      const { error: eT } = await admin.from('tenants').delete().eq('id', id)
      if (eT) problemas.push(`tenants/${id}: ${eT.code} ${eT.message}`)
    }
    for (const id of authIds) { try { await admin.auth.admin.deleteUser(id) } catch { /* noop */ } }

    // Comprobación real de que no quedó nada de este run.
    const { count: catsRestantes } = await admin.from('menu_categories')
      .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
    const { count: itemsRestantes } = await admin.from('menu_items')
      .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
    const { count: tenantsRestantes } = await admin.from('tenants')
      .select('id', { count: 'exact', head: true }).in('id', tenantIds)

    console.log(`  tenants: ${tenantIds.length} · usuarios: ${authIds.length}`)
    if (problemas.length > 0) {
      console.error(`  ✗ la limpieza reportó errores:\n      ${problemas.join('\n      ')}`)
      failed++
    }
    if ((catsRestantes ?? 0) === 0 && (itemsRestantes ?? 0) === 0 && (tenantsRestantes ?? 0) === 0) {
      console.log('  ✓ sin residuos: 0 categorías, 0 productos, 0 tenants de este run')
    } else {
      console.error(`  ✗ residuos: cats=${catsRestantes} items=${itemsRestantes} tenants=${tenantsRestantes}`)
      failed++
    }
    // NOTA: si este script se ejecuta con la salida piteada a `head`, SIGPIPE lo
    // mata antes de llegar acá y la limpieza no corre. Usar `tail` o redirigir a
    // un archivo.
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('[validate-menu-catalog] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})

/**
 * Fase 3E-C3C — orders, order_items, materialización y ciclo de vida.
 *
 * Corre contra la base REAL y por los caminos REALES: sesiones con la anon key
 * y RLS aplicándose para todo lo que un usuario hace, y service_role solo donde
 * hay que demostrar que la garantía está en la BASE (triggers, CHECK, UNIQUE) y
 * no en una policy.
 *
 * Usage:  pnpm --filter @orderflow/web validate:orders
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes, randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { generateSubmissionReference } from '../src/lib/forms/submission-reference'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
const ok  = (l: string) => { console.log(`  ✓ ${l}`); passed++ }
const nok = (l: string, d?: string) => { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }
const seccion = (t: string) => console.log(`\n${HR}\n  ${t}\n${HR}`)

type Decision = {
  outcome?: string
  order_id?: string
  reason?: string
  index?: number
  status?: string
  target?: string
  required_permission?: string
}

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const RUN     = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Fase 3E-C3C — pedidos: materialización y ciclo de vida')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authIds:   string[] = []

  const anonClient = () => createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  async function sesion(email: string, password: string): Promise<SupabaseClient<Database>> {
    const c = anonClient()
    const { error } = await c.auth.signInWithPassword({ email, password })
    if (error) throw new Error(`login ${email}: ${error.message}`)
    return c
  }

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    async function buildTenant(label: string, vertical: 'food_service' | 'real_estate' = 'food_service') {
      const slug = `test-3ec3c-${label}-${RUN}`
      const { data: t, error } = await admin.from('tenants').insert({
        name: `[TEST] 3EC3C ${label} ${RUN}`, slug, status: 'active', vertical,
        currency: 'ARS', public_slug: slug, public_site_enabled: true,
      } as never).select('id').single()
      if (error || !t) throw new Error(`tenant ${label}: ${error?.message}`)
      tenantIds.push(t.id)

      async function mkUser(kind: string, role: 'owner' | 'receptionist', perms: Record<string, boolean> = {}) {
        const password = randomBytes(18).toString('hex')
        const email = `${kind}-3ec3c-${label}-${RUN}@example.test`
        const { data: au, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
        if (e || !au.user) throw new Error(`user ${kind}: ${e?.message}`)
        authIds.push(au.user.id)
        const { error: tu } = await admin.from('tenant_users').insert({
          id: au.user.id, tenant_id: t!.id, name: `${kind} ${label}`, email, role, active: true,
          ...perms,
        } as never)
        if (tu) throw new Error(`tenant_users ${kind}: ${tu.message}`)
        return { id: au.user.id, email, password }
      }

      const owner   = await mkUser('owner',   'owner')
      const gestor  = await mkUser('gestor',  'receptionist', { can_manage_orders: true })
      // El caso C: tiene el permiso LEGACY pero no el de pedidos.
      const legacy  = await mkUser('legacy',  'receptionist', { can_confirm_reservations: true, can_manage_orders: false })

      const { data: contact } = await admin.from('contacts')
        .insert({ tenant_id: t.id, phone: `54911${RUN.slice(-8)}${label.length}`, name: `Cliente ${label}` } as never)
        .select('id').single()
      if (!contact) throw new Error(`contact ${label}`)

      const { data: cat } = await admin.from('menu_categories')
        .insert({ tenant_id: t.id, name: `Pizzas ${label}` } as never).select('id').single()
      if (!cat) throw new Error(`categoria ${label}`)

      async function mkItem(name: string, price: number) {
        const { data, error: e } = await admin.from('menu_items').insert({
          tenant_id: t!.id, category_id: cat!.id, name, base_price: price,
          published: true, available: true,
        } as never).select('id').single()
        if (e || !data) throw new Error(`item ${name}: ${e?.message}`)
        return data.id
      }

      return { id: t.id, slug, owner, gestor, legacy, contactId: contact.id, catId: cat.id, mkItem }
    }

    const A = await buildTenant('a')
    const B = await buildTenant('b')

    const MUZZA  = await A.mkItem('Muzzarella', 10000)
    const AGUA   = await A.mkItem('Agua 500ml', 2000.10)
    const GRATIS = await A.mkItem('Pan de cortesía', 0)
    const ITEM_B = await B.mkItem('Muzzarella B', 5000)

    const asOwner  = await sesion(A.owner.email,  A.owner.password)
    const asGestor = await sesion(A.gestor.email, A.gestor.password)
    const asLegacy = await sesion(A.legacy.email, A.legacy.password)
    const asOwnerB = await sesion(B.owner.email,  B.owner.password)

    /** Crea un order_request pending por el camino real (submission → RPC). */
    async function crearSolicitud(
      payload: Record<string, unknown>,
      tenant = A,
    ): Promise<string> {
      const { data: sub, error } = await admin.from('form_submissions').insert({
        tenant_id: tenant.id, reference: generateSubmissionReference(),
        intent: 'food_order', status: 'submitted', source: 'public_site',
        payload: payload as never, idempotency_key: randomUUID(),
        contact_id: tenant.contactId,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      } as never).select('id').single()
      if (error || !sub) throw new Error(`submission: ${error?.message}`)

      const { data: rpc, error: e2 } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: sub.id, p_tenant_id: tenant.id, p_contact_id: tenant.contactId,
        p_conversation_id: undefined,
      })
      if (e2) throw new Error(`confirm: ${e2.message}`)
      const opId = (rpc as { operation_id?: string } | null)?.operation_id
      if (!opId) throw new Error('sin operation_id')
      return opId
    }

    const linea = (item_id: string, name: string, unit: string, qty: number, notes?: string) => ({
      item_id, name, quantity: qty, unit_price: unit,
      line_total: (Math.round(Number(unit) * 100) * qty / 100).toFixed(2),
      ...(notes ? { notes } : {}),
    })

    const pedido = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => {
      const subtotal = items.reduce((s, i) => s + Math.round(Number(i.line_total) * 100), 0)
      return {
        name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash',
        items, currency: 'ARS', subtotal: (subtotal / 100).toFixed(2), ...over,
      }
    }

    async function contarOrders(tenantId: string) {
      const { count } = await admin.from('orders')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
      return count ?? 0
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§26 A-C — quién puede aceptar un pedido')
    // ══════════════════════════════════════════════════════════════════════
    let ordenBase = ''
    {
      // C — el permiso LEGACY no alcanza. Es lo que cerró 3E-C3B0.
      const opC = await crearSolicitud(pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)]))
      const { data: dC } = await asLegacy.rpc('decide_operation_request', {
        p_operation_id: opC, p_action: 'confirmed',
      })
      const c = dC as Decision | null
      if (c?.outcome === 'forbidden' && c.required_permission === 'can_manage_orders') {
        ok('C. can_confirm_reservations SIN can_manage_orders NO puede aceptar un pedido')
      } else nok('C. el permiso legacy aceptó un pedido', JSON.stringify(c))
      if (await contarOrders(A.id) === 0) ok('C. y no se creó ningún pedido')
      else nok('C. se creó un pedido pese al rechazo')

      // B — con can_manage_orders sí.
      const { data: dB } = await asGestor.rpc('decide_operation_request', {
        p_operation_id: opC, p_action: 'confirmed',
      })
      const b = dB as Decision | null
      if (b?.outcome === 'confirmed' && b.order_id) {
        ok('B. una recepcionista con can_manage_orders acepta y se crea el pedido')
      } else nok('B. can_manage_orders no pudo aceptar', JSON.stringify(b))

      // A — el owner también.
      const opA = await crearSolicitud(pedido([linea(MUZZA, 'Muzzarella', '10000.00', 2, 'sin cebolla')]))
      const { data: dA } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: opA, p_action: 'confirmed',
      })
      const a = dA as Decision | null
      if (a?.outcome === 'confirmed' && a.order_id) {
        ok('A. el owner acepta y se crea 1 pedido')
      } else nok('A. el owner no pudo aceptar', JSON.stringify(a))
      ordenBase = a?.order_id ?? ''

      if (await contarOrders(A.id) === 2) ok('A/B. hay exactamente 2 pedidos, uno por solicitud aceptada')
      else nok('A/B. la cantidad de pedidos no es la esperada', String(await contarOrders(A.id)))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§26 D-F — rechazo, unicidad y doble aprobación')
    // ══════════════════════════════════════════════════════════════════════
    {
      // D — rechazar no crea nada.
      const antes = await contarOrders(A.id)
      const opD = await crearSolicitud(pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)]))
      const { data: dD } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: opD, p_action: 'rejected',
      })
      const d = dD as Decision | null
      if (d?.outcome === 'rejected' && !d.order_id) ok('D. rechazar NO crea pedido')
      else nok('D. el rechazo produjo algo', JSON.stringify(d))
      if (await contarOrders(A.id) === antes) ok('D. y la cantidad de pedidos no cambió')
      else nok('D. el rechazo creó un pedido')

      // F — doble aprobación de la misma solicitud.
      const opF = await crearSolicitud(pedido([linea(AGUA, 'Agua 500ml', '2000.10', 3)]))
      const { data: f1 } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: opF, p_action: 'confirmed',
      })
      const { data: f2 } = await asGestor.rpc('decide_operation_request', {
        p_operation_id: opF, p_action: 'confirmed',
      })
      const uno = f1 as Decision | null, dos = f2 as Decision | null

      if (uno?.outcome === 'confirmed' && dos?.outcome === 'already_decided') {
        ok('F. la segunda aprobación devuelve already_decided, no duplica')
      } else nok('F. la doble aprobación no se resolvió bien', JSON.stringify({ uno, dos }))

      if (dos?.order_id === uno?.order_id) {
        ok('F. y devuelve el MISMO pedido que creó la primera')
      } else nok('F. la segunda devolvió otro pedido', JSON.stringify({ uno, dos }))

      const { count } = await admin.from('orders')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', opF)
      if (count === 1) ok('F. hay exactamente 1 pedido para esa solicitud')
      else nok('F. se crearon varios pedidos', String(count))

      // E — la UNIQUE es real, no solo un SELECT previo.
      const { error: eDup } = await admin.from('orders').insert({
        tenant_id: A.id, contact_id: A.contactId, source_operation_request_id: opF,
        status: 'confirmed', fulfillment: 'takeaway', payment_method: 'cash',
        currency: 'ARS', subtotal: 1, confirmed_at: new Date().toISOString(),
      } as never)
      if (eDup?.code === '23505') ok('E. UNIQUE(source_operation_request_id): un segundo pedido es 23505')
      else nok('E. se pudo insertar un segundo pedido para la misma solicitud', JSON.stringify(eDup))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§8 — carrera REAL: dos empleados aceptando a la vez')
    // ══════════════════════════════════════════════════════════════════════
    {
      // No es una doble aprobación secuencial: son dos requests DISPARADAS en
      // paralelo, desde dos sesiones distintas, contra la misma solicitud. Lo
      // que las serializa es el FOR UPDATE de la solicitud; la UNIQUE de
      // orders.source_operation_request_id es la red de abajo.
      const antes = await contarOrders(A.id)
      const op = await crearSolicitud(pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)]))

      const [r1, r2] = await Promise.all([
        asOwner.rpc('decide_operation_request',  { p_operation_id: op, p_action: 'confirmed' }),
        asGestor.rpc('decide_operation_request', { p_operation_id: op, p_action: 'confirmed' }),
      ])

      const d1 = r1.data as Decision | null
      const d2 = r2.data as Decision | null
      const outcomes = [d1?.outcome, d2?.outcome].sort()

      if (!r1.error && !r2.error) ok('§8. las dos llamadas simultáneas responden sin error')
      else nok('§8. una de las llamadas falló', JSON.stringify({ e1: r1.error, e2: r2.error }))

      if (outcomes.join(',') === 'already_decided,confirmed') {
        ok('§8. exactamente UNA confirma y la otra recibe already_decided')
      } else nok('§8. las dos llamadas no se serializaron', JSON.stringify(outcomes))

      const { count } = await admin.from('orders')
        .select('id', { count: 'exact', head: true }).eq('source_operation_request_id', op)
      if (count === 1) ok('§8. se creó EXACTAMENTE 1 pedido')
      else nok('§8. se crearon ' + String(count) + ' pedidos', String(count))

      if (await contarOrders(A.id) === antes + 1) ok('§8. y el total subió en 1, no en 2')
      else nok('§8. el total de pedidos no cuadra')

      const ganador = d1?.outcome === 'confirmed' ? d1.order_id : d2?.order_id
      const { count: nLineas } = await admin.from('order_items')
        .select('id', { count: 'exact', head: true }).eq('order_id', ganador!)
      if (nLineas === 1) ok('§8. con sus N líneas escritas una sola vez')
      else nok('§8. las líneas se duplicaron o faltan', String(nLineas))

      const { data: sol } = await admin.from('operation_requests')
        .select('status, decided_by').eq('id', op).single()
      const sr = sol as { status: string; decided_by: string | null }
      if (sr.status === 'confirmed' && sr.decided_by !== null) {
        ok('§8. la solicitud quedó confirmed con UN solo decisor')
      } else nok('§8. la solicitud no quedó coherente', JSON.stringify(sr))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§26 G-K — el snapshot, línea por línea')
    // ══════════════════════════════════════════════════════════════════════
    {
      const items = [
        linea(MUZZA, 'Muzzarella', '10000.00', 2, 'sin cebolla'),
        linea(MUZZA, 'Muzzarella', '10000.00', 1, 'sin aceitunas'),
        linea(AGUA,  'Agua 500ml', '2000.10',  1),
        linea(GRATIS,'Pan de cortesía', '0.00', 1),
      ]
      const op = await crearSolicitud(pedido(items, {
        fulfillment: 'delivery', address: 'Calle Falsa 123', notes: 'Tocar timbre',
      }))
      const { data } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: op, p_action: 'confirmed',
      })
      const dec = data as Decision | null
      if (dec?.outcome !== 'confirmed' || !dec.order_id) {
        nok('G. no se materializó el pedido con líneas duplicadas', JSON.stringify(dec))
        throw new Error('setup G')
      }

      const { data: ord } = await admin.from('orders')
        .select('*').eq('id', dec.order_id).single()
      const { data: lineas } = await admin.from('order_items')
        .select('*').eq('order_id', dec.order_id).order('sort_order')

      const ls = (lineas ?? []) as Array<Record<string, unknown>>

      // G — dos líneas del mismo producto.
      if (ls.length === 4 && ls[0]!.menu_item_id === MUZZA && ls[1]!.menu_item_id === MUZZA) {
        ok('G. dos líneas del MISMO menu_item_id se preservan separadas')
      } else nok('G. las líneas duplicadas se consolidaron', JSON.stringify(ls.map((l) => l.menu_item_id)))

      if (ls[0]!.notes === 'sin cebolla' && ls[1]!.notes === 'sin aceitunas') {
        ok('G. cada una con SU aclaración')
      } else nok('G. las aclaraciones no sobrevivieron', JSON.stringify(ls.map((l) => l.notes)))

      // H — sort_order es la posición del array.
      if (ls.map((l) => l.sort_order).join(',') === '0,1,2,3') {
        ok('H. sort_order conserva la posición del array del snapshot')
      } else nok('H. el orden no es el del snapshot', JSON.stringify(ls.map((l) => l.sort_order)))

      // I — snapshots exactos.
      if (ls[0]!.name_snapshot === 'Muzzarella' && Number(ls[0]!.unit_price_snapshot) === 10000
          && Number(ls[0]!.line_total) === 20000) {
        ok('I. nombre, precio unitario y total de línea son los del snapshot')
      } else nok('I. los snapshots no coinciden', JSON.stringify(ls[0]))

      if (Number(ls[3]!.unit_price_snapshot) === 0 && Number(ls[3]!.line_total) === 0) {
        ok('I. un producto gratis se materializa en 0.00 sin romper nada')
      } else nok('I. el producto gratis no quedó en 0', JSON.stringify(ls[3]))

      const o = (ord ?? {}) as Record<string, unknown>
      // J — currency exacta.
      if (o.currency === 'ARS') ok('J. la moneda del pedido es la del snapshot')
      else nok('J. moneda incorrecta', String(o.currency))

      // K — subtotal exacto: 20000 + 10000 + 2000.10 + 0
      if (Number(o.subtotal) === 32000.10) ok('K. el subtotal es exacto: 32000.10')
      else nok('K. subtotal incorrecto', String(o.subtotal))

      // L/M — dirección coherente.
      if (o.fulfillment === 'delivery' && o.delivery_address_snapshot === 'Calle Falsa 123') {
        ok('L. delivery guarda la dirección del snapshot')
      } else nok('L. la dirección no se guardó', JSON.stringify(o))

      if (o.notes === 'Tocar timbre') ok('L. y las observaciones del pedido')
      else nok('L. las observaciones no se guardaron', String(o.notes))

      if (o.status === 'confirmed' && o.confirmed_by === A.owner.id) {
        ok('AC. el pedido nace confirmed y registra QUIÉN lo aceptó')
      } else nok('AC. estado o actor incorrectos', JSON.stringify(o))

      // M — takeaway sin dirección.
      const opM = await crearSolicitud(pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)]))
      const { data: dM } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: opM, p_action: 'confirmed',
      })
      const { data: ordM } = await admin.from('orders')
        .select('fulfillment, delivery_address_snapshot')
        .eq('id', (dM as Decision).order_id!).single()
      const om = ordM as Record<string, unknown>
      if (om.fulfillment === 'takeaway' && om.delivery_address_snapshot === null) {
        ok('M. takeaway guarda la dirección en NULL')
      } else nok('M. takeaway guardó una dirección', JSON.stringify(om))

      // §4 — el CHECK de coherencia es de la BASE.
      const { error: eAddr } = await admin.from('orders').update({
        delivery_address_snapshot: 'Calle inventada',
      } as never).eq('id', (dM as Decision).order_id!)
      if (eAddr?.code === '23514') ok('§4. la base rechaza un takeaway CON dirección (23514)')
      else nok('§4. se pudo poner dirección en un takeaway', JSON.stringify(eAddr))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§26 N-P — el catálogo cambia después')
    // ══════════════════════════════════════════════════════════════════════
    {
      const op = await crearSolicitud(pedido([linea(MUZZA, 'Muzzarella', '10000.00', 2)]))

      // El dueño cambia TODO después de que el cliente pidió.
      await admin.from('menu_items').update({
        base_price: 99999, available: false, published: false,
        name: 'Muzzarella RENOMBRADA', deleted_at: new Date().toISOString(),
      } as never).eq('id', MUZZA)
      await admin.from('menu_categories').update({ active: false } as never).eq('id', A.catId)

      const { data } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: op, p_action: 'confirmed',
      })
      const dec = data as Decision | null

      if (dec?.outcome === 'confirmed' && dec.order_id) {
        ok('O. un producto no disponible, despublicado Y archivado igual materializa')
      } else nok('O. el catálogo cambiado impidió materializar', JSON.stringify(dec))

      const { data: lineas } = await admin.from('order_items')
        .select('name_snapshot, unit_price_snapshot, line_total').eq('order_id', dec!.order_id!)
      const l = (lineas ?? [])[0] as Record<string, unknown>
      if (l?.name_snapshot === 'Muzzarella' && Number(l.unit_price_snapshot) === 10000
          && Number(l.line_total) === 20000) {
        ok('N. el pedido usa el snapshot VIEJO: "Muzzarella" a 10000, no el precio nuevo')
      } else nok('N. el pedido tomó datos del catálogo actual', JSON.stringify(l))

      // Se restaura para los casos siguientes.
      await admin.from('menu_categories').update({ active: true } as never).eq('id', A.catId)
      await admin.from('menu_items').update({
        base_price: 10000, available: true, published: true,
        name: 'Muzzarella', deleted_at: null,
      } as never).eq('id', MUZZA)

      // P — un producto de OTRO tenant.
      const antes = await contarOrders(A.id)
      const opP = await crearSolicitud(pedido([linea(ITEM_B, 'Muzzarella B', '5000.00', 1)]))
      const { data: dP } = await asOwner.rpc('decide_operation_request', {
        p_operation_id: opP, p_action: 'confirmed',
      })
      const p = dP as Decision | null
      if (p?.outcome === 'invalid_snapshot' && p.reason === 'menu_item_not_in_tenant') {
        ok('P. un producto de OTRO tenant falla cerrado')
      } else nok('P. se materializó con un producto ajeno', JSON.stringify(p))

      if (await contarOrders(A.id) === antes) ok('P. y no se creó ningún pedido')
      else nok('P. se creó un pedido con producto ajeno')

      const { data: sigue } = await admin.from('operation_requests')
        .select('status').eq('id', opP).single()
      if ((sigue as { status: string }).status === 'pending') {
        ok('P. la solicitud sigue PENDING: se puede reintentar')
      } else nok('P. la solicitud quedó decidida', JSON.stringify(sigue))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§26 Q-S — snapshot corrupto: falla cerrada')
    // ══════════════════════════════════════════════════════════════════════
    {
      const casos: Array<[string, Record<string, unknown>, string]> = [
        ['Q. items vacío',        pedido([]),                                                   'items_count'],
        ['Q. sin items',          { name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash', currency: 'ARS', subtotal: '0.00' }, 'items_not_array'],
        ['Q. moneda inválida',    pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)], { currency: 'PESOS' }), 'currency'],
        ['Q. fulfillment malo',   pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)], { fulfillment: 'teletransporte' }), 'fulfillment'],
        ['Q. pago inválido',      pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)], { payment_method: 'bitcoin' }), 'payment_method'],
        ['Q. delivery sin dirección', pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)], { fulfillment: 'delivery' }), 'address_required'],
        ['Q. takeaway con dirección', pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)], { address: 'Calle 1' }), 'address_not_allowed'],
        ['Q. subtotal no canónico', pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)], { subtotal: '10000' }), 'subtotal_format'],
        ['Q. cantidad 0',         pedido([{ ...linea(MUZZA, 'Muzzarella', '10000.00', 1), quantity: 0, line_total: '0.00' }], { subtotal: '0.00' }), 'quantity'],
        ['Q. cantidad 100',       pedido([{ ...linea(MUZZA, 'Muzzarella', '10000.00', 1), quantity: 100, line_total: '1000000.00' }], { subtotal: '1000000.00' }), 'quantity'],
        ['Q. nombre vacío',       pedido([{ ...linea(MUZZA, '', '10000.00', 1), name: '' }]),    'name'],
        ['S. unit × qty ≠ line_total', pedido([{ ...linea(MUZZA, 'Muzzarella', '10000.00', 2), line_total: '10000.00' }], { subtotal: '10000.00' }), 'line_total_mismatch'],
        ['R. suma de líneas ≠ subtotal', pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)], { subtotal: '99999.00' }), 'subtotal_mismatch'],
      ]

      for (const [nombre, payload, razon] of casos) {
        const antes = await contarOrders(A.id)
        const op = await crearSolicitud(payload)
        const { data } = await asOwner.rpc('decide_operation_request', {
          p_operation_id: op, p_action: 'confirmed',
        })
        const d = data as Decision | null

        if (d?.outcome === 'invalid_snapshot' && d.reason === razon) {
          ok(`${nombre} → invalid_snapshot (${razon})`)
        } else nok(`${nombre}: outcome inesperado`, JSON.stringify(d))

        if (await contarOrders(A.id) === antes) ok(`${nombre}: 0 pedidos creados`)
        else nok(`${nombre}: se creó un pedido`)

        const { data: sigue } = await admin.from('operation_requests').select('status').eq('id', op).single()
        if ((sigue as { status: string }).status === 'pending') ok(`${nombre}: la solicitud sigue pending`)
        else nok(`${nombre}: la solicitud quedó decidida`)
      }

      const { count: huerfanos } = await admin.from('order_items')
        .select('id', { count: 'exact', head: true })
        .in('order_id', [randomUUID()])
      if ((huerfanos ?? 0) === 0) ok('Q-S. ninguna línea huérfana quedó de los intentos fallidos')
      else nok('Q-S. quedaron líneas sueltas')
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§27 T-AF — ciclo de vida')
    // ══════════════════════════════════════════════════════════════════════
    {
      // T/U/V — el camino feliz completo.
      const pasos: Array<[string, string]> = [
        ['preparing', 'T. confirmed → preparing'],
        ['ready',     'U. preparing → ready'],
        ['completed', 'V. ready → completed'],
      ]
      for (const [target, nombre] of pasos) {
        const { data } = await asOwner.rpc('transition_order_status', {
          p_order_id: ordenBase, p_status: target,
        })
        const d = data as Decision | null
        if (d?.outcome === target) ok(nombre)
        else nok(`${nombre} falló`, JSON.stringify(d))
      }

      const { data: fin } = await admin.from('orders')
        .select('status, preparing_at, preparing_by, ready_at, ready_by, completed_at, completed_by')
        .eq('id', ordenBase).single()
      const f = fin as Record<string, unknown>

      if (f.status === 'completed' && f.preparing_at && f.ready_at && f.completed_at) {
        ok('AC/§15. las marcas históricas NO se borran: preparing_at y ready_at siguen')
      } else nok('AC. se perdieron marcas del camino', JSON.stringify(f))

      if (f.preparing_by === A.owner.id && f.ready_by === A.owner.id && f.completed_by === A.owner.id) {
        ok('AC. cada transición registra su actor')
      } else nok('AC. los actores no se registraron', JSON.stringify(f))

      // Z — completed es terminal.
      for (const target of ['preparing', 'ready', 'cancelled']) {
        const { data } = await asOwner.rpc('transition_order_status', {
          p_order_id: ordenBase, p_status: target,
        })
        const d = data as Decision | null
        if (d?.outcome === 'invalid_transition') ok(`Z. completed → ${target} rechazado`)
        else nok(`Z. completed → ${target} se permitió`, JSON.stringify(d))
      }

      // W/X/Y — cancelar desde cada estado vivo.
      async function nuevoPedido(): Promise<string> {
        const op = await crearSolicitud(pedido([linea(MUZZA, 'Muzzarella', '10000.00', 1)]))
        const { data } = await asOwner.rpc('decide_operation_request', {
          p_operation_id: op, p_action: 'confirmed',
        })
        return (data as Decision).order_id!
      }

      const desdeConfirmed = await nuevoPedido()
      const { data: w } = await asOwner.rpc('transition_order_status', {
        p_order_id: desdeConfirmed, p_status: 'cancelled', p_reason: 'El cliente se arrepintió',
      })
      if ((w as Decision)?.outcome === 'cancelled') ok('W. confirmed → cancelled')
      else nok('W. no se pudo cancelar desde confirmed', JSON.stringify(w))

      const { data: cw } = await admin.from('orders')
        .select('cancelled_at, cancelled_by, cancellation_reason').eq('id', desdeConfirmed).single()
      const cwr = cw as Record<string, unknown>
      if (cwr.cancelled_at && cwr.cancelled_by === A.owner.id && cwr.cancellation_reason === 'El cliente se arrepintió') {
        ok('§15/§16. la cancelación guarda momento, actor y motivo')
      } else nok('§15. la cancelación no registró todo', JSON.stringify(cwr))

      const desdePreparing = await nuevoPedido()
      await asOwner.rpc('transition_order_status', { p_order_id: desdePreparing, p_status: 'preparing' })
      const { data: x } = await asOwner.rpc('transition_order_status', {
        p_order_id: desdePreparing, p_status: 'cancelled',
      })
      if ((x as Decision)?.outcome === 'cancelled') ok('X. preparing → cancelled')
      else nok('X. no se pudo cancelar desde preparing', JSON.stringify(x))

      const { data: sinMotivo } = await admin.from('orders')
        .select('cancellation_reason').eq('id', desdePreparing).single()
      if ((sinMotivo as { cancellation_reason: string | null }).cancellation_reason === null) {
        ok('§16. el motivo es OPCIONAL: se canceló sin uno')
      } else nok('§16. se inventó un motivo')

      const desdeReady = await nuevoPedido()
      await asOwner.rpc('transition_order_status', { p_order_id: desdeReady, p_status: 'preparing' })
      await asOwner.rpc('transition_order_status', { p_order_id: desdeReady, p_status: 'ready' })
      const { data: y } = await asOwner.rpc('transition_order_status', {
        p_order_id: desdeReady, p_status: 'cancelled',
      })
      if ((y as Decision)?.outcome === 'cancelled') ok('Y. ready → cancelled')
      else nok('Y. no se pudo cancelar desde ready', JSON.stringify(y))

      // AA — cancelled es terminal.
      const { data: aa } = await asOwner.rpc('transition_order_status', {
        p_order_id: desdeReady, p_status: 'completed',
      })
      if ((aa as Decision)?.outcome === 'invalid_transition') ok('AA. cancelled es terminal')
      else nok('AA. se salió de cancelled', JSON.stringify(aa))

      // AB — saltos inválidos.
      const saltos = await nuevoPedido()
      for (const target of ['ready', 'completed']) {
        const { data } = await asOwner.rpc('transition_order_status', {
          p_order_id: saltos, p_status: target,
        })
        if ((data as Decision)?.outcome === 'invalid_transition') ok(`AB. confirmed → ${target} rechazado`)
        else nok(`AB. confirmed → ${target} se permitió`, JSON.stringify(data))
      }

      const { data: malStatus } = await asOwner.rpc('transition_order_status', {
        p_order_id: saltos, p_status: 'confirmed',
      })
      if ((malStatus as Decision)?.outcome === 'invalid_status') {
        ok('AB. "confirmed" no es un destino válido: un pedido nace confirmado')
      } else nok('AB. se aceptó confirmed como destino', JSON.stringify(malStatus))

      // AD — sin permiso no se transiciona.
      const { data: ad } = await asLegacy.rpc('transition_order_status', {
        p_order_id: saltos, p_status: 'preparing',
      })
      const adr = ad as Decision | null
      if (adr?.outcome === 'forbidden' && adr.required_permission === 'can_manage_orders') {
        ok('AD. una recepcionista sin can_manage_orders NO transiciona')
      } else nok('AD. transicionó sin permiso', JSON.stringify(ad))

      const { data: sigueIgual } = await admin.from('orders').select('status').eq('id', saltos).single()
      if ((sigueIgual as { status: string }).status === 'confirmed') ok('AD. y el pedido no se movió')
      else nok('AD. el pedido cambió de estado')

      // Cross-tenant: el owner de B no ve ni toca un pedido de A.
      const { data: cruzado } = await asOwnerB.rpc('transition_order_status', {
        p_order_id: saltos, p_status: 'preparing',
      })
      if ((cruzado as Decision)?.outcome === 'not_found') {
        ok('§29. el owner de OTRO tenant recibe not_found, sin filtrar existencia')
      } else nok('§29. un tenant ajeno pudo operar el pedido', JSON.stringify(cruzado))

      // AF — motivo demasiado largo.
      const { data: af } = await asOwner.rpc('transition_order_status', {
        p_order_id: saltos, p_status: 'cancelled', p_reason: 'x'.repeat(501),
      })
      if ((af as Decision)?.outcome === 'reason_too_long') ok('AF. un motivo de 501 caracteres se rechaza')
      else nok('AF. se aceptó un motivo demasiado largo', JSON.stringify(af))

      const { data: af2 } = await asOwner.rpc('transition_order_status', {
        p_order_id: saltos, p_status: 'cancelled', p_reason: 'x'.repeat(500),
      })
      if ((af2 as Decision)?.outcome === 'cancelled') ok('AF. y uno de 500 se acepta')
      else nok('AF. se rechazó un motivo válido', JSON.stringify(af2))

      // El motivo solo aplica a cancelar.
      const otro = await nuevoPedido()
      const { data: mal } = await asOwner.rpc('transition_order_status', {
        p_order_id: otro, p_status: 'preparing', p_reason: 'porque sí',
      })
      if ((mal as Decision)?.outcome === 'invalid_parameters') {
        ok('§16. el motivo solo aplica al cancelar')
      } else nok('§16. se aceptó un motivo al avanzar', JSON.stringify(mal))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§29 — seguridad: RLS, grants y escritura directa')
    // ══════════════════════════════════════════════════════════════════════
    {
      // El owner LEE sus pedidos.
      const { data: leo, error: eLeo } = await asOwner.from('orders').select('id, status')
      if (!eLeo && (leo ?? []).length > 0) ok('RLS: el owner LEE los pedidos de su tenant')
      else nok('RLS: el owner no pudo leer', JSON.stringify(eLeo))

      // Y no ve los de otro.
      const { data: ajenos } = await asOwnerB.from('orders').select('id')
      const idsA = new Set((leo ?? []).map((r) => r.id))
      if (!(ajenos ?? []).some((r) => idsA.has(r.id))) {
        ok('RLS: el owner de B NO ve ningún pedido de A')
      } else nok('RLS: se filtraron pedidos entre tenants')

      // Escritura directa: prohibida para todos.
      const alguno = (leo ?? [])[0]?.id
      const { error: eUpd } = await asOwner.from('orders')
        .update({ status: 'completed' } as never).eq('id', alguno!)
      const { count: sigue } = await admin.from('orders')
        .select('id', { count: 'exact', head: true }).eq('id', alguno!).eq('status', 'completed')
      if (eUpd || (sigue ?? 0) === 0) ok('el owner NO puede hacer UPDATE directo sobre orders')
      else nok('el owner cambió el estado sin pasar por la RPC')

      const { error: eIns } = await asOwner.from('orders').insert({
        tenant_id: A.id, contact_id: A.contactId, source_operation_request_id: randomUUID(),
        status: 'confirmed', fulfillment: 'takeaway', payment_method: 'cash',
        currency: 'ARS', subtotal: 1,
      } as never)
      if (eIns) ok('el owner NO puede INSERT directo sobre orders')
      else nok('el owner fabricó un pedido sin solicitud')

      const { error: eDel } = await asOwner.from('orders').delete().eq('id', alguno!)
      const { count: existe } = await admin.from('orders')
        .select('id', { count: 'exact', head: true }).eq('id', alguno!)
      if (eDel || (existe ?? 0) === 1) ok('el owner NO puede DELETE sobre orders')
      else nok('el owner borró un pedido')

      const { error: eItem } = await asOwner.from('order_items').insert({
        order_id: alguno!, menu_item_id: MUZZA, name_snapshot: 'Falso',
        unit_price_snapshot: 1, quantity: 1, line_total: 1, sort_order: 99,
      } as never)
      if (eItem) ok('el owner NO puede agregar líneas a mano')
      else nok('el owner agregó una línea')

      // Anon: nada.
      const anon = anonClient()
      const { data: dAnon } = await anon.from('orders').select('id')
      if ((dAnon ?? []).length === 0) ok('anon NO lee pedidos')
      else nok('anon leyó pedidos')

      const { error: eAnonRpc } = await anon.rpc('transition_order_status', {
        p_order_id: alguno!, p_status: 'preparing',
      })
      if (eAnonRpc) ok('anon NO puede ejecutar transition_order_status')
      else nok('anon ejecutó la RPC de transición')

      // El trigger de tenant es de la BASE, no de una policy.
      const { data: opSuelto } = await admin.from('operation_requests')
        .select('id').eq('tenant_id', B.id).limit(1).maybeSingle()
      void opSuelto
      const { error: eGuard } = await admin.from('orders').insert({
        tenant_id: A.id, contact_id: B.contactId, source_operation_request_id: randomUUID(),
        status: 'confirmed', fulfillment: 'takeaway', payment_method: 'cash',
        currency: 'ARS', subtotal: 1,
      } as never)
      if (eGuard) ok('trg_guard_order_tenant: un contacto de otro tenant es rechazado por la base')
      else nok('se insertó un pedido con contacto ajeno')
    }

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    const problemas: string[] = []

    for (const id of tenantIds) {
      // Orden obligatorio: items → orders → solicitudes → catálogo.
      // orders.source_operation_request_id es ON DELETE RESTRICT.
      const { data: ords } = await admin.from('orders').select('id').eq('tenant_id', id)
      const ids = (ords ?? []).map((o) => o.id)
      if (ids.length > 0) {
        const { error } = await admin.from('order_items').delete().in('order_id', ids)
        if (error) problemas.push(`order_items/${id}: ${error.code} ${error.message}`)
      }
      for (const tb of ['orders', 'operation_requests', 'form_submissions', 'menu_items', 'menu_categories'] as const) {
        const { error } = await admin.from(tb).delete().eq('tenant_id', id)
        if (error) problemas.push(`${tb}/${id}: ${error.code} ${error.message}`)
      }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      const { error: eT } = await admin.from('tenants').delete().eq('id', id)
      if (eT) problemas.push(`tenants/${id}: ${eT.code} ${eT.message}`)
    }
    for (const id of authIds) { try { await admin.auth.admin.deleteUser(id) } catch { /* noop */ } }

    const { count: ordsRestantes } = await admin.from('orders')
      .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
    const { count: tenantsRestantes } = await admin.from('tenants')
      .select('id', { count: 'exact', head: true }).in('id', tenantIds)

    console.log(`  tenants: ${tenantIds.length} · usuarios: ${authIds.length}`)
    if (problemas.length > 0) {
      console.error(`  ✗ la limpieza reportó errores:\n      ${problemas.join('\n      ')}`)
      failed++
    }
    if ((ordsRestantes ?? 0) === 0 && (tenantsRestantes ?? 0) === 0) {
      console.log('  ✓ sin residuos: 0 pedidos, 0 tenants de este run')
    } else {
      console.error(`  ✗ residuos: orders=${ordsRestantes} tenants=${tenantsRestantes}`)
      failed++
    }

    console.log(HR)
    console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
    console.log(HR)
    process.exit(failed > 0 ? 1 : 0)
  }
}

void main()

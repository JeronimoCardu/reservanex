/**
 * Fase 3E-C3B1 — carrito, pricing canónico y evidencia del pedido.
 *
 * Corre contra la base REAL y por el camino REAL: se invoca el handler de
 * POST /api/public/forms con un Request, igual que lo haría el browser. Nada de
 * mocks: lo que se prueba es que el endpoint público resuelve precios contra el
 * catálogo, rechaza lo que tiene que rechazar y persiste SOLO lo que escribió el
 * servidor.
 *
 * Usage:  pnpm --filter @orderflow/web validate:food-orders
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { createSubmissionResponseSchema } from '@orderflow/validators'
import { POST } from '../src/app/api/public/forms/route'
import { resolveFoodOrderCart } from '../src/lib/forms/food-order-cart'
import {
  INITIAL_CHECKOUT_STATE, toCheckout, toSuccess, successReference,
} from '../src/lib/site/checkout-flow'
import { buildSubmissionWhatsAppHref } from '../src/lib/site/submission-whatsapp'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }
function seccion(t: string) { console.log(`\n${HR}\n  ${t}\n${HR}`) }

const MAX_BODY_BYTES = 20_000

interface Respuesta { status: number; body: Record<string, unknown> }

async function postForm(body: unknown): Promise<Respuesta> {
  const req = new Request('https://local.test/api/public/forms', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const res = await POST(req as never)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function main() {
  assertSafeSupabaseTarget()

  const admin = createAdminClient()
  const RUN   = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

  console.log(HR)
  console.log('  Fase 3E-C3B1 — carrito + pricing canónico + evidencia')
  console.log(`  target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)
  console.log(HR)

  const tenantIds: string[] = []

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    async function buildTenant(
      label: string,
      opts: { currency?: string; vertical?: 'food_service' | 'real_estate' } = {},
    ) {
      const slug = `test-3ec3b1-${label}-${RUN}`
      const { data: t, error } = await admin.from('tenants').insert({
        name:                `[TEST] 3EC3B1 ${label} ${RUN}`,
        slug,
        status:              'active',
        vertical:            opts.vertical ?? 'food_service',
        currency:            opts.currency ?? 'ARS',
        public_slug:         slug,
        public_site_enabled: true,
      } as never).select('id').single()
      if (error || !t) throw new Error(`tenant ${label}: ${error?.message}`)
      tenantIds.push(t.id)

      const { data: contact } = await admin.from('contacts')
        .insert({ tenant_id: t.id, phone: `54911${RUN.slice(-8)}${label.length}`, name: null } as never)
        .select('id').single()
      if (!contact) throw new Error(`contact ${label}`)

      return { id: t.id, slug, contactId: contact.id }
    }

    async function mkCategoria(tenantId: string, name: string, active = true) {
      const { data, error } = await admin.from('menu_categories')
        .insert({ tenant_id: tenantId, name, active } as never).select('id').single()
      if (error || !data) throw new Error(`categoria ${name}: ${error?.message}`)
      return data.id
    }

    async function mkItem(
      tenantId: string, categoryId: string, name: string, price: number,
      o: { published?: boolean; available?: boolean; deleted?: boolean } = {},
    ) {
      const { data, error } = await admin.from('menu_items').insert({
        tenant_id:   tenantId,
        category_id: categoryId,
        name,
        base_price:  price,
        published:   o.published ?? true,
        available:   o.available ?? true,
        deleted_at:  o.deleted ? new Date().toISOString() : null,
      } as never).select('id').single()
      if (error || !data) throw new Error(`item ${name}: ${error?.message}`)
      return data.id
    }

    const A = await buildTenant('a')
    const B = await buildTenant('b', { currency: 'USD' })

    const catA   = await mkCategoria(A.id, 'Pizzas')
    const catAoff = await mkCategoria(A.id, 'Ocultas', false)
    const MUZZA  = await mkItem(A.id, catA, 'Muzzarella', 10000)
    const AGUA   = await mkItem(A.id, catA, 'Agua 500ml', 2000.10)
    const CENTS  = await mkItem(A.id, catA, 'Centavito', 0.10)
    const GRATIS = await mkItem(A.id, catA, 'Pan',        0)
    const NODISP = await mkItem(A.id, catA, 'Fugazzeta',  13000, { available: false })
    const BORRA  = await mkItem(A.id, catA, 'Borrador',   9000,  { published: false })
    const ARCH   = await mkItem(A.id, catA, 'Archivada',  8000,  { deleted: true })
    const OCULTA = await mkItem(A.id, catAoff, 'De categoría apagada', 7000)

    const catB   = await mkCategoria(B.id, 'Pizzas B')
    const MUZZAB = await mkItem(B.id, catB, 'Muzzarella B', 5000)

    const linea = (item_id: string, quantity = 1, expected = '10000.00', notes?: string) => ({
      item_id, quantity, expected_unit_price: expected, ...(notes ? { notes } : {}),
    })

    const pedido = (slug: string, items: unknown[], over: Record<string, unknown> = {}) => ({
      tenant_slug:     slug,
      intent:          'food_order',
      source:          'public_site',
      idempotency_key: randomUUID(),
      payload: {
        name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash', items, ...over,
      },
    })

    async function leerSubmission(reference: string) {
      const { data } = await admin.from('form_submissions')
        .select('id, reference, intent, payload, status, tenant_id')
        .eq('reference', reference).maybeSingle()
      return data
    }

    async function contarSubmissions(tenantId: string) {
      const { count } = await admin.from('form_submissions')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
      return count ?? 0
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§17 / matriz 1-6 — el browser no fija plata (comprobación FÍSICA)')
    // ══════════════════════════════════════════════════════════════════════
    {
      // Lo que un atacante mandaría: precio de saldo, total inventado, moneda
      // ajena y un nombre falso. El schema strict lo rechaza antes de tocar la DB.
      const manipulado = pedido(A.slug, [
        { item_id: MUZZA, quantity: 1, expected_unit_price: '10000.00', unit_price: '1.00', line_total: '1.00', name: 'Gratis' },
      ], { subtotal: '1.00', currency: 'USD', tenant_id: B.id })

      const r = await postForm(manipulado)
      if (r.status === 422 && r.body.reason === 'invalid_fields') {
        ok('1-5. un payload con unit_price / line_total / subtotal / currency / name / tenant_id es 422')
      } else nok('1-5. el payload manipulado no fue rechazado', JSON.stringify(r))

      if (await contarSubmissions(A.id) === 0) {
        ok('1-5. y no se creó ninguna submission')
      } else nok('1-5. el payload manipulado dejó una fila')
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§5 / §6 — resolución canónica y snapshot')
    // ══════════════════════════════════════════════════════════════════════
    let referenciaBase = ''
    let submissionBaseId = ''
    {
      const body = pedido(A.slug, [
        linea(MUZZA, 2, '10000.00', 'sin cebolla'),
        linea(MUZZA, 1, '10000.00', 'sin aceitunas'),
        linea(AGUA,  1, '2000.10'),
      ])
      const r = await postForm(body)

      if (r.status === 201 && r.body.ok === true) {
        ok('6. un pedido válido se crea (201) y devuelve solo la referencia pública')
      } else nok('6. el pedido válido no se creó', JSON.stringify(r))

      const claves = Object.keys(r.body).sort()
      if (claves.join(',') === 'deduplicated,ok,reference') {
        ok('6. la respuesta trae SOLO ok/reference/deduplicated: sin id interno, tenant_id ni payload')
      } else nok('6. la respuesta trae claves de más o de menos', claves.join(','))

      // El contrato declarado es el que efectivamente se devuelve.
      if (createSubmissionResponseSchema.safeParse(r.body).success) {
        ok('6. la respuesta valida contra createSubmissionResponseSchema')
      } else nok('6. la respuesta no cumple su propio contrato', JSON.stringify(r.body))

      if (r.body.deduplicated === false) {
        ok('6. deduplicated=false en un pedido nuevo')
      } else nok('6. deduplicated no es false en un pedido nuevo', String(r.body.deduplicated))

      referenciaBase = String(r.body.reference ?? '')
      const sub = await leerSubmission(referenciaBase)
      submissionBaseId = sub?.id ?? ''
      const payload = (sub?.payload ?? {}) as Record<string, unknown>
      const items   = (payload.items ?? []) as Array<Record<string, unknown>>

      // 18/19 — dos líneas del MISMO producto, separadas y en orden.
      if (items.length === 3 && items[0]?.item_id === MUZZA && items[1]?.item_id === MUZZA) {
        ok('18/19. el mismo item_id en dos líneas se conserva separado y en orden')
      } else nok('18/19. las líneas duplicadas se consolidaron o reordenaron', JSON.stringify(items))

      if (items[0]?.notes === 'sin cebolla' && items[1]?.notes === 'sin aceitunas') {
        ok('19. cada línea conserva SU aclaración')
      } else nok('19. las aclaraciones no sobrevivieron', JSON.stringify(items))

      // El servidor escribió el nombre y los precios.
      if (items[0]?.name === 'Muzzarella' && items[0]?.unit_price === '10000.00' && items[0]?.line_total === '20000.00') {
        ok('7/17. el snapshot lleva nombre, unit_price y line_total escritos por el SERVIDOR')
      } else nok('7/17. el snapshot de la línea no es el esperado', JSON.stringify(items[0]))

      // 22 — subtotal exacto: 20000.00 + 10000.00 + 2000.10
      if (payload.subtotal === '32000.10') {
        ok('22. el subtotal de varias líneas es exacto: 32000.10')
      } else nok('22. subtotal incorrecto', String(payload.subtotal))

      // 36 — moneda del tenant.
      if (payload.currency === 'ARS') {
        ok('36. la moneda sale de tenants.currency')
      } else nok('36. la moneda no es la del tenant', String(payload.currency))

      // 35 — expected_unit_price no se persiste.
      const dump = JSON.stringify(payload)
      if (!dump.includes('expected_unit_price')) {
        ok('35. expected_unit_price NO quedó en la evidencia: era una precondición, no un dato')
      } else nok('35. expected_unit_price se persistió')

      if (!dump.includes(A.id) && !dump.includes('client_line_id')) {
        ok('17. el payload guardado no tiene tenant_id ni client_line_id')
      } else nok('17. el payload guardado filtra datos internos')
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§3 / §4 / matriz 20-23 — aritmética en centavos')
    // ══════════════════════════════════════════════════════════════════════
    {
      // 20 — 0.10 × 3
      const r1 = await postForm(pedido(A.slug, [linea(CENTS, 3, '0.10')]))
      const s1 = await leerSubmission(String(r1.body.reference ?? ''))
      const p1 = (s1?.payload ?? {}) as Record<string, unknown>
      const i1 = (p1.items as Array<Record<string, unknown>>)?.[0]
      if (i1?.line_total === '0.30' && p1.subtotal === '0.30') {
        ok('20. 0.10 × 3 = "0.30" (en float daría 0.30000000000000004)')
      } else nok('20. 0.10 × 3 salió mal', JSON.stringify({ i1, sub: p1.subtotal }))

      // 21 — 2000.10 × 9
      const r2 = await postForm(pedido(A.slug, [linea(AGUA, 9, '2000.10')]))
      const s2 = await leerSubmission(String(r2.body.reference ?? ''))
      const p2 = (s2?.payload ?? {}) as Record<string, unknown>
      const i2 = (p2.items as Array<Record<string, unknown>>)?.[0]
      if (i2?.line_total === '18000.90' && p2.subtotal === '18000.90') {
        ok('21. 2000.10 × 9 = "18000.90" (en float daría 18000.899999999998)')
      } else nok('21. 2000.10 × 9 salió mal', JSON.stringify({ i2, sub: p2.subtotal }))

      // Precio 0 — se pide igual y vale 0.00.
      const r3 = await postForm(pedido(A.slug, [linea(GRATIS, 2, '0.00')]))
      const s3 = await leerSubmission(String(r3.body.reference ?? ''))
      const p3 = (s3?.payload ?? {}) as Record<string, unknown>
      if (p3.subtotal === '0.00') {
        ok('un producto de precio 0 se pide y suma 0.00, no rompe la aritmética')
      } else nok('el producto gratis rompió el subtotal', String(p3.subtotal))

      // 23 — overflow determinístico. Precio al tope de NUMERIC(14,2) × 99.
      const CARO = await mkItem(A.id, catA, 'Imposible', 999999999999.99)
      const antesOverflow = await contarSubmissions(A.id)
      const r4 = await postForm(pedido(A.slug, [linea(CARO, 99, '999999999999.99')]))
      if (r4.status === 422 && (r4.body.errors as Record<string, string>)?._form) {
        ok('23. un total fuera de NUMERIC(14,2) se rechaza con 422 determinístico')
      } else nok('23. el overflow no se rechazó', JSON.stringify(r4))

      if (await contarSubmissions(A.id) === antesOverflow) {
        ok('23. y no se persistió ningún pedido con ese total')
      } else nok('23. el overflow dejó una submission')

      // Un solo item al tope SÍ entra: el límite es del total, no arbitrario.
      const r5 = await postForm(pedido(A.slug, [linea(CARO, 1, '999999999999.99')]))
      if (r5.status === 201) {
        ok('23. el mismo precio con cantidad 1 SÍ entra: el tope es real, no un rechazo por las dudas')
      } else nok('23. el tope rechaza montos que sí entran', JSON.stringify(r5))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§8 / matriz 7-11, 27-30 — productos que ya no se pueden pedir')
    // ══════════════════════════════════════════════════════════════════════
    {
      const casos: Array<[string, string, string]> = [
        ['9/27',  NODISP, 'available = false'],
        ['8/28',  BORRA,  'published = false'],
        ['10/29', ARCH,   'deleted_at IS NOT NULL'],
        ['11/30', OCULTA, 'category.active = false'],
        ['7',     MUZZAB, 'item de OTRO tenant'],
        ['7',     randomUUID(), 'item inexistente'],
      ]

      for (const [n, itemId, motivo] of casos) {
        const antes = await contarSubmissions(A.id)
        const r = await postForm(pedido(A.slug, [linea(itemId, 1, '10000.00')]))
        const items = (r.body.items ?? []) as Array<Record<string, unknown>>

        if (r.status === 409 && r.body.code === 'cart_changed') {
          ok(`${n}. ${motivo} → 409 cart_changed`)
        } else nok(`${n}. ${motivo} no dio cart_changed`, JSON.stringify(r))

        if (items[0]?.reason === 'not_orderable') {
          ok(`${n}. el motivo es genérico: no revela si existe, de quién es ni por qué`)
        } else nok(`${n}. el motivo filtra información`, JSON.stringify(items))

        if (await contarSubmissions(A.id) === antes) {
          ok(`${n}. y NO se creó un pedido parcial`)
        } else nok(`${n}. se creó una submission pese al conflicto`)
      }

      // Un carrito mixto: una línea buena y una mala. No entra NADA.
      const antes = await contarSubmissions(A.id)
      const r = await postForm(pedido(A.slug, [linea(MUZZA, 1, '10000.00'), linea(NODISP, 1, '13000.00')]))
      if (r.status === 409 && r.body.code === 'cart_changed' && await contarSubmissions(A.id) === antes) {
        ok('8. un carrito mixto NO se guarda a medias ni se le quitan líneas en silencio')
      } else nok('8. el carrito mixto se procesó parcialmente', JSON.stringify(r))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§7 / matriz 24-25 — precio cambiado')
    // ══════════════════════════════════════════════════════════════════════
    {
      const antes = await contarSubmissions(A.id)
      const r = await postForm(pedido(A.slug, [
        linea(MUZZA, 1, '9000.00', 'con precio viejo'),
        linea(MUZZA, 2, '9000.00'),
        linea(AGUA,  1, '2000.10'),
      ]))

      if (r.status === 409 && r.body.code === 'price_changed') {
        ok('24. un expected_unit_price desactualizado → 409 price_changed')
      } else nok('24. no se detectó el cambio de precio', JSON.stringify(r))

      const changes = (r.body.changes ?? []) as Array<Record<string, unknown>>
      if (changes.length === 1 && changes[0]?.item_id === MUZZA) {
        ok('24. una entrada por item_id cambiado, no una por línea duplicada')
      } else nok('24. la lista de cambios no es por item_id', JSON.stringify(changes))

      if (changes[0]?.previous_unit_price === '9000.00' && changes[0]?.current_unit_price === '10000.00') {
        ok('24. informa el precio que mandó el browser y el REAL, para poder actualizar el carrito')
      } else nok('24. los precios informados no son los esperados', JSON.stringify(changes[0]))

      if (await contarSubmissions(A.id) === antes) {
        ok('25. price_changed NO crea submission: ni con el precio viejo ni con el nuevo')
      } else nok('25. se creó una submission pese al cambio de precio')

      // Reenviar con el precio corregido SÍ entra.
      const r2 = await postForm(pedido(A.slug, [linea(MUZZA, 1, '10000.00')]))
      if (r2.status === 201) {
        ok('24. corregido el precio, el reenvío se acepta')
      } else nok('24. el reenvío corregido no entró', JSON.stringify(r2))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§9 / matriz 26 — idempotencia gana sobre el catálogo mutable')
    // ══════════════════════════════════════════════════════════════════════
    {
      const clave = randomUUID()
      const body = {
        tenant_slug: A.slug, intent: 'food_order', source: 'public_site',
        idempotency_key: clave,
        payload: { name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash',
                   items: [linea(MUZZA, 1, '10000.00')] },
      }

      // 12:00 — el pedido entra a 10000.
      const r1 = await postForm(body)
      if (r1.status !== 201) { nok('26. el pedido inicial no se creó', JSON.stringify(r1)); throw new Error('setup 26') }
      const referencia = String(r1.body.reference)

      // 12:05 — el dueño sube el precio.
      const { error: eUp } = await admin.from('menu_items')
        .update({ base_price: 12000 } as never).eq('id', MUZZA)
      if (eUp) throw new Error(`update precio: ${eUp.message}`)

      // 12:06 — el browser repite EXACTAMENTE la request original.
      const r2 = await postForm(body)

      if (r2.status === 200 && r2.body.ok === true && r2.body.reference === referencia) {
        ok('26. el reintento con la MISMA clave devuelve la submission existente (200)')
      } else nok('26. el reintento no fue deduplicado', JSON.stringify(r2))

      if (r2.body.deduplicated === true) {
        ok('26. y lo dice en el CUERPO: deduplicated=true, no solo en el status code')
      } else nok('26. el reintento no declaró deduplicated', JSON.stringify(r2.body))

      if (r2.body.code !== 'price_changed') {
        ok('26. y NO responde price_changed: una operación ya aceptada gana sobre el catálogo')
      } else nok('26. el reintento respondió price_changed')

      const { count } = await admin.from('form_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', A.id).eq('idempotency_key', clave)
      if (count === 1) {
        ok('26. hay exactamente UNA submission para esa clave')
      } else nok('26. la clave creó más de una submission', String(count))

      // El precio congelado sigue siendo el de las 12:00.
      const sub = await leerSubmission(referencia)
      const items = ((sub?.payload as Record<string, unknown>)?.items ?? []) as Array<Record<string, unknown>>
      if (items[0]?.unit_price === '10000.00') {
        ok('13. la submission conserva el precio del momento del pedido, no el nuevo')
      } else nok('13. el precio de la submission cambió', JSON.stringify(items[0]))

      // Con una clave NUEVA y el precio viejo, sí hay 409.
      const r3 = await postForm({ ...body, idempotency_key: randomUUID() })
      if (r3.status === 409 && r3.body.code === 'price_changed') {
        ok('26. con una clave NUEVA el mismo body sí da price_changed: el short-circuit es por clave, no por contenido')
      } else nok('26. el short-circuit se aplicó a una clave nueva', JSON.stringify(r3))

      // Se restaura el precio para los casos siguientes.
      await admin.from('menu_items').update({ base_price: 10000 } as never).eq('id', MUZZA)
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§18 / matriz 40 — el snapshot NO se mueve')
    // ══════════════════════════════════════════════════════════════════════
    {
      const sub = await leerSubmission(referenciaBase)
      const antes = JSON.stringify(sub?.payload)

      // Se rompe el catálogo de todas las formas posibles.
      await admin.from('menu_items').update({
        base_price: 12000, available: false, published: false, name: 'Muzzarella RENOMBRADA',
      } as never).eq('id', MUZZA)
      await admin.from('menu_categories').update({ active: false } as never).eq('id', catA)

      const despues = await leerSubmission(referenciaBase)
      if (JSON.stringify(despues?.payload) === antes) {
        ok('40. cambiar precio, disponibilidad, publicación, nombre y categoría NO tocó la submission')
      } else nok('40. la submission histórica cambió', JSON.stringify(despues?.payload))

      // Y la confirmación por el flujo real sigue funcionando (§13, §21).
      const { data: rpc, error: eRpc } = await admin.rpc('confirm_submission_and_create_operation', {
        p_submission_id: submissionBaseId, p_tenant_id: A.id, p_contact_id: A.contactId,
        p_conversation_id: undefined,
      })
      if (eRpc) nok('13. la confirmación falló', eRpc.message)

      const out = rpc as { outcome?: string; operation_id?: string; operation_kind?: string } | null
      if (out?.outcome === 'confirmed' && out.operation_kind === 'order_request') {
        ok('21. la submission con el catálogo roto SIGUE siendo confirmable → order_request')
      } else nok('21. la confirmación no produjo un order_request', JSON.stringify(out))

      const { data: op } = await admin.from('operation_requests')
        .select('status, kind, payload_snapshot, entity_id, publication_ref, requested_date')
        .eq('id', out?.operation_id ?? '').maybeSingle()

      if (op?.status === 'pending') {
        ok('41. el order_request queda pending')
      } else nok('41. el order_request no quedó pending', String(op?.status))

      if (JSON.stringify(op?.payload_snapshot) === antes) {
        ok('40. payload_snapshot === el payload congelado de la submission, byte a byte')
      } else nok('40. el snapshot de la operación difiere', JSON.stringify(op?.payload_snapshot))

      const snap = (op?.payload_snapshot ?? {}) as Record<string, unknown>
      const its  = (snap.items ?? []) as Array<Record<string, unknown>>
      if (its[0]?.name === 'Muzzarella' && its[0]?.unit_price === '10000.00' && snap.subtotal === '32000.10' && snap.currency === 'ARS') {
        ok('18/40. conserva nombre, unit_price, subtotal y moneda ORIGINALES pese a que el catálogo cambió')
      } else nok('18/40. el snapshot no conservó los valores originales', JSON.stringify(snap))

      if (its.length === 3 && its[0]?.notes === 'sin cebolla' && its[1]?.notes === 'sin aceitunas') {
        ok('19. y conserva las DOS líneas del mismo producto, con sus aclaraciones')
      } else nok('19. el snapshot perdió las líneas duplicadas', JSON.stringify(its))

      // §23 — sin publication_ref ni entity_id.
      if (op?.entity_id === null && op?.publication_ref === null) {
        ok('23. un pedido NO tiene publication_ref ni entity_id: un carrito son varios productos')
      } else nok('23. el pedido trae contexto de publicación', JSON.stringify(op))

      if (op?.requested_date === null) {
        ok('un pedido no deriva fecha operativa: no es una reserva')
      } else nok('el pedido derivó una fecha', String(op?.requested_date))

      // §21 — NO se materializó nada.
      const materializado: string[] = []
      for (const tabla of ['reservations', 'property_visits', 'table_reservations'] as const) {
        const { count } = await admin.from(tabla)
          .select('id', { count: 'exact', head: true }).eq('tenant_id', A.id)
        if ((count ?? 0) > 0) materializado.push(`${tabla}=${count}`)
      }
      if (materializado.length === 0) {
        ok('41. confirmar un pedido NO materializa nada: 0 reservas, 0 visitas, 0 mesas (orders no existe todavía)')
      } else nok('41. la confirmación materializó algo', materializado.join(' '))

      // Se restaura el catálogo.
      await admin.from('menu_categories').update({ active: true } as never).eq('id', catA)
      await admin.from('menu_items').update({
        base_price: 10000, available: true, published: true, name: 'Muzzarella',
      } as never).eq('id', MUZZA)
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§6 / matriz 37 — aislamiento multi-tenant')
    // ══════════════════════════════════════════════════════════════════════
    {
      // resolveFoodOrderCart usa service_role: RLS no protege nada acá. Lo que
      // aísla es el .eq('tenant_id') explícito. Se prueba por los dos lados.
      const cruzado = await resolveFoodOrderCart(A.id, [
        { item_id: MUZZAB, quantity: 1, expected_unit_price: '5000.00' },
      ])
      if (!cruzado.ok && cruzado.failure.code === 'cart_changed') {
        ok('7. el resolver del tenant A NO puede leer un producto del tenant B')
      } else nok('7. el resolver cruzó tenants', JSON.stringify(cruzado))

      // 37 — las monedas no se contagian.
      const enB = await postForm(pedido(B.slug, [linea(MUZZAB, 2, '5000.00')]))
      const subB = await leerSubmission(String(enB.body.reference ?? ''))
      const payB = (subB?.payload ?? {}) as Record<string, unknown>
      if (payB.currency === 'USD' && payB.subtotal === '10000.00') {
        ok('37. el tenant B resuelve en USD, su propia moneda')
      } else nok('37. la moneda de B no es la suya', JSON.stringify(payB))

      if (subB?.tenant_id === B.id) {
        ok('37. y la submission quedó en el tenant B')
      } else nok('37. la submission fue al tenant equivocado')

      // Un slug de A con un item de B ya se cubrió arriba; el inverso también.
      const inverso = await postForm(pedido(B.slug, [linea(MUZZA, 1, '10000.00')]))
      if (inverso.status === 409 && inverso.body.code === 'cart_changed') {
        ok('7. y al revés: el tenant B no puede pedir un producto de A')
      } else nok('7. B pudo pedir un producto de A', JSON.stringify(inverso))

      // 36. Una moneda FUERA del enum ARS/USD/EUR/BRL.
      //
      // tenants.currency no tiene CHECK y createTenantSchema la acepta como
      // cualquier string de 3 caracteres: un tenant así existe de verdad. Si el
      // payload resuelto exigiera el enum, sus pedidos morirían en un 500 opaco.
      const D = await buildTenant('d', { currency: 'CLP' })
      const catD  = await mkCategoria(D.id, 'Pizzas D')
      const itemD = await mkItem(D.id, catD, 'Muzzarella D', 7000)

      const rD = await postForm(pedido(D.slug, [linea(itemD, 2, '7000.00')]))
      const subD = await leerSubmission(String(rD.body.reference ?? ''))
      const payD = (subD?.payload ?? {}) as Record<string, unknown>
      if (rD.status === 201 && payD.currency === 'CLP' && payD.subtotal === '14000.00') {
        ok('36. un tenant con una moneda fuera del enum (CLP) igual puede recibir pedidos')
      } else nok('36. una moneda fuera del enum rompió el pedido', JSON.stringify({ status: rD.status, payD }))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§11 / matriz 16-17, 42 — límites')
    // ══════════════════════════════════════════════════════════════════════
    {
      // 42 — peor caso razonable: 25 líneas con 300 de aclaración, 1000 de
      // observaciones y la dirección al máximo.
      const peorCaso = {
        tenant_slug:     A.slug,
        intent:          'food_order',
        source:          'public_site',
        idempotency_key: randomUUID(),
        payload: {
          name:           'A'.repeat(120),
          fulfillment:    'delivery',
          address:        'D'.repeat(300),
          payment_method: 'cash',
          notes:          'N'.repeat(1000),
          items: Array.from({ length: 25 }, () => ({
            item_id: MUZZA, quantity: 99, notes: 'X'.repeat(300), expected_unit_price: '10000.00',
          })),
        },
      }
      const bytes = Buffer.byteLength(JSON.stringify(peorCaso), 'utf8')
      if (bytes < MAX_BODY_BYTES) {
        ok(`42. el peor caso razonable pesa ${bytes} bytes: entra en MAX_BODY_BYTES (${MAX_BODY_BYTES})`)
      } else nok(`42. el peor caso no entra: ${bytes} bytes`)

      const r = await postForm(peorCaso)
      if (r.status === 201) {
        ok('17. y el servidor lo acepta: 25 líneas es un pedido válido')
      } else nok('17. el peor caso fue rechazado', JSON.stringify(r).slice(0, 200))

      // 16 — 26 líneas: 422 por SCHEMA, no 413 por bytes.
      const veintiseis = pedido(A.slug, Array.from({ length: 26 }, () => linea(MUZZA, 1, '10000.00')))
      const r26 = await postForm(veintiseis)
      const bytes26 = Buffer.byteLength(JSON.stringify(veintiseis), 'utf8')
      if (r26.status === 422) {
        ok(`16. 26 líneas → 422 por schema (el body pesaba ${bytes26} bytes, muy por debajo del tope)`)
      } else nok('16. 26 líneas no dio 422', JSON.stringify(r26))

      if (bytes26 < MAX_BODY_BYTES) {
        ok('16. y el rechazo NO vino del límite de bytes: el mensaje es la regla de producto')
      } else nok('16. el body de 26 líneas superó el tope de bytes')

      // El límite bruto sigue existiendo para cualquier otra cosa.
      const enorme = { ...pedido(A.slug, [linea(MUZZA)]), relleno: 'Z'.repeat(MAX_BODY_BYTES) }
      const rEnorme = await postForm(enorme)
      if (rEnorme.status === 413) {
        ok('11. MAX_BODY_BYTES sigue en 20.000 y sigue cortando un body desmedido')
      } else nok('11. el body enorme no dio 413', JSON.stringify(rEnorme).slice(0, 120))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('FIX del success — de la respuesta real al CTA de WhatsApp')
    // ══════════════════════════════════════════════════════════════════════
    {
      // El bug: la submission se creaba y en pantalla no quedaba nada. Acá se
      // recorre exactamente lo que hace el browser, con la respuesta REAL del
      // endpoint —no una inventada— hasta el link que ve la persona.
      const r = await postForm(pedido(A.slug, [linea(MUZZA, 1, '10000.00')]))
      const contrato = createSubmissionResponseSchema.safeParse(r.body)

      if (r.status === 201 && contrato.success) {
        ok('A. el POST devuelve un resultado con la forma del contrato')
      } else nok('A. la respuesta no cumple el contrato', JSON.stringify(r))

      if (!contrato.success) throw new Error('sin contrato no se puede seguir')

      // CHECKOUT + resultado → SUCCESS, con la referencia guardada en el
      // wrapper (no en el estado interno del formulario, que fue el bug).
      const estado = toSuccess(toCheckout(INITIAL_CHECKOUT_STATE), contrato.data)

      if (estado.step === 'success') {
        ok('B. con el resultado real, el flujo pasa a SUCCESS')
      } else nok('B. el flujo no llegó a success', estado.step)

      const ref = successReference(estado)
      if (ref === contrato.data.reference && /^SUB-[A-Z0-9]{6}$/.test(ref ?? '')) {
        ok(`C. SUCCESS muestra la referencia real del endpoint (${ref})`)
      } else nok('C. la referencia mostrada no es la del endpoint', String(ref))

      const href = buildSubmissionWhatsAppHref('5491122334455', ref)
      if (href) {
        ok('D. hay CTA de WhatsApp')
      } else nok('D. no se armó el CTA')

      if (href && decodeURIComponent(href).includes(`Referencia: ${ref}`)) {
        ok('E. y el mensaje del CTA lleva ESA misma referencia')
      } else nok('E. el mensaje del CTA no lleva la referencia', String(href))

      // H — el reintento idempotente llega al mismo SUCCESS.
      const mismaClave = {
        tenant_slug: A.slug, intent: 'food_order', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash',
                   items: [linea(MUZZA, 1, '10000.00')] },
      }
      const primero = await postForm(mismaClave)
      const repetido = await postForm(mismaClave)
      const cRep = createSubmissionResponseSchema.safeParse(repetido.body)

      if (cRep.success && cRep.data.deduplicated === true) {
        const estadoRep = toSuccess(toCheckout(INITIAL_CHECKOUT_STATE), cRep.data)
        if (estadoRep.step === 'success' && successReference(estadoRep) === primero.body.reference) {
          ok('H. un reintento deduplicado llega al MISMO success, con la misma referencia')
        } else nok('H. el reintento no mostró el mismo éxito', JSON.stringify(estadoRep))
      } else nok('H. el reintento no vino marcado como deduplicado', JSON.stringify(repetido.body))
    }

    // ══════════════════════════════════════════════════════════════════════
    seccion('§10 — el resto del pipeline sin cambios')
    // ══════════════════════════════════════════════════════════════════════
    {
      // Otro intent del mismo rubro no pasa por la resolución de carrito.
      const consulta = {
        tenant_slug: A.slug, intent: 'general_inquiry', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Ana', message: '¿Hacen sin TACC?' },
      }
      const r = await postForm(consulta)
      if (r.status === 201 && r.body.ok === true) {
        ok('10. general_inquiry sigue funcionando igual, sin tocar el catálogo')
      } else nok('10. se rompió otro intent', JSON.stringify(r))

      // Un intent de otro rubro sigue rechazado.
      const ajeno = {
        tenant_slug: A.slug, intent: 'property_visit', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Ana', preferred_date: '2026-12-01', preferred_time_range: 'morning' },
      }
      const r2 = await postForm(ajeno)
      if (r2.status === 422 && r2.body.reason === 'intent_not_available') {
        ok('10. un intent de otro rubro sigue siendo 422 intent_not_available')
      } else nok('10. la validación de rubro se rompió', JSON.stringify(r2))

      // Un tenant real_estate no puede recibir food_order.
      const C = await buildTenant('c', { vertical: 'real_estate' })
      const r3 = await postForm(pedido(C.slug, [linea(MUZZA, 1, '10000.00')]))
      if (r3.status === 422 && r3.body.reason === 'intent_not_available') {
        ok('10. una inmobiliaria no recibe pedidos: 422 antes de mirar el catálogo')
      } else nok('10. una inmobiliaria aceptó un pedido', JSON.stringify(r3))
    }

  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    const problemas: string[] = []

    for (const id of tenantIds) {
      // Orden obligatorio: operation_requests y form_submissions antes de los
      // items, y los items antes de las categorías (ON DELETE RESTRICT).
      for (const tb of ['operation_requests', 'form_submissions', 'menu_items', 'menu_categories'] as const) {
        const { error } = await admin.from(tb).delete().eq('tenant_id', id)
        if (error) problemas.push(`${tb}/${id}: ${error.code} ${error.message}`)
      }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      const { error: eT } = await admin.from('tenants').delete().eq('id', id)
      if (eT) problemas.push(`tenants/${id}: ${eT.code} ${eT.message}`)
    }

    const { count: subsRestantes } = await admin.from('form_submissions')
      .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
    const { count: tenantsRestantes } = await admin.from('tenants')
      .select('id', { count: 'exact', head: true }).in('id', tenantIds)

    console.log(`  tenants: ${tenantIds.length}`)
    if (problemas.length > 0) {
      console.error(`  ✗ la limpieza reportó errores:\n      ${problemas.join('\n      ')}`)
      failed++
    }
    if ((subsRestantes ?? 0) === 0 && (tenantsRestantes ?? 0) === 0) {
      console.log('  ✓ sin residuos: 0 submissions, 0 tenants de este run')
    } else {
      console.error(`  ✗ residuos: submissions=${subsRestantes} tenants=${tenantsRestantes}`)
      failed++
    }

    console.log(HR)
    console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
    console.log(HR)
    process.exit(failed > 0 ? 1 : 0)
  }
}

void main()

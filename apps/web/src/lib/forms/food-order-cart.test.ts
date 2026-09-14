import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { foodOrderResolvedPayloadSchema, type FoodOrderInput } from '@orderflow/validators'
import { buildResolvedFoodOrderPayload, type ResolvedCart } from './food-order-cart'

// ════════════════════════════════════════════════════════════════════════════
// Fase 3E-C3B1 — lo que se puede probar del resolver SIN base.
//
// El comportamiento contra la DB (filtros de catálogo, precios, cross-tenant)
// vive en validate:food-orders, que corre contra el proyecto real. Acá va:
//
//   1. el armado del payload, que es puro;
//   2. §6 — los filtros de tenant, verificados ESTRUCTURALMENTE sobre el fuente.
//
// El punto 2 no es decorativo. resolveFoodOrderCart usa createAdminClient, y
// service_role SALTEA RLS: si alguien borra un .eq('tenant_id', tenantId), la
// base no lo va a frenar y un test de comportamiento con un solo tenant no lo
// notaría. Por eso el filtro se fija leyendo el código.
// ════════════════════════════════════════════════════════════════════════════

const FUENTE = fs.readFileSync(
  path.join(import.meta.dirname, 'food-order-cart.ts'),
  'utf8',
)

/** El fuente sin comentarios: un `.eq()` mencionado en una explicación no cuenta. */
function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

describe('§6 — los filtros de tenant están donde tienen que estar', () => {
  const codigo = soloCodigo(FUENTE)

  it('las DOS consultas filtran por tenant_id', () => {
    const filtros = codigo.match(/\.eq\('tenant_id', tenantId\)/g) ?? []
    expect(filtros.length).toBe(2)
  })

  it('la consulta de categorías exige active = true', () => {
    const bloque = codigo.slice(codigo.indexOf("from('menu_categories')"), codigo.indexOf("from('menu_items')"))
    expect(bloque).toContain(".eq('tenant_id', tenantId)")
    expect(bloque).toContain(".eq('active', true)")
  })

  it('la consulta de productos aplica los CUATRO filtros canónicos', () => {
    const desde = codigo.indexOf("from('menu_items')")
    const bloque = codigo.slice(desde, desde + 700)
    expect(bloque).toContain(".eq('tenant_id', tenantId)")
    expect(bloque).toContain(".eq('published', true)")
    expect(bloque).toContain(".eq('available', true)")
    expect(bloque).toContain(".is('deleted_at', null)")
    // Y la categoría: solo las activas del tenant, resueltas antes.
    expect(bloque).toContain(".in('category_id', catIds)")
    expect(bloque).toContain(".in('id', idsUnicos)")
  })

  it('lee ids ÚNICOS pero compara contra ellos, no contra la cantidad de líneas', () => {
    expect(codigo).toContain('new Set(lines.map((l) => l.item_id))')
    expect(codigo).toContain('idsUnicos.filter((id) => !catalogo.has(id))')
    // Si alguien comparara filas contra líneas, tres líneas del mismo producto
    // darían "faltan dos productos".
    expect(codigo).not.toContain('rows.length !== lines.length')
    expect(codigo).not.toContain('lines.length !== rows.length')
  })

  it('la moneda se LEE adentro: no hay forma de pasarla por parámetro', () => {
    expect(codigo).toContain("from('tenants')")
    expect(codigo).toContain(".select('currency')")
    expect(codigo).toContain("currency: tenant.currency")
    // La firma no recibe currency.
    expect(codigo).toContain('export async function resolveFoodOrderCart(\n  tenantId: string,\n  lines:    FoodOrderInputLine[],\n)')
  })

  it('no usa float para la plata', () => {
    expect(codigo).not.toContain('parseFloat')
    expect(codigo).not.toContain('Number(')
    // Toda la aritmética pasa por los helpers con guarda de overflow.
    expect(codigo).toContain('multiplyMoneyCents')
    expect(codigo).toContain('addMoneyCents')
  })

  it('no consolida ni reordena líneas', () => {
    expect(codigo).not.toContain('.sort(')
    // El array resuelto se arma recorriendo `lines` en su orden original.
    expect(codigo).toContain('for (const linea of lines) {')
  })
})

// ── El armado del payload ──────────────────────────────────────────────────

const CART: ResolvedCart = {
  items: [
    { item_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Muzzarella', quantity: 2, notes: 'sin cebolla', unit_price: '10000.00', line_total: '20000.00' },
    { item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Agua',       quantity: 1, unit_price: '2000.10', line_total: '2000.10' },
  ],
  currency: 'ARS',
  subtotal: '22000.10',
}

const INPUT = {
  name: 'Ana',
  fulfillment: 'takeaway',
  payment_method: 'cash',
  items: [
    { item_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 2, notes: 'sin cebolla', expected_unit_price: '10000.00' },
    { item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', quantity: 1, expected_unit_price: '2000.10' },
  ],
} as unknown as FoodOrderInput

describe('buildResolvedFoodOrderPayload', () => {
  it('guarda los items RESUELTOS, no los del browser', () => {
    const p = buildResolvedFoodOrderPayload(INPUT, CART)
    expect(p.items).toBe(CART.items)
    expect(JSON.stringify(p)).not.toContain('expected_unit_price')
  })

  it('la moneda y el subtotal vienen del carrito resuelto', () => {
    const p = buildResolvedFoodOrderPayload(INPUT, CART)
    expect(p.currency).toBe('ARS')
    expect(p.subtotal).toBe('22000.10')
  })

  it('copia los campos del cliente uno por uno', () => {
    const p = buildResolvedFoodOrderPayload(INPUT, CART)
    expect(p.name).toBe('Ana')
    expect(p.fulfillment).toBe('takeaway')
    expect(p.payment_method).toBe('cash')
  })

  it('omite los opcionales vacíos en vez de guardarlos como undefined', () => {
    const p = buildResolvedFoodOrderPayload(INPUT, CART)
    expect(p).not.toHaveProperty('address')
    expect(p).not.toHaveProperty('notes')
  })

  it('incluye address y notes cuando existen', () => {
    const conExtras = { ...INPUT, fulfillment: 'delivery', address: 'Calle 1', notes: 'Timbre' } as unknown as FoodOrderInput
    const p = buildResolvedFoodOrderPayload(conExtras, CART)
    expect(p.address).toBe('Calle 1')
    expect(p.notes).toBe('Timbre')
  })

  it('UNA clave de entrada nueva NO se cuela sola al payload guardado', () => {
    // El spread sería lo peligroso: arrastraría cualquier campo que el schema de
    // entrada llegue a aceptar. Acá se enumeran, así que agregar un campo al
    // formulario obliga a decidir si va a la evidencia.
    const conIntruso = { ...INPUT, campo_nuevo: 'valor' } as unknown as FoodOrderInput
    const p = buildResolvedFoodOrderPayload(conIntruso, CART)
    expect(p).not.toHaveProperty('campo_nuevo')
  })

  it('lo que arma PASA el schema resuelto, que es la última puerta', () => {
    const p = buildResolvedFoodOrderPayload(INPUT, CART)
    expect(foodOrderResolvedPayloadSchema.safeParse(p).success).toBe(true)
  })
})

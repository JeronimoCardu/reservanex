import { describe, expect, it } from 'vitest'
import {
  MAX_CART_LINES,
  foodOrderInputSchema,
  foodOrderResolvedPayloadSchema,
  validateSubmissionPayload,
} from './index'

// ════════════════════════════════════════════════════════════════════════════
// Fase 3E-C3B1 — los DOS contratos del pedido.
//
// Lo que estos tests defienden, en una línea: el browser describe QUÉ quiere
// pedir, nunca CUÁNTO cuesta. Todos los campos de plata del payload guardado
// los escribe el servidor.
// ════════════════════════════════════════════════════════════════════════════

const ITEM_A = '11111111-1111-4111-8111-111111111111'
const ITEM_B = '22222222-2222-4222-8222-222222222222'

const linea = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM_A,
  quantity: 1,
  expected_unit_price: '10000.00',
  ...over,
})

const entrada = (over: Record<string, unknown> = {}) => ({
  name: 'Ana',
  fulfillment: 'takeaway',
  payment_method: 'cash',
  items: [linea()],
  ...over,
})

const resuelto = (over: Record<string, unknown> = {}) => ({
  name: 'Ana',
  fulfillment: 'takeaway',
  payment_method: 'cash',
  items: [{
    item_id: ITEM_A,
    name: 'Muzzarella',
    quantity: 1,
    unit_price: '10000.00',
    line_total: '10000.00',
  }],
  currency: 'ARS',
  subtotal: '10000.00',
  ...over,
})

// ── 1-5. El browser no puede fijar plata ───────────────────────────────────

describe('el browser no puede fijar plata (matriz 1-5)', () => {
  const prohibidos: Array<[string, unknown]> = [
    ['unit_price', '1.00'],
    ['line_total', '1.00'],
    ['subtotal', '1.00'],
    ['currency', 'USD'],
    ['name_snapshot', 'Gratis'],
    ['tenant_id', '33333333-3333-4333-8333-333333333333'],
  ]

  it.each(prohibidos)('rechaza %s en el nivel del pedido', (campo, valor) => {
    const r = foodOrderInputSchema.safeParse(entrada({ [campo]: valor }))
    expect(r.success).toBe(false)
  })

  it.each([
    ['unit_price', '1.00'],
    ['line_total', '1.00'],
    ['name', 'Muzzarella'],
    ['currency', 'USD'],
  ])('rechaza %s dentro de una línea', (campo, valor) => {
    const r = foodOrderInputSchema.safeParse(entrada({ items: [linea({ [campo]: valor })] }))
    expect(r.success).toBe(false)
  })

  it('la clave de más se REPORTA, no se descarta en silencio', () => {
    // Zod por defecto haría strip: el pedido entraría igual y el browser nunca
    // sabría que su unit_price fue ignorado. .strict() convierte eso en 422.
    const r = validateSubmissionPayload('food_order', entrada({ subtotal: '1.00' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).length).toBeGreaterThan(0)
  })
})

// ── 6. expected_unit_price: permitido a la entrada, prohibido al guardar ────

describe('expected_unit_price (matriz 6, 35)', () => {
  it('es obligatorio en la entrada', () => {
    const sin = { item_id: ITEM_A, quantity: 1 }
    expect(foodOrderInputSchema.safeParse(entrada({ items: [sin] })).success).toBe(false)
  })

  it('exige formato canónico de dos decimales', () => {
    for (const malo of ['10000', '10000.0', '10000.000', '1e4', '-1.00', 10000]) {
      expect(
        foodOrderInputSchema.safeParse(entrada({ items: [linea({ expected_unit_price: malo })] })).success,
        String(malo),
      ).toBe(false)
    }
    expect(foodOrderInputSchema.safeParse(entrada({ items: [linea({ expected_unit_price: '0.00' })] })).success).toBe(true)
  })

  it('NO se acepta en el payload resuelto: no es evidencia', () => {
    const conExpected = resuelto({
      items: [{
        item_id: ITEM_A, name: 'Muzzarella', quantity: 1,
        unit_price: '10000.00', line_total: '10000.00',
        expected_unit_price: '10000.00',
      }],
    })
    expect(foodOrderResolvedPayloadSchema.safeParse(conExpected).success).toBe(false)
  })
})

// ── 12-15. Cantidad ────────────────────────────────────────────────────────

describe('quantity (matriz 12-15)', () => {
  it('acepta 1 y 99', () => {
    expect(foodOrderInputSchema.safeParse(entrada({ items: [linea({ quantity: 1 })] })).success).toBe(true)
    expect(foodOrderInputSchema.safeParse(entrada({ items: [linea({ quantity: 99 })] })).success).toBe(true)
  })

  it('rechaza 0, 100, decimales y negativos', () => {
    for (const q of [0, 100, 1.5, -1]) {
      expect(foodOrderInputSchema.safeParse(entrada({ items: [linea({ quantity: q })] })).success, String(q)).toBe(false)
    }
  })

  it("rechaza '2' como string: el carrito lo arma nuestro cliente en JSON", () => {
    // Sin z.coerce a propósito. Un string acá es señal de un body armado a mano.
    expect(foodOrderInputSchema.safeParse(entrada({ items: [linea({ quantity: '2' })] })).success).toBe(false)
  })
})

// ── 16-17. Tope de líneas ──────────────────────────────────────────────────

describe('tope de líneas (matriz 16-17)', () => {
  const nLineas = (n: number) => Array.from({ length: n }, () => linea())

  it(`acepta ${MAX_CART_LINES}`, () => {
    expect(MAX_CART_LINES).toBe(25)
    expect(foodOrderInputSchema.safeParse(entrada({ items: nLineas(25) })).success).toBe(true)
  })

  it('rechaza 26 por SCHEMA, no por tamaño de body', () => {
    const r = foodOrderInputSchema.safeParse(entrada({ items: nLineas(26) }))
    expect(r.success).toBe(false)
  })

  it('rechaza el carrito vacío: un pedido sin productos no es un pedido', () => {
    expect(foodOrderInputSchema.safeParse(entrada({ items: [] })).success).toBe(false)
    const sinItems = { name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash' }
    expect(foodOrderInputSchema.safeParse(sinItems).success).toBe(false)
  })
})

// ── 18. Mismo item_id en varias líneas ─────────────────────────────────────

describe('líneas duplicadas del mismo producto (matriz 18)', () => {
  it('acepta el mismo item_id dos veces con notas distintas', () => {
    const r = foodOrderInputSchema.safeParse(entrada({
      items: [
        linea({ notes: 'sin cebolla' }),
        linea({ notes: 'sin tomate' }),
      ],
    }))
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.items).toHaveLength(2)
  })

  it('acepta el mismo item_id dos veces SIN notas: no hay unique ni consolidación', () => {
    const r = foodOrderInputSchema.safeParse(entrada({ items: [linea(), linea()] }))
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.items).toHaveLength(2)
  })

  it('conserva el ORDEN de las líneas', () => {
    const r = foodOrderInputSchema.safeParse(entrada({
      items: [linea({ notes: 'A' }), linea({ item_id: ITEM_B, notes: 'B' }), linea({ notes: 'C' })],
    }))
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.items.map((l) => l.notes)).toEqual(['A', 'B', 'C'])
  })
})

// ── 31-34. Textos y campo condicional ──────────────────────────────────────

describe('límites de texto y fulfillment (matriz 31-34)', () => {
  it('notes de línea: 300 sí, 301 no', () => {
    expect(foodOrderInputSchema.safeParse(entrada({ items: [linea({ notes: 'x'.repeat(300) })] })).success).toBe(true)
    expect(foodOrderInputSchema.safeParse(entrada({ items: [linea({ notes: 'x'.repeat(301) })] })).success).toBe(false)
  })

  it('notes del pedido: 1000 sí, 1001 no', () => {
    expect(foodOrderInputSchema.safeParse(entrada({ notes: 'x'.repeat(1000) })).success).toBe(true)
    expect(foodOrderInputSchema.safeParse(entrada({ notes: 'x'.repeat(1001) })).success).toBe(false)
  })

  it('delivery exige dirección', () => {
    expect(foodOrderInputSchema.safeParse(entrada({ fulfillment: 'delivery' })).success).toBe(false)
    expect(foodOrderInputSchema.safeParse(entrada({ fulfillment: 'delivery', address: 'Calle 1' })).success).toBe(true)
  })

  it('takeaway prohíbe dirección', () => {
    expect(foodOrderInputSchema.safeParse(entrada({ address: 'Calle 1' })).success).toBe(false)
  })

  it('la misma regla vale para el payload resuelto', () => {
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ fulfillment: 'delivery' })).success).toBe(false)
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ address: 'Calle 1' })).success).toBe(false)
  })
})

// ── El payload resuelto ────────────────────────────────────────────────────

describe('payload resuelto', () => {
  it('acepta la forma completa', () => {
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto()).success).toBe(true)
  })

  it('exige currency y subtotal: sin ellos no es evidencia de un pedido', () => {
    const sinCurrency = resuelto()
    delete (sinCurrency as Record<string, unknown>).currency
    expect(foodOrderResolvedPayloadSchema.safeParse(sinCurrency).success).toBe(false)

    const sinSubtotal = resuelto()
    delete (sinSubtotal as Record<string, unknown>).subtotal
    expect(foodOrderResolvedPayloadSchema.safeParse(sinSubtotal).success).toBe(false)
  })

  it('currency valida la FORMA, no la lista: tres caracteres', () => {
    // Deliberadamente NO es el enum ARS/USD/EUR/BRL. tenants.currency no tiene
    // CHECK y el alta de tenant la acepta como cualquier string de 3, así que
    // un tenant con otra moneda existe y tiene que poder recibir pedidos. Que
    // la moneda venga del tenant y no del browser lo garantiza el resolver, que
    // la lee de la tabla — no este schema.
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ currency: 'ARS' })).success).toBe(true)
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ currency: 'CLP' })).success).toBe(true)
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ currency: 'PESOS' })).success).toBe(false)
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ currency: '' })).success).toBe(false)
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ currency: 3 })).success).toBe(false)
  })

  it('exige name, unit_price y line_total en cada línea', () => {
    for (const falta of ['name', 'unit_price', 'line_total']) {
      const linea = { ...resuelto().items[0] } as Record<string, unknown>
      delete linea[falta]
      expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ items: [linea] })).success, falta).toBe(false)
    }
  })

  it('también es strict: una clave de más no entra a la evidencia', () => {
    expect(foodOrderResolvedPayloadSchema.safeParse(resuelto({ delivery_fee: '500.00' })).success).toBe(false)
  })
})

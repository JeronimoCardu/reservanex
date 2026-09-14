import { describe, expect, it } from 'vitest'
import { foodOrderInputSchema, MAX_CART_LINES } from '@orderflow/validators'
import {
  addToCart,
  applyPriceChanges,
  cartCount,
  cartSubtotal,
  candidateUnitPrice,
  duplicateLine,
  linesForItems,
  removeLine,
  setLineNotes,
  setQuantity,
  toApiItems,
  type CartCandidate,
  type CartLine,
} from './cart'

const MUZZA: CartCandidate  = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Muzzarella',  base_price: 10000,  available: true }
const NAPO: CartCandidate   = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Napolitana',  base_price: 12500.5, available: true }
const AGUA: CartCandidate   = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Agua 500ml',  base_price: 2000.1, available: true }
const FUGA: CartCandidate   = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Fugazzeta',   base_price: 13000,  available: false }
const GRATIS: CartCandidate = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Pan de cortesía', base_price: 0, available: true }

let n = 0
const id = () => `L${++n}`

function agregar(lines: CartLine[], item: CartCandidate): CartLine[] {
  const r = addToCart(lines, item, id())
  if (!r.ok) throw new Error(`no se pudo agregar: ${r.reason}`)
  return r.lines
}

describe('precio del catálogo → canónico', () => {
  it('convierte el number de supabase-js a string de dos decimales', () => {
    expect(candidateUnitPrice(MUZZA)).toBe('10000.00')
    expect(candidateUnitPrice(NAPO)).toBe('12500.50')
    expect(candidateUnitPrice(AGUA)).toBe('2000.10')
    expect(candidateUnitPrice(GRATIS)).toBe('0.00')
  })
})

describe('agregar desde la carta (§12, §13)', () => {
  it('la primera vez crea una línea', () => {
    const c = agregar([], MUZZA)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ item_id: MUZZA.id, name: 'Muzzarella', unit_price: '10000.00', quantity: 1, notes: '' })
  })

  it('la segunda vez incrementa la única línea SIN nota', () => {
    const c = agregar(agregar([], MUZZA), MUZZA)
    expect(c).toHaveLength(1)
    expect(c[0]!.quantity).toBe(2)
  })

  it('NO toca una línea que tiene nota: crea otra', () => {
    let c = agregar([], MUZZA)
    c = setLineNotes(c, c[0]!.client_line_id, 'sin cebolla')
    c = agregar(c, MUZZA)

    expect(c).toHaveLength(2)
    expect(c[0]!.notes).toBe('sin cebolla')
    expect(c[0]!.quantity).toBe(1)
    expect(c[1]!.notes).toBe('')
  })

  it('con DOS líneas sin nota del mismo producto no adivina: crea otra', () => {
    // Ambigüedad real: no hay una "la" línea que incrementar.
    let c = agregar([], MUZZA)
    const r = duplicateLine(c, c[0]!.client_line_id, id())
    if (!r.ok) throw new Error('dup')
    c = agregar(r.lines, MUZZA)
    expect(c).toHaveLength(3)
  })

  it('un producto no disponible NO se puede agregar (§12)', () => {
    const r = addToCart([], FUGA, id())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unavailable')
  })

  it('un producto gratis SÍ se puede agregar', () => {
    const c = agregar([], GRATIS)
    expect(c[0]!.unit_price).toBe('0.00')
  })

  it('respeta el tope de líneas', () => {
    let c: CartLine[] = []
    // 25 productos distintos: cada uno crea su línea.
    for (let i = 0; i < MAX_CART_LINES; i++) {
      c = agregar(c, { ...MUZZA, id: `${i}`.padStart(8, '0') + '-0000-4000-8000-000000000000' })
    }
    expect(c).toHaveLength(25)
    const r = addToCart(c, { ...MUZZA, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, id())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('cart_full')
  })

  it('no pasa de 99 en una línea: avisa en vez de duplicar en silencio', () => {
    let c = agregar([], MUZZA)
    c = setQuantity(c, c[0]!.client_line_id, 99)
    const r = addToCart(c, MUZZA, id())
    expect(r.ok).toBe(false)
    expect(c).toHaveLength(1)
  })
})

describe('editar líneas', () => {
  it('la cantidad queda acotada a 1..99', () => {
    let c = agregar([], MUZZA)
    const lid = c[0]!.client_line_id
    expect(setQuantity(c, lid, 0)[0]!.quantity).toBe(1)
    expect(setQuantity(c, lid, -5)[0]!.quantity).toBe(1)
    expect(setQuantity(c, lid, 100)[0]!.quantity).toBe(99)
    expect(setQuantity(c, lid, 2.9)[0]!.quantity).toBe(2)
    c = setQuantity(c, lid, 3)
    expect(c[0]!.quantity).toBe(3)
  })

  it('las notas se recortan a 300, que es el máximo del schema', () => {
    const c = agregar([], MUZZA)
    const largo = setLineNotes(c, c[0]!.client_line_id, 'x'.repeat(400))
    expect(largo[0]!.notes).toHaveLength(300)
  })

  it('quitar una línea no toca las demás', () => {
    let c = agregar(agregar([], MUZZA), NAPO)
    c = removeLine(c, c[0]!.client_line_id)
    expect(c).toHaveLength(1)
    expect(c[0]!.item_id).toBe(NAPO.id)
  })

  it('"agregar otra línea" inserta la copia justo debajo, vacía', () => {
    let c = agregar([], MUZZA)
    c = setLineNotes(c, c[0]!.client_line_id, 'sin cebolla')
    c = agregar(c, NAPO)

    const r = duplicateLine(c, c[0]!.client_line_id, id())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines.map((l) => l.item_id)).toEqual([MUZZA.id, MUZZA.id, NAPO.id])
    expect(r.lines[1]!.notes).toBe('')
    expect(r.lines[1]!.quantity).toBe(1)
    expect(r.lines[1]!.client_line_id).not.toBe(r.lines[0]!.client_line_id)
  })
})

describe('subtotal del browser (§16)', () => {
  it('exacto en los casos que en float derivan', () => {
    let c = agregar([], AGUA)               // 2000.10
    c = setQuantity(c, c[0]!.client_line_id, 9)
    expect(cartSubtotal(c)).toBe('18000.90')

    c = agregar(c, MUZZA)                   // + 10000.00
    c = setQuantity(c, c[1]!.client_line_id, 2)
    expect(cartSubtotal(c)).toBe('38000.90')
  })

  it('cuenta unidades, no líneas', () => {
    let c = agregar([], MUZZA)
    c = setQuantity(c, c[0]!.client_line_id, 3)
    c = agregar(c, NAPO)
    expect(cartCount(c)).toBe(4)
    expect(c).toHaveLength(2)
  })

  it('carrito vacío: 0,00', () => {
    expect(cartSubtotal([])).toBe('0.00')
  })
})

describe('body del API (§5, §6 del contrato)', () => {
  it('no manda client_line_id ni ningún campo de plata resuelto', () => {
    let c = agregar([], MUZZA)
    c = setLineNotes(c, c[0]!.client_line_id, 'sin cebolla')
    const items = toApiItems(c)

    expect(items[0]).toEqual({
      item_id: MUZZA.id, quantity: 1, notes: 'sin cebolla', expected_unit_price: '10000.00',
    })
    // Por CLAVES, no por substring: "expected_unit_price" contiene
    // "unit_price" y un not.toContain daria un falso negativo.
    const claves = new Set(items.flatMap((i) => Object.keys(i)))
    expect([...claves].sort()).toEqual(['expected_unit_price', 'item_id', 'notes', 'quantity'])
    for (const prohibida of ['client_line_id', 'name', 'unit_price', 'line_total', 'subtotal', 'currency']) {
      expect(claves.has(prohibida), prohibida).toBe(false)
    }
  })

  it('omite notes cuando está vacía o es solo espacios', () => {
    let c = agregar([], MUZZA)
    expect(toApiItems(c)[0]).not.toHaveProperty('notes')
    c = setLineNotes(c, c[0]!.client_line_id, '   ')
    expect(toApiItems(c)[0]).not.toHaveProperty('notes')
  })

  it('dos líneas del mismo producto viajan separadas y en orden', () => {
    let c = agregar([], MUZZA)
    c = setLineNotes(c, c[0]!.client_line_id, 'sin cebolla')
    const r = duplicateLine(c, c[0]!.client_line_id, id())
    if (!r.ok) throw new Error('dup')
    c = setLineNotes(r.lines, r.lines[1]!.client_line_id, 'sin aceitunas')

    const items = toApiItems(c)
    expect(items).toHaveLength(2)
    expect(items[0]!.item_id).toBe(items[1]!.item_id)
    expect(items.map((i) => i.notes)).toEqual(['sin cebolla', 'sin aceitunas'])
  })

  it('lo que arma el carrito PASA el schema real del servidor', () => {
    // El test que cierra el círculo: si el contrato cambia y el carrito no, esto
    // falla acá en vez de fallar con un visitante mirando.
    let c = agregar([], MUZZA)
    c = setQuantity(c, c[0]!.client_line_id, 3)
    c = agregar(c, NAPO)
    c = setLineNotes(c, c[1]!.client_line_id, 'bien cocida')

    const r = foodOrderInputSchema.safeParse({
      name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash', items: toApiItems(c),
    })
    expect(r.success).toBe(true)
  })
})

describe('409 price_changed (§7)', () => {
  it('actualiza TODAS las líneas del item cambiado', () => {
    let c = agregar([], MUZZA)
    c = setLineNotes(c, c[0]!.client_line_id, 'sin cebolla')
    const r = duplicateLine(c, c[0]!.client_line_id, id())
    if (!r.ok) throw new Error('dup')
    c = agregar(r.lines, NAPO)

    expect(c.filter((l) => l.item_id === MUZZA.id)).toHaveLength(2)

    const actualizado = applyPriceChanges(c, [{ item_id: MUZZA.id, current_unit_price: '12000.00' }])

    for (const l of actualizado.filter((l) => l.item_id === MUZZA.id)) {
      expect(l.unit_price).toBe('12000.00')
    }
    // La napolitana no se tocó.
    expect(actualizado.find((l) => l.item_id === NAPO.id)!.unit_price).toBe('12500.50')
  })

  it('el precio mostrado y el expected del reenvío son el MISMO dato', () => {
    // Por eso no pueden divergir: actualizar uno actualiza el otro.
    let c = agregar([], MUZZA)
    c = applyPriceChanges(c, [{ item_id: MUZZA.id, current_unit_price: '12000.00' }])
    expect(c[0]!.unit_price).toBe('12000.00')
    expect(toApiItems(c)[0]!.expected_unit_price).toBe('12000.00')
  })

  it('recalcula el subtotal mostrado', () => {
    let c = agregar([], MUZZA)
    c = setQuantity(c, c[0]!.client_line_id, 2)
    expect(cartSubtotal(c)).toBe('20000.00')
    c = applyPriceChanges(c, [{ item_id: MUZZA.id, current_unit_price: '12000.00' }])
    expect(cartSubtotal(c)).toBe('24000.00')
  })

  it('no quita ni reordena nada: el usuario revisa y reenvía', () => {
    const antes = agregar(agregar([], MUZZA), NAPO)
    const despues = applyPriceChanges(antes, [{ item_id: MUZZA.id, current_unit_price: '12000.00' }])
    expect(despues.map((l) => l.client_line_id)).toEqual(antes.map((l) => l.client_line_id))
  })
})

describe('409 cart_changed (§8)', () => {
  it('señala las líneas del producto, sin quitarlas', () => {
    let c = agregar([], MUZZA)
    const r = duplicateLine(c, c[0]!.client_line_id, id())
    if (!r.ok) throw new Error('dup')
    c = agregar(r.lines, NAPO)

    const marcadas = linesForItems(c, [MUZZA.id])
    expect(marcadas).toHaveLength(2)
    expect(c).toHaveLength(3)   // nada se quitó en silencio
  })
})

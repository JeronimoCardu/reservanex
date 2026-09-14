import {
  MAX_CART_LINES,
  addMoneyCents,
  centsToMoneyString,
  dbMoneyNumberToCents,
  moneyStringToCents,
  multiplyMoneyCents,
  type FoodOrderInputLine,
} from '@orderflow/validators'

// ═══════════════════════════════════════════════════════════════════════════
// Fase 3E-C3B1 — el carrito del sitio público, sin React.
//
// Todo acá es puro: entra un array de líneas, sale otro. El componente solo
// guarda el resultado en useState. Así las reglas del carrito —cuándo se
// incrementa una línea y cuándo se crea otra, qué pasa cuando cambia un
// precio, cómo se arma el body— se prueban sin renderizar nada.
//
// ── client_line_id ──────────────────────────────────────────────────────────
//
// Identidad LOCAL de la línea, para keys de React y para poder editar la línea
// correcta cuando hay dos del mismo producto. NO se manda al API, NO se
// persiste y NO aparece en ningún snapshot. Lo genera quien llama (el
// componente, con un contador) en vez de este módulo, para que las funciones
// sigan siendo puras y los tests deterministas.
//
// ── LA PLATA DEL BROWSER ES UX ──────────────────────────────────────────────
//
// El subtotal que se muestra acá NO es autoridad: sale de los precios que vinieron
// en la carta pública. El servidor relee el catálogo y arma el suyo. Igual se
// calcula en centavos enteros, porque mostrarle "18000.899999999998" a alguien
// sería igual de malo aunque después el servidor lo corrija.
// ═══════════════════════════════════════════════════════════════════════════

export interface CartLine {
  /** Identidad local. Nunca sale del browser. */
  client_line_id: string
  item_id:        string
  /** Snapshot de lo que el cliente está viendo; el servidor usa el suyo. */
  name:           string
  /** Canónico ("10000.00"), derivado del precio de la carta pública. */
  unit_price:     string
  quantity:       number
  /** Siempre string para que el <textarea> sea controlado; '' es "sin nota". */
  notes:          string
}

/** Lo que la carta pública sabe de un producto. */
export interface CartCandidate {
  id:         string
  name:       string
  base_price: number
  available:  boolean
}

export const MAX_LINE_QUANTITY = 99
export { MAX_CART_LINES }

/** El precio del catálogo público, en formato canónico. null si no se puede representar. */
export function candidateUnitPrice(item: Pick<CartCandidate, 'base_price'>): string | null {
  const cents = dbMoneyNumberToCents(item.base_price)
  return cents === null ? null : centsToMoneyString(cents)
}

export type AddResult =
  | { ok: true;  lines: CartLine[] }
  | { ok: false; reason: 'unavailable' | 'cart_full' | 'bad_price' }

/**
 * Agrega un producto al carrito.
 *
 * §13 — si YA existe exactamente UNA línea de ese producto sin nota, se le sube
 * la cantidad en vez de crear otra: es lo que espera quien toca "Agregar" dos
 * veces seguidas. En cuanto hay notas de por medio la consolidación automática
 * sería adivinar, así que se crea una línea nueva y el usuario decide.
 */
export function addToCart(
  lines:  CartLine[],
  item:   CartCandidate,
  nextId: string,
): AddResult {
  if (!item.available) return { ok: false, reason: 'unavailable' }

  const unit = candidateUnitPrice(item)
  if (unit === null) return { ok: false, reason: 'bad_price' }

  const simples = lines.filter((l) => l.item_id === item.id && l.notes.trim() === '')

  if (simples.length === 1) {
    const objetivo = simples[0]!
    if (objetivo.quantity < MAX_LINE_QUANTITY) {
      return { ok: true, lines: setQuantity(lines, objetivo.client_line_id, objetivo.quantity + 1) }
    }
    // Ya está en el tope: no se crea una línea gemela en silencio, se avisa.
    return { ok: false, reason: 'cart_full' }
  }

  if (lines.length >= MAX_CART_LINES) return { ok: false, reason: 'cart_full' }

  return {
    ok: true,
    lines: [...lines, {
      client_line_id: nextId,
      item_id:        item.id,
      name:           item.name,
      unit_price:     unit,
      quantity:       1,
      notes:          '',
    }],
  }
}

/**
 * "Agregar otra línea" — duplica una línea existente con cantidad 1 y sin nota.
 *
 * Es la salida al problema de §13: pedir dos muzzarellas con aclaraciones
 * distintas sin pelear con la consolidación automática.
 */
export function duplicateLine(lines: CartLine[], clientLineId: string, nextId: string): AddResult {
  if (lines.length >= MAX_CART_LINES) return { ok: false, reason: 'cart_full' }

  const i = lines.findIndex((l) => l.client_line_id === clientLineId)
  if (i === -1) return { ok: true, lines }

  const origen = lines[i]!
  const nueva: CartLine = { ...origen, client_line_id: nextId, quantity: 1, notes: '' }
  // Se inserta JUNTO a la original: las dos líneas del mismo producto quedan
  // una debajo de la otra, que es como se leen.
  return { ok: true, lines: [...lines.slice(0, i + 1), nueva, ...lines.slice(i + 1)] }
}

/** Cantidad acotada a 1..99. Bajar de 1 no borra la línea: eso es "Quitar". */
export function setQuantity(lines: CartLine[], clientLineId: string, quantity: number): CartLine[] {
  const q = Math.min(MAX_LINE_QUANTITY, Math.max(1, Math.trunc(quantity)))
  return lines.map((l) => (l.client_line_id === clientLineId ? { ...l, quantity: q } : l))
}

export function setLineNotes(lines: CartLine[], clientLineId: string, notes: string): CartLine[] {
  return lines.map((l) => (l.client_line_id === clientLineId ? { ...l, notes: notes.slice(0, 300) } : l))
}

export function removeLine(lines: CartLine[], clientLineId: string): CartLine[] {
  return lines.filter((l) => l.client_line_id !== clientLineId)
}

/** El total de una línea, en centavos. null si no se puede representar. */
export function lineTotalCents(line: CartLine): number | null {
  const unit = moneyStringToCents(line.unit_price)
  if (unit === null) return null
  return multiplyMoneyCents(unit, line.quantity)
}

/** El subtotal del carrito, en centavos. null si alguna línea no cierra. */
export function cartSubtotalCents(lines: CartLine[]): number | null {
  let total = 0
  for (const l of lines) {
    const t = lineTotalCents(l)
    if (t === null) return null
    const s = addMoneyCents(total, t)
    if (s === null) return null
    total = s
  }
  return total
}

export function cartSubtotal(lines: CartLine[]): string | null {
  const cents = cartSubtotalCents(lines)
  return cents === null ? null : centsToMoneyString(cents)
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((n, l) => n + l.quantity, 0)
}

/**
 * El array `items` que se manda al API.
 *
 * client_line_id NO viaja. Las líneas van en el MISMO orden y sin consolidar:
 * dos líneas del mismo producto son dos entradas.
 */
export function toApiItems(lines: CartLine[]): FoodOrderInputLine[] {
  return lines.map((l) => ({
    item_id:  l.item_id,
    quantity: l.quantity,
    ...(l.notes.trim() ? { notes: l.notes.trim() } : {}),
    expected_unit_price: l.unit_price,
  }))
}

/**
 * Aplica un 409 price_changed.
 *
 * El servidor manda UNA entrada por item_id cambiado; acá se actualizan TODAS
 * las líneas de ese producto. Si no lo hiciéramos, el reenvío volvería a
 * chocar con el mismo 409 por la línea que quedó con el precio viejo.
 *
 * Actualiza el precio mostrado Y el expected_unit_price del próximo envío —
 * que en este modelo son el mismo dato, justamente para que no puedan divergir.
 * NO reenvía: el usuario tiene que volver a tocar Enviar.
 */
export function applyPriceChanges(
  lines:   CartLine[],
  changes: Array<{ item_id: string; current_unit_price: string }>,
): CartLine[] {
  const nuevos = new Map(changes.map((c) => [c.item_id, c.current_unit_price]))
  return lines.map((l) => {
    const precio = nuevos.get(l.item_id)
    return precio && precio !== l.unit_price ? { ...l, unit_price: precio } : l
  })
}

/** Los client_line_id afectados por un cart_changed, para poder marcarlos. */
export function linesForItems(lines: CartLine[], itemIds: string[]): string[] {
  const ids = new Set(itemIds)
  return lines.filter((l) => ids.has(l.item_id)).map((l) => l.client_line_id)
}

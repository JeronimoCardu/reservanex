import type { CreateSubmissionResponse } from '@orderflow/validators'

// ═══════════════════════════════════════════════════════════════════════════
// Fase 3E-C3B1 (fix) — la máquina de pasos del checkout, sin React.
//
// ── POR QUÉ EXISTE ESTE ARCHIVO ─────────────────────────────────────────────
//
// El bug que corrige: el sheet no tenía paso SUCCESS propio. El "¡Listo!" lo
// dibujaba el estado INTERNO de DynamicForm, y el callback de éxito del carrito
// renovaba la clave de idempotencia que se usaba como `key` de ese mismo
// DynamicForm. Cambiar la `key` lo DESMONTA: React tiró la instancia que acababa
// de pasar a success y montó una nueva en 'idle' con los campos vacíos. El
// pedido se había creado, y en pantalla no quedaba nada.
//
// La lección no es "no usar key": es que el resultado del submit no puede vivir
// en el estado interno de un componente que el wrapper puede remontar. Así que
// ahora vive acá, en el estado del wrapper, y las transiciones son puras y
// testeables.
//
//   CART  →  CHECKOUT  →  SUCCESS
//                      ↘  (409) vuelve a CART, sin perder nada
// ═══════════════════════════════════════════════════════════════════════════

export type CheckoutStep = 'cart' | 'checkout' | 'success'

export interface CheckoutNotice {
  tone: 'price' | 'catalog'
  text: string
}

export interface CheckoutState {
  step:  CheckoutStep
  /**
   * La respuesta REAL del POST. Es lo único que sostiene la pantalla de éxito:
   * no se vuelve a consultar la base ni se deduce la referencia de ningún lado.
   */
  result: CreateSubmissionResponse | null
  notice: CheckoutNotice | null
  /** client_line_id de las líneas a resaltar tras un 409. */
  flagged: string[]
}

export const INITIAL_CHECKOUT_STATE: CheckoutState = {
  step: 'cart', result: null, notice: null, flagged: [],
}

export const PRICE_CHANGED_NOTICE: CheckoutNotice = {
  tone: 'price',
  text: 'Algunos precios cambiaron. Revisá el carrito antes de continuar.',
}

export const CART_CHANGED_NOTICE: CheckoutNotice = {
  tone: 'catalog',
  text: 'Algunos productos ya no están disponibles. Quitalos del pedido para continuar.',
}

/** Del carrito al formulario. Limpia el aviso anterior, no el resultado. */
export function toCheckout(state: CheckoutState): CheckoutState {
  return { ...state, step: 'checkout', notice: null }
}

/** "Volver al pedido" desde el formulario. */
export function toCart(state: CheckoutState): CheckoutState {
  return { ...state, step: 'cart' }
}

/**
 * Submit exitoso (2xx).
 *
 * `deduplicated` NO es un error: un reintento idempotente de un pedido que ya
 * existe llega acá igual, con la MISMA referencia, y muestra el mismo éxito.
 */
export function toSuccess(state: CheckoutState, result: CreateSubmissionResponse): CheckoutState {
  return { ...state, step: 'success', result, notice: null, flagged: [] }
}

export interface StructuredErrorBody {
  code?:    unknown
  changes?: unknown
  items?:   unknown
}

export interface StructuredErrorOutcome {
  code:    'price_changed' | 'cart_changed'
  /** item_id afectados: el wrapper los traduce a líneas del carrito. */
  itemIds: string[]
  /** Precios nuevos por item_id. Vacío en cart_changed. */
  prices:  Array<{ item_id: string; current_unit_price: string }>
  state:   CheckoutState
}

/**
 * Un 409 estructurado.
 *
 * Vuelve a CART y NO toca `result`: si el visitante ya había hecho un pedido
 * antes en la misma sesión del sheet, su referencia sigue existiendo. Lo que no
 * hace, nunca, es pasar a success.
 *
 * Devuelve null si el cuerpo no es uno de los dos 409 conocidos, para que el
 * formulario muestre su propio error genérico.
 */
export function fromStructuredError(
  state: CheckoutState,
  body:  StructuredErrorBody,
): StructuredErrorOutcome | null {
  if (body.code === 'price_changed' && Array.isArray(body.changes)) {
    const prices = (body.changes as Array<Record<string, unknown>>)
      .filter((c) => typeof c.item_id === 'string' && typeof c.current_unit_price === 'string')
      .map((c) => ({ item_id: c.item_id as string, current_unit_price: c.current_unit_price as string }))

    return {
      code:    'price_changed',
      itemIds: prices.map((p) => p.item_id),
      prices,
      state:   { ...state, step: 'cart', notice: PRICE_CHANGED_NOTICE },
    }
  }

  if (body.code === 'cart_changed' && Array.isArray(body.items)) {
    const itemIds = (body.items as Array<Record<string, unknown>>)
      .map((i) => i.item_id)
      .filter((id): id is string => typeof id === 'string')

    return {
      code:    'cart_changed',
      itemIds,
      prices:  [],
      state:   { ...state, step: 'cart', notice: CART_CHANGED_NOTICE },
    }
  }

  return null
}

/**
 * Se cerró el panel.
 *
 * Recién acá se descarta el resultado: mientras SUCCESS esté visible, la
 * referencia y el CTA tienen que seguir en pantalla.
 */
export function onSheetClosed(): CheckoutState {
  return INITIAL_CHECKOUT_STATE
}

/** Si en este paso corresponde montar el formulario. */
export function showsForm(state: CheckoutState): boolean {
  return state.step === 'checkout'
}

/** La referencia que se le muestra a la persona, o null. */
export function successReference(state: CheckoutState): string | null {
  return state.step === 'success' ? state.result?.reference ?? null : null
}

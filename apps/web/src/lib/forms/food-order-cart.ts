import { createAdminClient } from '@orderflow/supabase/admin'
import {
  addMoneyCents,
  centsToMoneyString,
  dbMoneyNumberToCents,
  moneyStringToCents,
  multiplyMoneyCents,
  type FoodOrderInput,
  type FoodOrderInputLine,
  type FoodOrderResolvedLine,
  type FoodOrderResolvedPayload,
} from '@orderflow/validators'

// ═══════════════════════════════════════════════════════════════════════════
// Fase 3E-C3B1 — resolución canónica del carrito. SERVER-SIDE, sin excepción.
//
// ── QUÉ DECIDE ESTE MÓDULO ──────────────────────────────────────────────────
//
// El browser manda item_id + cantidad + una expectativa de precio. Acá se
// decide, releyendo el catálogo:
//
//   · si cada producto TODAVÍA se puede pedir;
//   · cuánto sale REALMENTE (menu_items.base_price, no lo que dijo el browser);
//   · en qué moneda (tenants.currency, tampoco del browser);
//   · cuánto da el subtotal, en centavos enteros.
//
// ── POR QUÉ createAdminClient ───────────────────────────────────────────────
//
// El endpoint es público y anónimo: no hay sesión, así que no hay RLS que
// aplicar. El service_role SALTEA RLS, de modo que el aislamiento multi-tenant
// NO lo garantiza la base — lo garantiza el `.eq('tenant_id', tenantId)` que
// está en las DOS consultas de abajo, con tenantId resuelto server-side desde el
// slug público. Si alguien borra uno de esos filtros, un pedido podría leer
// precios de otro restaurante. Por eso hay tests que los fijan.
//
// ── LO QUE NO HACE ──────────────────────────────────────────────────────────
//
// No consolida líneas, no las reordena y no las descarta. Dos líneas del mismo
// producto con notas distintas son dos pedidos distintos y salen tal cual
// entraron, en el mismo orden. Tampoco crea nada: devolver el payload resuelto
// es todo su trabajo.
// ═══════════════════════════════════════════════════════════════════════════

/** El precio de un producto cambió mientras el cliente tenía el carrito abierto. */
export interface PriceChange {
  item_id:             string
  previous_unit_price: string
  current_unit_price:  string
}

/**
 * Un producto del carrito ya no se puede pedir.
 *
 * Hay UN solo motivo, y es deliberado. Da igual si el item no existe, si es de
 * otro tenant, si lo despublicaron, si lo marcaron sin stock, si lo archivaron o
 * si apagaron su categoría: desde afuera todos esos casos son indistinguibles.
 * Devolver motivos distintos convertiría este endpoint público en un oráculo
 * para averiguar qué productos tiene otro restaurante.
 */
export interface CartItemProblem {
  item_id: string
  reason:  'not_orderable'
}

export type CartResolutionFailure =
  | { code: 'cart_changed';     items:   CartItemProblem[] }
  | { code: 'price_changed';    changes: PriceChange[] }
  | { code: 'amount_too_large' }
  | { code: 'read_failed' }

export interface ResolvedCart {
  items:    FoodOrderResolvedLine[]
  currency: string
  subtotal: string
}

export type CartResolution =
  | { ok: true;  cart: ResolvedCart }
  | { ok: false; failure: CartResolutionFailure }

interface CatalogItem {
  id:         string
  name:       string
  unit_cents: number
}

/**
 * Relee el catálogo y resuelve el carrito.
 *
 * `lines` viene YA validado por foodOrderInputSchema: uuid, cantidad 1..99,
 * precio esperado canónico, entre 1 y MAX_CART_LINES líneas.
 */
export async function resolveFoodOrderCart(
  tenantId: string,
  lines:    FoodOrderInputLine[],
): Promise<CartResolution> {
  const admin = createAdminClient()

  // Los ids ÚNICOS son solo una optimización de lectura: tres líneas del mismo
  // producto son una sola fila que leer. Las LÍNEAS no se tocan.
  const idsUnicos = [...new Set(lines.map((l) => l.item_id))]

  // ── 1. Categorías activas del tenant ─────────────────────────────────────
  // Misma forma que listPublicMenu: una categoría apagada esconde todo lo que
  // cuelga de ella, y el filtro de tenant va explícito en las dos consultas.
  const { data: cats, error: catErr } = await admin
    .from('menu_categories')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('active', true)

  if (catErr) {
    console.error('[food-order] no se pudieron leer las categorías', { code: catErr.code })
    return { ok: false, failure: { code: 'read_failed' } }
  }

  const catIds = (cats ?? []).map((c) => c.id)

  // Sin categorías activas no hay nada pedible. Se responde igual que si los
  // productos hubieran dejado de estar disponibles: no se filtra información.
  if (catIds.length === 0) {
    return { ok: false, failure: { code: 'cart_changed', items: problemas(idsUnicos) } }
  }

  // ── 2. Los productos pedidos, con TODOS los filtros canónicos ────────────
  const { data: rows, error: itemErr } = await admin
    .from('menu_items')
    .select('id, name, base_price')
    .eq('tenant_id', tenantId)
    .eq('published', true)
    .eq('available', true)
    .is('deleted_at', null)
    .in('category_id', catIds)
    .in('id', idsUnicos)

  if (itemErr) {
    console.error('[food-order] no se pudieron leer los productos', { code: itemErr.code })
    return { ok: false, failure: { code: 'read_failed' } }
  }

  const catalogo = new Map<string, CatalogItem>()
  for (const row of rows ?? []) {
    const cents = dbMoneyNumberToCents(row.base_price)
    // Un precio que no se puede representar en centavos no es un precio con el
    // que se pueda cobrar. Se trata como producto no pedible, no como precio 0.
    if (cents === null) {
      console.error('[food-order] precio no representable', { itemId: row.id })
      continue
    }
    catalogo.set(row.id, { id: row.id, name: row.name, unit_cents: cents })
  }

  // ── 3. Productos que ya no se pueden pedir (§8) ──────────────────────────
  // La comparación es contra los ids ÚNICOS, no contra la cantidad de líneas:
  // con tres líneas del mismo producto la base devuelve una fila y eso está bien.
  const faltantes = idsUnicos.filter((id) => !catalogo.has(id))
  if (faltantes.length > 0) {
    return { ok: false, failure: { code: 'cart_changed', items: problemas(faltantes) } }
  }

  // ── 4. Precio cambiado (§7) ──────────────────────────────────────────────
  // Se recorren TODAS las líneas, no los ids únicos: si alguien arma el body a
  // mano y manda dos expectativas distintas para el mismo producto, las dos se
  // comparan. Lo que se REPORTA es una entrada por item_id, que es lo que el
  // browser necesita para actualizar todas sus líneas de ese producto.
  const cambios = new Map<string, PriceChange>()
  for (const linea of lines) {
    const item = catalogo.get(linea.item_id)!
    const esperado = moneyStringToCents(linea.expected_unit_price)
    if (esperado === null || esperado !== item.unit_cents) {
      if (!cambios.has(linea.item_id)) {
        cambios.set(linea.item_id, {
          item_id:             linea.item_id,
          previous_unit_price: linea.expected_unit_price,
          current_unit_price:  centsToMoneyString(item.unit_cents),
        })
      }
    }
  }

  if (cambios.size > 0) {
    return { ok: false, failure: { code: 'price_changed', changes: [...cambios.values()] } }
  }

  // ── 5. Aritmética, en centavos enteros y con el techo verificado ─────────
  const items: FoodOrderResolvedLine[] = []
  let subtotalCents = 0

  for (const linea of lines) {
    const item = catalogo.get(linea.item_id)!

    const lineTotal = multiplyMoneyCents(item.unit_cents, linea.quantity)
    if (lineTotal === null) return { ok: false, failure: { code: 'amount_too_large' } }

    const siguiente = addMoneyCents(subtotalCents, lineTotal)
    if (siguiente === null) return { ok: false, failure: { code: 'amount_too_large' } }
    subtotalCents = siguiente

    items.push({
      item_id:  item.id,
      // Snapshot del nombre: el precio y el nombre se congelan juntos.
      name:     item.name,
      quantity: linea.quantity,
      ...(linea.notes ? { notes: linea.notes } : {}),
      unit_price: centsToMoneyString(item.unit_cents),
      line_total: centsToMoneyString(lineTotal),
    })
  }

  // ── 6. Moneda ────────────────────────────────────────────────────────────
  // Se lee ACÁ y no se recibe por parámetro a propósito: así no existe ninguna
  // ruta por la que un valor del request pueda terminar siendo la moneda del
  // pedido. Es la misma columna que usa la carta pública.
  const { data: tenant, error: tenantErr } = await admin
    .from('tenants')
    .select('currency')
    .eq('id', tenantId)
    .maybeSingle()

  if (tenantErr || !tenant) {
    console.error('[food-order] no se pudo leer la moneda del tenant', { code: tenantErr?.code })
    return { ok: false, failure: { code: 'read_failed' } }
  }

  return {
    ok: true,
    cart: { items, currency: tenant.currency, subtotal: centsToMoneyString(subtotalCents) },
  }
}

function problemas(ids: string[]): CartItemProblem[] {
  return ids.map((item_id) => ({ item_id, reason: 'not_orderable' as const }))
}

/**
 * Arma el payload que se persiste.
 *
 * Los campos del cliente se copian UNO POR UNO, no con spread. Un spread de
 * `input` arrastraría `items` con sus expected_unit_price y cualquier clave que
 * el schema de entrada llegara a aceptar en el futuro; enumerarlos hace que
 * agregar un campo al formulario sea una decisión explícita.
 *
 * La última palabra igual la tiene foodOrderResolvedPayloadSchema, que es
 * .strict() y corre sobre el resultado de esta función.
 */
export function buildResolvedFoodOrderPayload(
  input: FoodOrderInput,
  cart:  ResolvedCart,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name:           input.name,
    fulfillment:    input.fulfillment,
    payment_method: input.payment_method,
    items:          cart.items,
    currency:       cart.currency,
    subtotal:       cart.subtotal,
  }
  // Opcionales: se omiten en vez de guardarse como undefined/null, igual que
  // hace buildSubmissionPayload con el resto de los formularios.
  if (input.address) payload.address = input.address
  if (input.notes)   payload.notes   = input.notes
  return payload
}

export type FoodOrderResolvedPayloadShape = FoodOrderResolvedPayload

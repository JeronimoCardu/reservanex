import { createClient } from '@orderflow/supabase/server'

// Fase 3E-C3C — lectura de pedidos.
//
// ── SOLO LECTURA ────────────────────────────────────────────────────────────
//
// No hay ninguna función de escritura acá, y es deliberado: orders y order_items
// no conceden INSERT/UPDATE/DELETE a authenticated y no tienen policies de
// escritura. Todo lo que muta un pedido pasa por RPC SECURITY DEFINER
// (decide_operation_request para crearlo, transition_order_status para su ciclo
// de vida), que revalidan permiso, estado y transición.
//
// ── TODO ES SNAPSHOT ────────────────────────────────────────────────────────
//
// Se leen name_snapshot / unit_price_snapshot / line_total de order_items y
// currency / subtotal de orders. NUNCA se hace join con menu_items para mostrar
// nombre o precio: el catálogo pudo cambiar después de que el pedido se aceptó,
// y un pedido es evidencia de lo que se acordó.

export type OrderStatus = 'confirmed' | 'preparing' | 'ready' | 'completed' | 'cancelled'

/** Los tres estados que siguen en juego. Es el filtro por defecto del listado. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ['confirmed', 'preparing', 'ready']

export interface OrderListItem {
  id:            string
  status:        OrderStatus
  fulfillment:   'delivery' | 'takeaway'
  currency:      string
  subtotal:      number
  created_at:    string
  confirmed_at:  string
  contact_name:  string | null
  contact_phone: string | null
  /** La referencia pública de la submission, cuando puede resolverse. */
  reference:     string | null
  item_count:    number
}

export interface OrderDetailItem {
  id:                  string
  menu_item_id:        string
  name_snapshot:       string
  unit_price_snapshot: number
  quantity:            number
  line_total:          number
  notes:               string | null
  sort_order:          number
}

export interface OrderDetail extends OrderListItem {
  delivery_address_snapshot: string | null
  payment_method:            'cash' | 'transfer' | 'card'
  notes:                     string | null
  preparing_at:              string | null
  ready_at:                  string | null
  completed_at:              string | null
  cancelled_at:              string | null
  cancellation_reason:       string | null
  operation_request_id:      string
  items:                     OrderDetailItem[]
}

// Una sola lista de columnas, en una línea: partirla en concatenaciones rompe la
// inferencia de tipos de supabase-js (lo aprendimos en 3E-C3A1).
// Una sola lista de columnas, en una línea: partirla en concatenaciones rompe
// la inferencia de tipos de supabase-js (lo aprendimos en 3E-C3A1).
//
// Se trae el detalle COMPLETO en el listado —líneas incluidas— para que el panel
// de detalle abra sin ir al servidor y sin una segunda ruta. Con el tope de 200
// pedidos de hasta 25 líneas es una respuesta chica.
//
// La referencia SUB-XXXXXX se resuelve por el camino real:
// order → operation_request → form_submission. Si algún día una solicitud no
// tuviera submission de origen, queda en null y la UI lo tolera.
const DETAIL_COLUMNS = 'id, status, fulfillment, currency, subtotal, created_at, confirmed_at, delivery_address_snapshot, payment_method, notes, preparing_at, ready_at, completed_at, cancelled_at, cancellation_reason, source_operation_request_id, contacts(name, phone), operation_requests(source_submission_id, form_submissions(reference)), order_items(id, menu_item_id, name_snapshot, unit_price_snapshot, quantity, line_total, notes, sort_order)'

interface FilaCruda {
  id: string
  status: string
  fulfillment: string
  currency: string
  subtotal: number
  created_at: string
  confirmed_at: string
  delivery_address_snapshot: string | null
  payment_method: string
  notes: string | null
  preparing_at: string | null
  ready_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  cancellation_reason: string | null
  source_operation_request_id: string
  contacts: { name: string | null; phone: string | null } | null
  operation_requests: { form_submissions: { reference: string } | null } | null
  order_items: OrderDetailItem[] | null
}

function aDetalle(row: FilaCruda): OrderDetail {
  const items = [...(row.order_items ?? [])].sort((a, b) => a.sort_order - b.sort_order)
  return {
    id:            row.id,
    status:        row.status as OrderStatus,
    fulfillment:   row.fulfillment as 'delivery' | 'takeaway',
    currency:      row.currency,
    subtotal:      row.subtotal,
    created_at:    row.created_at,
    confirmed_at:  row.confirmed_at,
    contact_name:  row.contacts?.name ?? null,
    contact_phone: row.contacts?.phone ?? null,
    reference:     row.operation_requests?.form_submissions?.reference ?? null,
    item_count:    items.length,

    delivery_address_snapshot: row.delivery_address_snapshot,
    payment_method:            row.payment_method as 'cash' | 'transfer' | 'card',
    notes:                     row.notes,
    preparing_at:              row.preparing_at,
    ready_at:                  row.ready_at,
    completed_at:              row.completed_at,
    cancelled_at:              row.cancelled_at,
    cancellation_reason:       row.cancellation_reason,
    operation_request_id:      row.source_operation_request_id,
    // El orden del array del snapshot, que es el orden en que el cliente armó el
    // pedido. Dos líneas del mismo producto se distinguen por su posición.
    items,
  }
}

export interface ListOrdersOptions {
  /** 'active' = confirmed + preparing + ready. 'all' = sin filtro. */
  status?: OrderStatus | 'active' | 'all'
  limit?:  number
}

/**
 * Los pedidos del tenant, más recientes primero.
 *
 * El tenant NO se pasa por parámetro: la RLS de orders ya filtra por
 * auth_tenant_id(), y agregar un .eq() redundante sugeriría que el aislamiento
 * depende de que el llamador se acuerde. Acá el cliente es el de sesión, no el
 * admin.
 */
export async function listOrders(options: ListOrdersOptions = {}): Promise<OrderDetail[]> {
  const { status = 'active', limit = 200 } = options
  const supabase = await createClient()

  let query = supabase
    .from('orders')
    .select(DETAIL_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status === 'active')      query = query.in('status', ACTIVE_ORDER_STATUSES as unknown as string[])
  else if (status !== 'all')    query = query.eq('status', status)

  const { data, error } = await query
  if (error) {
    console.error('[orders] listado falló', { error: error.message })
    return []
  }

  return (data ?? []).map((r) => aDetalle(r as unknown as FilaCruda))
}

/**
 * Los pedidos que salieron de estas solicitudes, si ya se materializaron.
 *
 * Una sola consulta para toda la bandeja de Solicitudes (§22): con ella cada
 * order_request ya decidido puede ofrecer "Ver pedido" sin N+1.
 */
export async function mapOrderIdsByOperationRequest(
  operationRequestIds: string[],
): Promise<Record<string, string>> {
  if (operationRequestIds.length === 0) return {}

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('orders')
    .select('id, source_operation_request_id')
    .in('source_operation_request_id', operationRequestIds)

  if (error) {
    console.error('[orders] mapeo por solicitud falló', { error: error.message })
    return {}
  }

  const mapa: Record<string, string> = {}
  for (const row of data ?? []) mapa[row.source_operation_request_id] = row.id
  return mapa
}

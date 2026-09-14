import { formatMoneyString } from '@orderflow/validators'
import type { StatusFilterOption } from '@/components/tenant/shared/status-filter-tabs'
import type { OrderStatus } from '@/lib/repositories/orders.repository'

// Fase 3E-C3C — cómo se muestra un pedido, y qué se puede hacer con él.
//
// Puro y sin React, por la misma razón que lib/site/cart.ts y
// lib/site/checkout-flow.ts: las reglas del ciclo de vida se prueban sin
// renderizar nada, y el componente solo dibuja el resultado.
//
// La máquina de estados de acá tiene que coincidir con la de
// transition_order_status. La RPC sigue siendo la autoridad —esto solo decide
// qué botones aparecen— pero si divergen el usuario ve acciones que el servidor
// rechaza. Hay un test que fija las seis transiciones.

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  confirmed: 'Confirmado',
  preparing: 'En preparación',
  ready:     'Listo',
  completed: 'Completado',
  cancelled: 'Cancelado',
}

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status as OrderStatus] ?? status
}

export type StatusTone = 'info' | 'warn' | 'ok' | 'muted' | 'danger'

export function orderStatusTone(status: string): StatusTone {
  switch (status) {
    case 'confirmed': return 'info'
    case 'preparing': return 'warn'
    case 'ready':     return 'ok'
    case 'completed': return 'muted'
    case 'cancelled': return 'danger'
    default:          return 'muted'
  }
}

export const FULFILLMENT_LABELS: Record<string, string> = {
  delivery: 'Delivery',
  takeaway: 'Retiro en el local',
}

export const PAYMENT_LABELS: Record<string, string> = {
  cash:     'Efectivo',
  transfer: 'Transferencia',
  card:     'Tarjeta',
}

export function fulfillmentLabel(value: string): string {
  return FULFILLMENT_LABELS[value] ?? value
}

export function paymentLabel(value: string): string {
  return PAYMENT_LABELS[value] ?? value
}

// ── La máquina de estados (§14) ─────────────────────────────────────────────

/**
 * Las SEIS transiciones válidas, enumeradas. Mismo mapa que la RPC.
 *
 * completed y cancelled no aparecen como origen: son terminales.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready:     ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

export function canTransition(from: string, to: string): boolean {
  const permitidas = ORDER_TRANSITIONS[from as OrderStatus]
  return permitidas !== undefined && permitidas.includes(to as OrderStatus)
}

export function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'cancelled'
}

export interface OrderAction {
  /** El estado destino que hay que mandarle a la RPC. */
  target: OrderStatus
  label:  string
  /** El avance del flujo, en contraposición a cancelar. */
  primary: boolean
}

/**
 * Las acciones que corresponde ofrecer según el estado (§21).
 *
 * Un estado terminal no ofrece ninguna: no es que estén deshabilitadas, es que
 * no existen.
 */
export function actionsForStatus(status: string): OrderAction[] {
  switch (status) {
    case 'confirmed':
      return [
        { target: 'preparing', label: 'Comenzar preparación', primary: true },
        { target: 'cancelled', label: 'Cancelar',             primary: false },
      ]
    case 'preparing':
      return [
        { target: 'ready',     label: 'Marcar como listo', primary: true },
        { target: 'cancelled', label: 'Cancelar',          primary: false },
      ]
    case 'ready':
      return [
        { target: 'completed', label: 'Marcar como completado', primary: true },
        { target: 'cancelled', label: 'Cancelar',               primary: false },
      ]
    default:
      return []
  }
}

// ── Filtros del listado (§19) ───────────────────────────────────────────────

export type OrderFilter = OrderStatus | 'active' | 'all'

/**
 * Los filtros de la bandeja, en el orden del flujo de trabajo.
 *
 * "Activos" primero porque es lo que hay que atender AHORA; después el recorrido
 * de un pedido, y "Todos" al final como vista general.
 *
 * El `tone` es un punto diminuto al lado de la etiqueta — énfasis semántico
 * discreto, nunca la única señal: el texto siempre está y el estado activo se
 * distingue por fondo y peso, no por color.
 */
export const ORDER_FILTERS: ReadonlyArray<StatusFilterOption<OrderFilter>> = [
  { value: 'active',    label: 'Activos',     tone: 'pending'  },
  { value: 'confirmed', label: 'Confirmados', tone: 'neutral'  },
  { value: 'preparing', label: 'Preparando',  tone: 'pending'  },
  { value: 'ready',     label: 'Listos',      tone: 'positive' },
  { value: 'completed', label: 'Completados' },
  { value: 'cancelled', label: 'Cancelados',  tone: 'negative' },
  { value: 'all',       label: 'Todos' },
]

const VALID_FILTERS = new Set<string>(ORDER_FILTERS.map((f) => f.value))

export function parseOrderFilter(raw: string | undefined): OrderFilter {
  return raw && VALID_FILTERS.has(raw) ? (raw as OrderFilter) : 'active'
}

export function orderFilterHref(value: OrderFilter): string {
  // 'active' es el default: se deja la URL limpia en vez de ?status=active.
  return value === 'active' ? '/dashboard/orders' : `/dashboard/orders?status=${value}`
}

/**
 * Qué decir cuando el filtro no tiene resultados.
 *
 * Una tabla vacía con un filtro puesto no dice si no hay pedidos o si el filtro
 * los esconde. El copy lo aclara.
 */
export function emptyOrdersCopy(filter: OrderFilter): { title: string; hint: string } {
  const PISTA_ORIGEN = 'Los pedidos aparecen acá cuando aceptás una solicitud en Solicitudes.'
  switch (filter) {
    case 'active':
      return { title: 'No hay pedidos activos.', hint: PISTA_ORIGEN }
    case 'confirmed':
      return { title: 'No hay pedidos confirmados.', hint: 'Acá aparecen los aceptados que todavía no empezaste a preparar.' }
    case 'preparing':
      return { title: 'No hay pedidos preparando.', hint: 'Los que marques como en preparación van a quedar listados acá.' }
    case 'ready':
      return { title: 'No hay pedidos listos.', hint: 'Los que marques como listos van a quedar listados acá.' }
    case 'completed':
      return { title: 'No hay pedidos completados.', hint: 'Los que entregues y marques como completados quedan acá.' }
    case 'cancelled':
      return { title: 'No hay pedidos cancelados.', hint: 'Cancelar un pedido no es lo mismo que rechazar una solicitud.' }
    default:
      return { title: 'Todavía no hay pedidos.', hint: PISTA_ORIGEN }
  }
}

// ── Plata ───────────────────────────────────────────────────────────────────

/**
 * Un monto de la base (NUMERIC → number en supabase-js) con su moneda.
 *
 * Pasa por centsToMoneyString/formatMoneyString —los helpers canónicos— en vez
 * de por toFixed(2) suelto, para que el pedido se lea igual acá que en el
 * carrito público y que en el resumen de WhatsApp.
 */
export function formatOrderMoney(value: number, currency: string): string {
  const entero = Math.round(value * 100)
  const signo  = entero < 0 ? '-' : ''
  const abs    = Math.abs(entero)
  const canon  = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
  return `${signo}${formatMoneyString(canon, currency)}`
}

/** "2 × Muzzarella" — la línea tal como se lee en una comanda. */
export function orderLineLabel(quantity: number, name: string): string {
  return `${quantity} × ${name}`
}

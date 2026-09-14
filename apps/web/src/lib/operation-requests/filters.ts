import type { StatusFilterOption } from '@/components/tenant/shared/status-filter-tabs'

// Fase 3E-C3C (pulido UX) — los filtros de la bandeja de Solicitudes.
//
// Vive fuera del componente para poder probarse sin renderizar: el repo no tiene
// entorno DOM, así que lo que se puede hacer puro, se hace puro.
//
// ── LOS ESTADOS INTERNOS NO SE TOCAN ────────────────────────────────────────
//
// `value` son los status REALES de operation_requests: pending / confirmed /
// rejected. Lo único que cambia es cómo se llaman en pantalla. Renombrar el
// estado interno para que coincida con el copy sería mover el problema a la
// base.

export type RequestFilter = 'all' | 'pending' | 'confirmed' | 'rejected' | 'cancelled'

/**
 * El orden es el pedido: "Todas" primero como vista general, y después el
 * recorrido natural de una solicitud — pendiente, aprobada, rechazada.
 *
 * 'cancelled' NO tiene pill: ninguna solicitud llega a ese estado por el flujo
 * actual (se cancelan los pedidos, no las solicitudes). Se sigue aceptando por
 * URL para no romper un link viejo, pero no se ofrece una pestaña vacía.
 */
export const REQUEST_FILTERS: ReadonlyArray<StatusFilterOption<RequestFilter>> = [
  { value: 'all',       label: 'Todas' },
  { value: 'pending',   label: 'Pendientes', tone: 'pending'  },
  { value: 'confirmed', label: 'Aprobadas',  tone: 'positive' },
  { value: 'rejected',  label: 'Rechazadas', tone: 'negative' },
]

/** Todo lo que la URL acepta, incluidos los que no tienen pill. */
const VALORES_VALIDOS = new Set<string>(['all', 'pending', 'confirmed', 'rejected', 'cancelled'])

/**
 * El filtro que pide la URL, o el default.
 *
 * Default 'pending': es el trabajo por hacer, y es con lo que se abre la
 * bandeja. Cualquier cosa que no reconozcamos cae ahí — nunca a un estado
 * inventado ni a una pantalla rota.
 */
export function parseRequestFilter(raw: string | undefined): RequestFilter {
  return raw && VALORES_VALIDOS.has(raw) ? (raw as RequestFilter) : 'pending'
}

export function requestFilterHref(value: RequestFilter): string {
  // 'pending' es el default: se deja la URL limpia en vez de ?status=pending.
  return value === 'pending' ? '/dashboard/requests' : `/dashboard/requests?status=${value}`
}

/**
 * Qué decir cuando el filtro no tiene resultados.
 *
 * Contextual a propósito: "No hay solicitudes." con un filtro puesto hace dudar
 * de si la bandeja está vacía o de si el filtro esconde algo.
 */
export function emptyRequestsCopy(filter: RequestFilter): { title: string; hint: string } {
  switch (filter) {
    case 'pending':
      return {
        title: 'No hay solicitudes pendientes.',
        hint:  'Cuando un cliente confirme sus datos por WhatsApp, la solicitud aparece acá.',
      }
    case 'confirmed':
      return { title: 'No hay solicitudes aprobadas.', hint: 'Las que apruebes van a quedar listadas acá.' }
    case 'rejected':
      return { title: 'No hay solicitudes rechazadas.', hint: 'Las que rechaces van a quedar listadas acá.' }
    case 'cancelled':
      return { title: 'No hay solicitudes canceladas.', hint: '' }
    default:
      return {
        title: 'Todavía no hay solicitudes.',
        hint:  'Cuando un cliente confirme sus datos por WhatsApp, la solicitud aparece acá.',
      }
  }
}

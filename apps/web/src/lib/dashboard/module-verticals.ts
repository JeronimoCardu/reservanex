import type { TenantVertical } from '@orderflow/validators'

// Fase 3E-C3A1 — qué módulos del dashboard existen para qué rubro.
//
// ── EL BUG QUE CIERRA ───────────────────────────────────────────────────────
//
// Hasta acá el sidebar y el mobile nav filtraban solo por `ownerOnly` y
// `setupBlocked`. Nada miraba tenants.vertical. Resultado real: una
// inmobiliaria veía "Reservas de mesa" y un restaurante veía "Propiedades",
// "Reservas", "Visitas" y "Alquileres mensuales" — cuatro módulos de un dominio
// que ese tenant no tiene. Y escribiendo la URL a mano entraba igual.
//
// ── UNA SOLA FUENTE DE VERDAD ───────────────────────────────────────────────
//
// Este mapa lo consumen DOS lugares y nada más:
//
//   1. lib/dashboard/nav-items.ts   → filtra los links (sidebar + mobile nav,
//                                      que comparten la misma definición).
//   2. lib/auth/require-tenant-vertical.ts → corta la ruta server-side.
//
// Esconder un link NO es autorización. Los dos consumidores son necesarios: el
// primero es UX, el segundo es la garantía.
//
// ── VERTICAL ≠ PERMISO ──────────────────────────────────────────────────────
//
// El vertical decide si el MÓDULO EXISTE para ese tenant. El permiso decide si
// ESE USUARIO puede modificarlo. Son ejes independientes:
//
//   receptionist de food_service sin can_manage_menu
//     → SÍ entra a /dashboard/menu y ve la carta; NO puede editarla.
//   tenant real_estate, aunque sea owner
//     → NO tiene ese módulo. notFound().

/**
 * Módulos con rubro. Un href SIN entrada acá es TRANSVERSAL a propósito:
 * conversaciones, solicitudes, contactos, tareas, usuarios, configuración y
 * workspaces existen igual en los dos rubros.
 *
 * Las claves son prefijos de ruta: se compara con startsWith, así que
 * /dashboard/properties cubre /dashboard/properties/[id].
 */
export const MODULE_VERTICALS = {
  // ── Solo inmobiliario ─────────────────────────────────────────────────────
  '/dashboard/properties':        ['real_estate'],
  // El listado de reservas de alquiler temporal, con sus bloqueos de
  // disponibilidad, pagos y recibos.
  '/dashboard/reservations':      ['real_estate'],
  '/dashboard/visits':            ['real_estate'],
  '/dashboard/monthly-rentals':   ['real_estate'],

  // ── Solo gastronómico ─────────────────────────────────────────────────────
  '/dashboard/table-reservations': ['food_service'],
  '/dashboard/menu':               ['food_service'],
} as const satisfies Record<string, readonly TenantVertical[]>

export type VerticalScopedRoute = keyof typeof MODULE_VERTICALS

const SCOPED_PREFIXES = Object.keys(MODULE_VERTICALS) as VerticalScopedRoute[]

/**
 * Los rubros para los que existe una ruta, o `null` si es transversal.
 *
 * Resuelve por prefijo más largo para que un módulo anidado pudiera, algún día,
 * declarar un rubro distinto al de su padre sin que el orden del objeto importe.
 */
export function verticalsForRoute(pathname: string): readonly TenantVertical[] | null {
  let match: VerticalScopedRoute | null = null
  for (const prefix of SCOPED_PREFIXES) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    if (match === null || prefix.length > match.length) match = prefix
  }
  return match === null ? null : MODULE_VERTICALS[match]
}

/** Si el rubro del tenant puede ver esa ruta. Transversal ⇒ siempre sí. */
export function routeAllowsVertical(pathname: string, vertical: TenantVertical): boolean {
  const allowed = verticalsForRoute(pathname)
  return allowed === null || allowed.includes(vertical)
}

import type { ElementType } from 'react'
import {
  MessageSquareIcon,
  Users2Icon,
  Building2Icon,
  CheckSquareIcon,
  UsersIcon,
  CalendarIcon,
  BarChart3Icon,
  KeyRoundIcon,
  InboxIcon,
  CalendarClockIcon,
  UtensilsCrossedIcon,
  ChefHatIcon,
} from 'lucide-react'
import type { TenantRole } from '@orderflow/types'
import type { TenantVertical } from '@orderflow/validators'
import { routeAllowsVertical } from './module-verticals'

// Fase 3E-C3A1 — la definición del nav del dashboard, en UN solo lugar.
//
// Antes esta lista estaba duplicada palabra por palabra en dashboard-sidebar.tsx
// y mobile-nav.tsx. Eso ya era frágil, y agregar el filtro por rubro en dos
// copias habría garantizado que tarde o temprano divergieran y el escritorio
// mostrara módulos que el celular no. Ahora los dos consumen esto.
//
// El rubro NO se declara acá: sale de MODULE_VERTICALS, el mismo mapa que usa el
// guard de ruta server-side. Un link visible cuya ruta después tira 404 sería
// peor que no mostrarlo, así que las dos decisiones leen la misma tabla.

export interface DashboardNavItem {
  label:        string
  href:         string
  icon:         ElementType
  ownerOnly:    boolean
  setupBlocked: boolean
}

export const ALL_NAV_ITEMS: readonly DashboardNavItem[] = [
  { label: 'Conversaciones',       href: '/dashboard/conversations',      icon: MessageSquareIcon,   ownerOnly: false, setupBlocked: true  },
  // Transversal a propósito: presenta los kinds que haya en el tenant
  // (reservation_request, inquiry, visit_request, table_request, order_request).
  { label: 'Solicitudes',          href: '/dashboard/requests',           icon: InboxIcon,           ownerOnly: false, setupBlocked: true  },
  { label: 'Contactos',            href: '/dashboard/contacts',           icon: Users2Icon,          ownerOnly: false, setupBlocked: true  },
  { label: 'Propiedades',          href: '/dashboard/properties',         icon: Building2Icon,       ownerOnly: false, setupBlocked: false },
  { label: 'Reservas',             href: '/dashboard/reservations',       icon: CalendarIcon,        ownerOnly: false, setupBlocked: true  },
  { label: 'Visitas',              href: '/dashboard/visits',             icon: CalendarClockIcon,   ownerOnly: false, setupBlocked: true  },
  { label: 'Reservas de mesa',     href: '/dashboard/table-reservations', icon: UtensilsCrossedIcon, ownerOnly: false, setupBlocked: true  },
  { label: 'Menú',                 href: '/dashboard/menu',               icon: ChefHatIcon,         ownerOnly: false, setupBlocked: true  },
  { label: 'Alquileres mensuales', href: '/dashboard/monthly-rentals',    icon: KeyRoundIcon,        ownerOnly: false, setupBlocked: true  },
  { label: 'Tareas',               href: '/dashboard/tasks',              icon: CheckSquareIcon,     ownerOnly: false, setupBlocked: true  },
  { label: 'Usuarios',             href: '/dashboard/users',              icon: UsersIcon,           ownerOnly: true,  setupBlocked: false },
]

export const COMING_SOON: readonly { label: string; icon: ElementType }[] = [
  { label: 'Métricas', icon: BarChart3Icon },
]

export interface NavVisibilityInput {
  role:            TenantRole
  vertical:        TenantVertical
  isSetupOperator: boolean
}

/**
 * Los links que le corresponden a este usuario en este tenant.
 *
 * Tres filtros, en este orden: modo setup, rol, rubro. El de rubro es el único
 * que además tiene un guard server-side equivalente — los otros dos ya lo
 * tenían (las páginas owner-only llaman a requireOwner()).
 */
export function visibleNavItems({
  role,
  vertical,
  isSetupOperator,
}: NavVisibilityInput): DashboardNavItem[] {
  return ALL_NAV_ITEMS.filter((item) => {
    if (isSetupOperator && item.setupBlocked) return false
    if (item.ownerOnly && role !== 'owner') return false
    if (!routeAllowsVertical(item.href, vertical)) return false
    return true
  })
}

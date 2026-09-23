import type { ElementType } from 'react'
import {
  HeadsetIcon,
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
  ReceiptTextIcon,
} from 'lucide-react'
import type { TenantRole } from '@orderflow/types'
import type { TenantVertical, FoodCapabilities } from '@orderflow/validators'
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
  /**
   * Atención humana V2 — qué contador muestra este link como badge. El número
   * lo calcula el layout del dashboard UNA vez (respetando las RLS del usuario)
   * y lo reciben el sidebar y el mobile nav por props; acá sólo se declara la
   * clave. Sin badgeKey, sin badge.
   */
  badgeKey?:    NavBadgeKey
}

export type NavBadgeKey = 'attention'
export type NavBadges   = Partial<Record<NavBadgeKey, number>>

export const ALL_NAV_ITEMS: readonly DashboardNavItem[] = [
  // Atención humana V2 — reemplaza a Conversaciones. No es un inbox: es la
  // bandeja de clientes esperando una persona. El badge cuenta CASOS pendientes
  // (conversaciones con human_attention_pending), no mensajes.
  { label: 'Atención humana',      href: '/dashboard/attention',          icon: HeadsetIcon,         ownerOnly: false, setupBlocked: true, badgeKey: 'attention' },
  // Transversal a propósito: presenta los kinds que haya en el tenant
  // (reservation_request, inquiry, visit_request, table_request, order_request).
  { label: 'Solicitudes',          href: '/dashboard/requests',           icon: InboxIcon,           ownerOnly: false, setupBlocked: true  },
  { label: 'Contactos',            href: '/dashboard/contacts',           icon: Users2Icon,          ownerOnly: false, setupBlocked: true  },
  { label: 'Propiedades',          href: '/dashboard/properties',         icon: Building2Icon,       ownerOnly: false, setupBlocked: false },
  { label: 'Reservas',             href: '/dashboard/reservations',       icon: CalendarIcon,        ownerOnly: false, setupBlocked: true  },
  { label: 'Visitas',              href: '/dashboard/visits',             icon: CalendarClockIcon,   ownerOnly: false, setupBlocked: true  },
  { label: 'Reservas de mesa',     href: '/dashboard/table-reservations', icon: UtensilsCrossedIcon, ownerOnly: false, setupBlocked: true  },
  { label: 'Menú',                 href: '/dashboard/menu',               icon: ChefHatIcon,         ownerOnly: false, setupBlocked: true  },
  { label: 'Pedidos',              href: '/dashboard/orders',             icon: ReceiptTextIcon,     ownerOnly: false, setupBlocked: true  },
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
  /** Capacidades del tenant gastronómico. Ausente = no aplica. */
  capabilities?: FoodCapabilities | null
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
  capabilities,
}: NavVisibilityInput): DashboardNavItem[] {
  return ALL_NAV_ITEMS.filter((item) => {
    if (isSetupOperator && item.setupBlocked) return false
    if (item.ownerOnly && role !== 'owner') return false
    if (!routeAllowsVertical(item.href, vertical)) return false

    // Las capacidades del local esconden módulos DENTRO de su vertical. El
    // guard de vertical sigue siendo el de afuera: esto no lo reemplaza, lo
    // afina.
    //
    // Sólo Reservas de mesa se oculta. Menú queda siempre —un restaurante
    // tiene carta aunque no tome pedidos ni reservas— y Pedidos también,
    // porque el histórico sigue siendo válido y hay que poder trabajarlo:
    // apagar delivery no cancela los pedidos que ya entraron.
    if (item.href === '/dashboard/table-reservations'
        && capabilities && !capabilities.tableReservations) {
      return false
    }

    return true
  })
}

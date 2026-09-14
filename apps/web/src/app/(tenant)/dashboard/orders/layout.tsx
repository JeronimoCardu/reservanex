import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { requireRouteVertical } from '@/lib/auth/require-tenant-vertical'

// Fase 3E-C3C — guard de rubro.
//
// Los pedidos son gastronómicos. Está en el layout, no en el page, para que
// cualquier subruta futura quede cubierta sin que nadie tenga que acordarse.
//
// El rubro sale de lib/dashboard/module-verticals.ts, el MISMO mapa que filtra
// el nav: un link visible cuya ruta después tira 404 sería peor que no
// mostrarlo.
//
// Esto NO es un chequeo de permisos: decide si el módulo EXISTE para el tenant.
// Un tenant inmobiliario recibe 404 aunque escriba la URL a mano, sea owner o
// no. Quién puede OPERAR los pedidos dentro del módulo lo decide
// can_manage_orders.

export default async function OrdersLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenantContext()
  requireRouteVertical(ctx, '/dashboard/orders')
  return <>{children}</>
}

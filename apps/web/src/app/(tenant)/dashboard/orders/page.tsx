import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { listOrders } from '@/lib/repositories/orders.repository'
import { parseOrderFilter } from '@/lib/orders/presentation'
import { OrdersClient } from './orders-client'

// Fase 3E-C3C — la bandeja operacional de pedidos.
//
// El guard de rubro vive en layout.tsx: un tenant inmobiliario recibe 404 acá
// aunque escriba la URL a mano.
//
// Se LEE sin exigir can_manage_orders, igual que el resto de los módulos: ver
// los pedidos es parte de trabajar en el local. Lo que exige el permiso es
// OPERARLOS, y eso lo decide la RPC por cada transición — acá solo se decide si
// se dibujan los botones.

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const ctx    = await requireTenantContext()
  const params = await searchParams
  const filter = parseOrderFilter(params.status)

  const orders = await listOrders({ status: filter, limit: 200 })

  const canManageOrders = ctx.role === 'owner' || ctx.canManageOrders

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold">Pedidos</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {orders.length} pedido{orders.length !== 1 ? 's' : ''}
          {filter !== 'all' ? ' · filtrado' : ''}
        </p>
      </div>

      <OrdersClient
        orders={orders}
        activeFilter={filter}
        canManageOrders={canManageOrders}
      />
    </div>
  )
}

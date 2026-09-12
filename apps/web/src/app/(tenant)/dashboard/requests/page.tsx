import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  listOperationRequests,
  type OperationRequestStatus,
} from '@/lib/repositories/operation-requests.repository'
import { RequestsClient } from './requests-client'

export const metadata: Metadata = { title: 'Solicitudes — ReservaNex' }

// Fase 3D — bandeja de solicitudes.
//
// Una operation_request es un pedido que hizo un cliente por WhatsApp y que la
// empresa todavía no aprobó ni rechazó. Aprobarla acá significa exactamente
// eso: la empresa la aprobó. NO crea reserva, pedido ni cita, y no bloquea
// fechas — esa materialización es la Fase 3E.

const VALID_FILTERS = new Set(['pending', 'confirmed', 'rejected', 'cancelled', 'all'])

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard')

  const params = await searchParams
  const raw    = params.status
  // Default: pendientes primero, que son las que requieren acción (§15).
  const filter = (raw && VALID_FILTERS.has(raw) ? raw : 'pending') as OperationRequestStatus | 'all'

  const requests = await listOperationRequests({ status: filter, limit: 200 })

  // Fase 3E-B1 — el permiso depende del TIPO de solicitud, no es uno solo para
  // toda la bandeja: gestionar una consulta no es la misma autoridad que
  // aprobar una reserva. La RPC lo revalida por kind igual — esto solo decide
  // qué botones se dibujan.
  const canDecideReservations = ctx.role === 'owner' || ctx.canConfirmReservations
  const canManageInquiries    = ctx.role === 'owner' || ctx.canManageInquiries
  const canManageVisits       = ctx.role === 'owner' || ctx.canManageVisits
  const canManageTables       = ctx.role === 'owner' || ctx.canManageTableReservations

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Solicitudes</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {requests.length} solicitud{requests.length !== 1 ? 'es' : ''}
          {filter !== 'all' ? ' · filtrado' : ''}
        </p>
      </div>

      <RequestsClient
        requests={requests}
        canDecideReservations={canDecideReservations}
        canManageInquiries={canManageInquiries}
        canManageVisits={canManageVisits}
        canManageTables={canManageTables}
        activeFilter={filter}
      />
    </div>
  )
}

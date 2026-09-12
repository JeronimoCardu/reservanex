import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  listTableReservations,
  type TableReservationFilter,
} from '@/lib/repositories/table-reservations.repository'
import { TableReservationsClient } from './table-reservations-client'

// Fase 3E-C2 — la agenda de reservas de mesa.
//
// Existe porque ahora hay una entidad operacional: una reserva con fecha, hora,
// cantidad de personas y ciclo de vida propio.

const VALID: ReadonlySet<string> = new Set([
  'upcoming', 'confirmed', 'completed', 'cancelled', 'no_show', 'all',
])

export default async function TableReservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const ctx = await requireTenantContext()
  const params = await searchParams
  const raw = params.filter
  // Por defecto las próximas: son las que hay que atender.
  const filter = (raw && VALID.has(raw) ? raw : 'upcoming') as TableReservationFilter

  const reservations = await listTableReservations({ filter })

  // Gestionar reservas de mesa es su propio permiso desde 3E-C2. Las RPC lo
  // revalidan igual — esto solo decide si se dibujan los botones.
  const canManage = ctx.role === 'owner' || ctx.canManageTableReservations

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold">Reservas de mesa</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {reservations.length} reserva{reservations.length !== 1 ? 's' : ''}
          {filter === 'upcoming' ? ' próxima' + (reservations.length !== 1 ? 's' : '') : ''}
        </p>
      </div>

      <TableReservationsClient
        reservations={reservations}
        canManage={canManage}
        activeFilter={filter}
      />
    </div>
  )
}

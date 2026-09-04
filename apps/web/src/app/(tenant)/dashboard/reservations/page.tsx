import type { Metadata } from 'next'
import type { ReservationStatus } from '@orderflow/types'
import { redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { listReservationsByTenant } from '@/lib/repositories/reservations.repository'
import { getReservationDocumentBadges } from '@/lib/repositories/reservation-badges.repository'
import { listContacts } from '@/lib/repositories/contacts.repository'
import { listPropertiesForReservation } from '@/lib/repositories/properties.repository'
import { ReservationsClient } from './reservations-client'

export const metadata: Metadata = { title: 'Reservas — ReservaNex' }

export default async function ReservationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const ctx    = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard')
  const params = await searchParams
  const statusFilter = params.status as ReservationStatus | undefined

  const canConfirm = ctx.role === 'owner' || ctx.canConfirmReservations

  const [reservations, contacts, properties] = await Promise.all([
    listReservationsByTenant(ctx.tenantId, { status: statusFilter, limit: 200 }),
    canConfirm ? listContacts(ctx.tenantId, { limit: 500 }) : Promise.resolve([]),
    canConfirm ? listPropertiesForReservation(ctx.tenantId) : Promise.resolve([]),
  ])

  const documentBadges = await getReservationDocumentBadges(
    ctx.tenantId,
    reservations.map((r) => r.id),
  )

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Reservas</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {reservations.length} reserva{reservations.length !== 1 ? 's' : ''}
          {statusFilter ? ` · filtrado` : ''}
        </p>
      </div>

      <ReservationsClient
        reservations={reservations}
        canConfirm={canConfirm}
        contacts={contacts}
        properties={properties.map(p => ({ id: p.id, title: p.title, city: p.city }))}
        documentBadges={documentBadges}
      />
    </div>
  )
}

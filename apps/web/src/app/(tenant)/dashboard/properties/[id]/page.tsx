import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { getPropertyById } from '@/lib/repositories/properties.repository'
import { listUpcomingReservationsByProperty } from '@/lib/repositories/reservations.repository'
import { listPropertyAvailabilityBlocks } from '@/lib/repositories/property-availability.repository'
import { PropertyDetailHeader } from '@/components/tenant/properties/property-detail-header'
import { PropertyAvailabilitySection } from '@/components/tenant/properties/property-availability-section'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const ctx      = await requireTenantContext()
  const { id }   = await params
  const property = await getPropertyById(ctx.tenantId, id)
  const title    = property?.title ?? 'Propiedad'
  return { title: `${title} — ReservaNex` }
}

export default async function PropertyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx      = await requireTenantContext()
  const { id }   = await params
  const property = await getPropertyById(ctx.tenantId, id)

  if (!property) notFound()

  const canManage = ctx.role === 'owner' || ctx.canConfirmReservations

  const [reservations, blocks] = await Promise.all([
    listUpcomingReservationsByProperty(ctx.tenantId, id),
    listPropertyAvailabilityBlocks(ctx.tenantId, id),
  ])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
          <PropertyDetailHeader
            property={property}
            currentRole={ctx.role}
            canCreateProperties={ctx.canCreateProperties}
          />

          <div className="border-t pt-8">
            <PropertyAvailabilitySection
              propertyId={id}
              reservations={reservations}
              blocks={blocks}
              canManage={canManage}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  getMonthlyRentalDashboardStats,
  listMonthlyRentalContracts,
  listAvailableLongTermRentalProperties,
  listTenantContactsForRental,
  listMonthlyRentalOverdueCharges,
  listMonthlyRentalUpcomingCharges,
  listMonthlyRentalEndingContracts,
  listMonthlyRentalExpiredActiveContracts,
} from '@/lib/repositories/monthly-rentals.repository'
import { MonthlyRentalsClient } from './monthly-rentals-client'

export const metadata: Metadata = { title: 'Alquileres mensuales — ReservaNex' }

export default async function MonthlyRentalsPage() {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard')
  const isOwner = ctx.role === 'owner'

  const [
    stats, contracts, properties, contacts,
    overdueCharges, upcomingCharges, endingContracts, expiredContracts,
  ] = await Promise.all([
    getMonthlyRentalDashboardStats(ctx.tenantId),
    listMonthlyRentalContracts(ctx.tenantId),
    isOwner ? listAvailableLongTermRentalProperties(ctx.tenantId) : Promise.resolve([]),
    isOwner ? listTenantContactsForRental(ctx.tenantId) : Promise.resolve([]),
    listMonthlyRentalOverdueCharges(ctx.tenantId),
    listMonthlyRentalUpcomingCharges(ctx.tenantId),
    listMonthlyRentalEndingContracts(ctx.tenantId),
    listMonthlyRentalExpiredActiveContracts(ctx.tenantId),
  ])

  return (
    <MonthlyRentalsClient
      stats={stats}
      contracts={contracts}
      properties={properties}
      contacts={contacts}
      isOwner={isOwner}
      overdueCharges={overdueCharges}
      upcomingCharges={upcomingCharges}
      endingContracts={endingContracts}
      expiredContracts={expiredContracts}
    />
  )
}

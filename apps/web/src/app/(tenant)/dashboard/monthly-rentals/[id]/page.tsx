import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  getMonthlyRentalContractById,
  getMonthlyRentalDebtSummary,
  listAvailableLongTermRentalProperties,
  listTenantContactsForRental,
  listMonthlyRentalPayments,
  listMonthlyRentalFollowUpTasks,
  listMonthlyRentalDocuments,
} from '@/lib/repositories/monthly-rentals.repository'
import { ContractDetailClient } from './contract-detail-client'

export const metadata: Metadata = { title: 'Contrato — ReservaNex' }

export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id }  = await params
  const ctx     = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard')
  const isOwner = ctx.role === 'owner'

  const contract = await getMonthlyRentalContractById(ctx.tenantId, id)
  if (!contract) notFound()

  const [properties, contacts, debtSummary, payments, followUpTasks, documents] = await Promise.all([
    isOwner
      ? listAvailableLongTermRentalProperties(ctx.tenantId, contract.property_id)
      : Promise.resolve([]),
    isOwner ? listTenantContactsForRental(ctx.tenantId) : Promise.resolve([]),
    getMonthlyRentalDebtSummary(ctx.tenantId, id),
    listMonthlyRentalPayments(ctx.tenantId, id),
    listMonthlyRentalFollowUpTasks(ctx.tenantId, id),
    listMonthlyRentalDocuments(ctx.tenantId, id),
  ])

  return (
    <ContractDetailClient
      contract={contract}
      properties={properties}
      contacts={contacts}
      debtSummary={debtSummary}
      payments={payments}
      followUpTasks={followUpTasks}
      documents={documents}
      isOwner={isOwner}
    />
  )
}

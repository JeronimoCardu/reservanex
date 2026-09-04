import { redirect } from 'next/navigation'
import { requireTenantContext } from './require-tenant-context'
import type { AccessMode } from './require-tenant-context'

export type OwnerContext = {
  userId:     string
  tenantId:   string
  accessMode: AccessMode
}

export async function requireOwner(): Promise<OwnerContext> {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner') redirect('/dashboard')

  return { userId: ctx.userId, tenantId: ctx.tenantId, accessMode: ctx.accessMode }
}

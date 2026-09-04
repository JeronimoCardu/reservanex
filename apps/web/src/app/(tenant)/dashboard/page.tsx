import { redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'

export default async function DashboardPage() {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') {
    redirect('/dashboard/properties')
  }
  redirect('/dashboard/conversations')
}

import type { Metadata } from 'next'
import { requireOwner } from '@/lib/auth/require-owner'
import { listTenantUsers } from '@/lib/repositories/users.repository'
import { UserTable } from '@/components/tenant/users/user-table'

export const metadata: Metadata = {
  title: 'Usuarios — ReservaNex',
}

export default async function UsersPage() {
  const { tenantId, userId } = await requireOwner()
  const users = await listTenantUsers(tenantId)

  const active   = users.filter((u) => u.active).length
  const inactive = users.filter((u) => !u.active).length

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b bg-background px-6 py-4">
        <h1 className="text-lg font-semibold">Usuarios</h1>
        <p className="text-xs text-muted-foreground">
          {active} activo{active !== 1 ? 's' : ''}
          {inactive > 0 && ` · ${inactive} inactivo${inactive !== 1 ? 's' : ''}`}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <UserTable users={users} currentUserId={userId} />
      </div>
    </div>
  )
}

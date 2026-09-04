import type { Metadata } from 'next'
import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import {
  getCleanupOverviewAction,
  listTenantsForCleanupAction,
  listSellersForCleanupAction,
} from '@/actions/platform-danger'
import { isGlobalTenantResetAllowed } from '@/lib/global-tenant-reset'
import { CleanupClient } from './cleanup-client'

export const metadata: Metadata = { title: 'Danger Zone — Admin — ReservaNex' }

export default async function AdminCleanupPage() {
  await requireSuperAdmin()

  const [overviewRes, tenantsRes, sellersRes] = await Promise.all([
    getCleanupOverviewAction(),
    listTenantsForCleanupAction(),
    listSellersForCleanupAction(),
  ])

  const overview = overviewRes.success ? (overviewRes.data ?? null) : null
  const tenants  = tenantsRes.success  ? (tenantsRes.data ?? [])   : []
  const sellers  = sellersRes.success  ? (sellersRes.data ?? [])   : []

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30">
        <h1 className="text-lg font-bold text-red-700 dark:text-red-400">
          Danger Zone — Admin Cleanup
        </h1>
        <p className="mt-1 text-sm text-red-600 dark:text-red-500">
          Herramienta interna exclusiva de Super Admin. Todas las acciones son irreversibles.
          Usá únicamente para resetear entornos de QA.
        </p>
      </div>

      <CleanupClient
        overview={overview}
        tenants={tenants}
        sellers={sellers}
        globalResetAllowed={isGlobalTenantResetAllowed()}
      />
    </div>
  )
}

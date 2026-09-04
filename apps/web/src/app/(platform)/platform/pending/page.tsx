import type { Metadata } from 'next'
import Link from 'next/link'
import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import * as repo from '@/lib/repositories/platform.repository'
import { StatusBadge } from '@/components/platform/onboarding-badge'

export const metadata: Metadata = { title: 'Pendientes — ReservaNex' }

export default async function PendingTenantsPage() {
  await requireSuperAdmin()

  const all     = await repo.listAllTenants()
  const pending = all.filter((t) => t.onboarding_status === 'pending_review')

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Pendientes de aprobación</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{pending.length} inmobiliarias esperan revisión</p>
      </div>

      {pending.length === 0 ? (
        <div className="rounded-lg border bg-background py-12 text-center text-sm text-muted-foreground">
          No hay inmobiliarias pendientes. Todo al día.
        </div>
      ) : (
        <div className="space-y-2">
          {pending.map((t) => {
            const ageHours = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 36e5)
            const delayed  = ageHours > 72
            return (
              <div key={t.id} className={`flex items-center justify-between rounded-lg border bg-background p-4 ${delayed ? 'border-yellow-400/50' : ''}`}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    {delayed && (
                      <span className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                        {ageHours}h sin revisar
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Seller: {(t.seller as { name?: string } | null)?.name ?? 'Sin asignar'} ·{' '}
                    Owner: {t.primary_owner_email ?? '—'}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={t.onboarding_status} type="onboarding" />
                  <Link
                    href={`/platform/tenants/${t.id}`}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Revisar
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

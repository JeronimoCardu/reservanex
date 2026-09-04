import type { Metadata } from 'next'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import { redirect } from 'next/navigation'
import * as repo from '@/lib/repositories/platform.repository'
import { StatusBadge } from '@/components/platform/onboarding-badge'

export const metadata: Metadata = { title: 'Métricas — ReservaNex' }

export default async function MetricsPage() {
  const ctx = await requirePlatformContext()
  if (ctx.isSuperAdmin) redirect('/platform')

  const tenants = await repo.listSellerTenants(ctx.userId)

  const byStatus = tenants.reduce<Record<string, number>>((acc, t) => {
    acc[t.onboarding_status] = (acc[t.onboarding_status] ?? 0) + 1
    return acc
  }, {})

  const delayed = tenants.filter((t) => {
    if (['delivered', 'rejected'].includes(t.onboarding_status)) return false
    return (Date.now() - new Date(t.created_at).getTime()) / 36e5 > 72
  })

  const LABELS: Record<string, string> = {
    pending_review:   'Pendiente revisión',
    approved:         'Aprobadas',
    meta_setup:       'Config. Meta',
    testing:          'En pruebas',
    ready_to_deliver: 'Listas para entregar',
    delivered:        'Entregadas',
    rejected:         'Rechazadas',
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Mis métricas</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{tenants.length} inmobiliarias en tu cartera</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Object.entries(LABELS).map(([key, label]) => (
          <div key={key} className="rounded-lg border bg-background p-3">
            <div className="text-2xl font-bold tabular-nums">{byStatus[key] ?? 0}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>

      {delayed.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-yellow-700 dark:text-yellow-300">
            Demoradas (+72hs sin entregar)
          </h2>
          {delayed.map((t) => {
            const ageHours = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 36e5)
            return (
              <div key={t.id} className="flex items-center justify-between rounded-lg border border-yellow-300/60 bg-yellow-50/50 p-3 dark:bg-yellow-900/10">
                <div>
                  <span className="font-medium text-sm">{t.name}</span>
                  <div className="text-xs text-muted-foreground">{ageHours}h desde creación</div>
                </div>
                <StatusBadge status={t.onboarding_status} type="onboarding" />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

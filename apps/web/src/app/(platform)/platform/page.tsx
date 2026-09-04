import type { Metadata } from 'next'
import Link from 'next/link'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import * as repo from '@/lib/repositories/platform.repository'

export const metadata: Metadata = { title: 'Panel ReservaNex' }

export default async function PlatformDashboardPage() {
  const ctx = await requirePlatformContext()

  if (ctx.isSeller) {
    const tenants = await repo.listSellerTenants(ctx.userId)

    const pending  = tenants.filter((t) => t.onboarding_status === 'pending_review').length
    const inProg   = tenants.filter((t) => ['approved','meta_setup','testing'].includes(t.onboarding_status)).length
    const ready    = tenants.filter((t) => t.onboarding_status === 'ready_to_deliver').length
    const done     = tenants.filter((t) => t.onboarding_status === 'delivered').length
    const delayed  = tenants.filter((t) => {
      if (['delivered','rejected'].includes(t.onboarding_status)) return false
      return (Date.now() - new Date(t.created_at).getTime()) / 36e5 > 72
    }).length

    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Mis inmobiliarias</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Resumen de tu cartera de clientes</p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Total"          value={tenants.length} />
          <StatCard label="Pendiente"      value={pending}        />
          <StatCard label="En proceso"     value={inProg}         />
          <StatCard label="Lista entregar" value={ready}  highlight={ready > 0} />
          <StatCard label="Entregadas"     value={done}           />
        </div>

        {delayed > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-2.5 text-sm text-yellow-800 dark:border-yellow-700/50 dark:bg-yellow-900/20 dark:text-yellow-300">
            <span className="font-semibold">{delayed}</span> inmobiliaria{delayed > 1 ? 's' : ''} con más de 72 hs sin entregar.
          </div>
        )}

        <div className="flex gap-3">
          <Link
            href="/platform/tenants/new"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            + Nueva inmobiliaria
          </Link>
          <Link
            href="/platform/tenants"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Ver todas
          </Link>
        </div>
      </div>
    )
  }

  // Super Admin
  const stats = await repo.getPlatformStats()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Resumen de plataforma</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Vista global de ReservaNex</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Sellers"          value={stats.totalSellers}   />
        <StatCard label="Inmobiliarias"    value={stats.totalTenants}   />
        <StatCard label="Pendientes"       value={stats.pendingReview}  highlight={stats.pendingReview > 0} />
        <StatCard label="Para entregar"    value={stats.readyToDeliver} highlight={stats.readyToDeliver > 0} />
        <StatCard label="Entregadas"       value={stats.delivered}      />
        <StatCard label="Activas/Trial"    value={stats.activeOrTrial}  />
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/platform/tenants"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Ver inmobiliarias
        </Link>
        <Link
          href="/platform/pending"
          className="rounded-md border border-yellow-400 bg-yellow-50 px-4 py-2 text-sm font-medium text-yellow-800 hover:bg-yellow-100 dark:bg-yellow-900/20 dark:text-yellow-300"
        >
          Pendientes de aprobación
        </Link>
        <Link
          href="/platform/sellers"
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Gestionar sellers
        </Link>
      </div>
    </div>
  )
}

function StatCard({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border bg-background p-4 ${highlight ? 'border-primary/40' : ''}`}>
      <div className={`text-2xl font-bold tabular-nums ${highlight ? 'text-primary' : ''}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

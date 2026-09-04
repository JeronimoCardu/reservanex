import type { Metadata } from 'next'
import { requireOperator } from '@/lib/auth/require-platform-context'
import * as repo from '@/lib/repositories/platform.repository'
import { SetupAssignmentCards } from './setup-assignment-cards'

export const metadata: Metadata = { title: 'Setup — ReservaNex' }

export default async function SetupPage() {
  const ctx = await requireOperator()

  const assignments = await repo.listSetupAssignmentsByOperator(ctx.userId)

  const active    = assignments.filter((a) => a.status === 'active')
  const completed = assignments.filter((a) => a.status !== 'active')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Mis tenants de setup</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tenants asignados para configuración. Solo ves los tuyos.
        </p>
      </div>

      {active.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No tenés tenants activos asignados.</p>
        </div>
      )}

      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Activos</h2>
          <SetupAssignmentCards assignments={active} />
        </section>
      )}

      {completed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Historial</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {completed.map((a) => {
              const tenant = a.tenant as { name?: string; slug?: string; plan_label?: string | null } | null
              return (
                <div key={a.id} className="rounded-lg border bg-background p-4 opacity-60 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{tenant?.name ?? '—'}</span>
                    <span className="text-xs rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                      {a.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{tenant?.plan_label ?? '—'}</p>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

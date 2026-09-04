'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { completeSetupAssignmentAction, startSetupImpersonationAction } from '@/actions/platform'
import type { SetupAssignmentWithRelations } from '@/lib/repositories/platform.repository'

interface Props {
  assignments: SetupAssignmentWithRelations[]
}

export function SetupAssignmentCards({ assignments }: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {assignments.map((a) => (
        <SetupCard key={a.id} assignment={a} />
      ))}
    </div>
  )
}

function SetupCard({ assignment }: { assignment: SetupAssignmentWithRelations }) {
  const router                = useRouter()
  const [isPending, startTx]  = useTransition()

  const tenant     = assignment.tenant as { name?: string; slug?: string; plan_label?: string | null; setup_status?: string | null; onboarding_status?: string | null; status?: string | null } | null
  const tenantName = tenant?.name ?? '—'
  const planLabel  = tenant?.plan_label ?? '—'
  const slug       = tenant?.slug ?? ''

  const SETUP_DONE_ONBOARDING = new Set(['ready_to_deliver', 'delivered'])
  const isDelivered =
    (tenant?.onboarding_status != null && SETUP_DONE_ONBOARDING.has(tenant.onboarding_status)) ||
    tenant?.status === 'active'

  function handleEnterCRM() {
    startTx(async () => {
      const res = await startSetupImpersonationAction(assignment.tenant_id)
      if (res.success) {
        router.push('/dashboard/properties')
      } else {
        toast.error(res.error)
      }
    })
  }

  function handleComplete() {
    startTx(async () => {
      const res = await completeSetupAssignmentAction(assignment.id)
      if (res.success) {
        toast.success('Setup marcado como completado. Quedará en revisión del super admin.')
        router.refresh()
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className="rounded-lg border bg-background p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">{tenantName}</p>
          <p className="text-xs text-muted-foreground">{planLabel}</p>
          {slug && (
            <p className="text-xs text-muted-foreground mt-0.5">slug: {slug}</p>
          )}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
          isDelivered
            ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
            : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
        }`}>
          {isDelivered ? 'Acceso finalizado' : 'Activo'}
        </span>
      </div>

      <div className="text-xs text-muted-foreground space-y-0.5">
        <p>Asignado: {new Date(assignment.assigned_at).toLocaleDateString('es-AR')}</p>
        {assignment.notes && <p className="italic">{assignment.notes}</p>}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-1">
        {isDelivered ? (
          <p className="text-xs text-muted-foreground italic">
            Este tenant ya fue entregado. El acceso de setup ya no está disponible.
          </p>
        ) : (
          <>
            <button
              disabled={isPending}
              onClick={handleEnterCRM}
              className="rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400 dark:hover:bg-blue-950/50"
            >
              {isPending ? 'Entrando…' : 'Entrar al CRM'}
            </button>

            <button
              disabled={isPending}
              onClick={handleComplete}
              className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400"
            >
              {isPending ? 'Guardando...' : 'Marcar setup completado'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

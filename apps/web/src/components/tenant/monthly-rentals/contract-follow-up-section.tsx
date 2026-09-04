'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { PlusIcon, CheckCircleIcon, ClockIcon, XCircleIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FollowUpTaskDialog } from './follow-up-task-dialog'
import { updateTaskStatusAction } from '@/actions/tasks'
import type { MonthlyRentalFollowUpTask } from '@/lib/repositories/monthly-rentals.repository'

interface Props {
  contractId: string
  tasks:      MonthlyRentalFollowUpTask[]
  isOwner:    boolean
}

const PRIORITY_LABELS: Record<string, string> = {
  low:    'Baja',
  medium: 'Media',
  high:   'Alta',
}

const PRIORITY_CLASS: Record<string, string> = {
  low:    'text-muted-foreground',
  medium: 'text-blue-600 dark:text-blue-400',
  high:   'text-orange-600 dark:text-orange-400',
}

// Handles both "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS+TZ" safely
function formatDateOnly(d: string | null | undefined): string | null {
  if (!d) return null
  const part = d.slice(0, 10)
  const [y, m, day] = part.split('-')
  if (!y || !m || !day) return d
  return `${day}/${m}/${y}`
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircleIcon className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
  if (status === 'cancelled') return <XCircleIcon     className="h-3.5 w-3.5 text-muted-foreground" />
  return <ClockIcon className="h-3.5 w-3.5 text-muted-foreground" />
}

export function ContractFollowUpSection({ contractId, tasks, isOwner }: Props) {
  const router = useRouter()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isPending, startTrans] = useTransition()

  function handleComplete(taskId: string) {
    startTrans(async () => {
      const result = await updateTaskStatusAction(taskId, { status: 'completed' })
      if (result.success) {
        router.refresh()
      } else {
        toast.error(result.error ?? 'Error al completar la tarea.')
      }
    })
  }

  const today = new Date().toISOString().slice(0, 10)

  const open      = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
  const completed = tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled')

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Seguimiento
        </p>
        {isOwner && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-7 text-xs"
            onClick={() => setDialogOpen(true)}
          >
            <PlusIcon className="h-3 w-3" />
            Nueva tarea
          </Button>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <ClockIcon className="mx-auto mb-2 h-6 w-6 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">No hay tareas de seguimiento.</p>
          {isOwner && (
            <Button size="sm" variant="outline" className="mt-2 text-xs" onClick={() => setDialogOpen(true)}>
              Crear tarea
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden divide-y">
          {open.map((t) => {
            const dueDatePart = t.due_date ? t.due_date.slice(0, 10) : null
            const isOverdue   = dueDatePart && dueDatePart < today
            const formatted   = formatDateOnly(t.due_date)
            return (
              <div key={t.id} className="px-4 py-3 flex items-start gap-3">
                <StatusIcon status={t.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium line-clamp-1">{t.title}</p>
                  {t.description && (
                    <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{t.description}</p>
                  )}
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap text-[10px]">
                    {formatted && (
                      <span className={isOverdue ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                        {isOverdue ? '⚠ ' : ''}Vence {formatted}
                      </span>
                    )}
                    {formatted && (
                      <span className="text-muted-foreground/40">·</span>
                    )}
                    <span className={PRIORITY_CLASS[t.priority] ?? 'text-muted-foreground'}>
                      {PRIORITY_LABELS[t.priority] ?? t.priority}
                    </span>
                  </div>
                </div>
                {isOwner && t.status === 'pending' && (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => handleComplete(t.id)}
                    className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Completar
                  </button>
                )}
              </div>
            )
          })}
          {completed.length > 0 && (
            <details className="group">
              <summary className="px-4 py-2 text-[10px] text-muted-foreground cursor-pointer select-none hover:text-foreground">
                {completed.length} tarea{completed.length !== 1 ? 's' : ''} completada{completed.length !== 1 ? 's' : ''}
              </summary>
              {completed.map((t) => (
                <div key={t.id} className="px-4 py-2.5 flex items-center gap-3 bg-muted/20 opacity-60">
                  <StatusIcon status={t.status} />
                  <p className="text-xs line-through line-clamp-1">{t.title}</p>
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      {isOwner && (
        <FollowUpTaskDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          contractId={contractId}
          existingTasks={tasks}
        />
      )}
    </section>
  )
}

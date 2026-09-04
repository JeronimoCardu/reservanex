import { cn } from '@/lib/utils'

const CONFIG: Record<string, { label: string; className: string }> = {
  pending:        { label: 'Pendiente',     className: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700' },
  overdue:        { label: 'Vencida',       className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900' },
  partially_paid: { label: 'Pago parcial',  className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-500 dark:border-amber-900' },
  paid:           { label: 'Pagada',        className: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900' },
  cancelled:      { label: 'Cancelada',     className: 'bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-900/40 dark:text-gray-500 dark:border-gray-800' },
}

interface Props {
  status:         string
  dueDate?:       string  // if provided, compute visual overdue from date too
  forceOverdue?:  boolean // explicit override
}

export function ChargeStatusBadge({ status, dueDate, forceOverdue }: Props) {
  // Visual override: if due_date is past and not paid/cancelled → show as overdue
  const today = new Date().toISOString().split('T')[0]!
  const isVisuallyOverdue =
    forceOverdue ??
    (dueDate !== undefined && dueDate < today && status !== 'paid' && status !== 'cancelled')

  const effectiveStatus = isVisuallyOverdue && status !== 'overdue' ? 'overdue' : status
  const c = CONFIG[effectiveStatus] ?? { label: effectiveStatus, className: 'bg-muted text-muted-foreground border-border' }

  return (
    <span className={cn(
      'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap',
      c.className,
    )}>
      {c.label}
    </span>
  )
}

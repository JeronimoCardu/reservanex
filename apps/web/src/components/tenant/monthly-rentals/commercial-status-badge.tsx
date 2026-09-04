import { cn } from '@/lib/utils'

const CONFIG: Record<string, { label: string; className: string }> = {
  available: { label: 'Disponible', className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900' },
  rented:    { label: 'Alquilada',  className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-500 dark:border-amber-900' },
  paused:    { label: 'Pausada',    className: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700' },
  sold:      { label: 'Vendida',    className: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-400 dark:border-violet-900' },
}

export function CommercialStatusBadge({ status }: { status: string }) {
  const c = CONFIG[status] ?? { label: status, className: 'bg-muted text-muted-foreground border-border' }
  return (
    <span className={cn(
      'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap',
      c.className,
    )}>
      {c.label}
    </span>
  )
}

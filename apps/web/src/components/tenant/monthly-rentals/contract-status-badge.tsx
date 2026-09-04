import { cn } from '@/lib/utils'

const CONFIG: Record<string, { label: string; className: string }> = {
  draft:     { label: 'Borrador', className: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700' },
  active:    { label: 'Activo',   className: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900' },
  ended:     { label: 'Finalizado', className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900' },
  cancelled: { label: 'Cancelado',  className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900' },
}

export function ContractStatusBadge({ status }: { status: string }) {
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

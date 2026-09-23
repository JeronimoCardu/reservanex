import type { ReservationStatus } from '@orderflow/types'
import { cn } from '@/lib/utils'

type StatusMeta = { label: string; className: string }

const statusConfig: Record<ReservationStatus, StatusMeta> = {
  inquiry:         { label: 'Consulta',        className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' },
  interested:      { label: 'Interesado',      className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-800' },
  pre_reserved:    { label: 'Pendiente',       className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-400 dark:border-amber-800' },
  pending_payment: { label: 'Pago pendiente',  className: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/60 dark:text-orange-400 dark:border-orange-800' },
  confirmed:       { label: 'Confirmada',      className: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/60 dark:text-green-400 dark:border-green-800' },
  cancelled:       { label: 'Cancelada',       className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/60 dark:text-red-400 dark:border-red-800' },
  completed:       { label: 'Completada',      className: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-400 dark:border-purple-800' },
}

const derivedMeta: Record<string, StatusMeta> = {
  expired_pending: { label: 'Pendiente vencida', className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/60 dark:text-red-400 dark:border-red-800' },
  past_confirmed:  { label: 'Finalizada',         className: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/60 dark:text-teal-400 dark:border-teal-800' },
}

interface ReservationStatusBadgeProps {
  status:          ReservationStatus
  expired?:        boolean  // pre_reserved + expires_at expired
  pastConfirmed?:  boolean  // confirmed + end_date <= today (not yet completed)
  className?:      string
}

export function ReservationStatusBadge({
  status,
  expired,
  pastConfirmed,
  className,
}: ReservationStatusBadgeProps) {
  let meta: StatusMeta

  if (status === 'pre_reserved' && expired) {
    meta = derivedMeta.expired_pending!
  } else if (status === 'confirmed' && pastConfirmed) {
    meta = derivedMeta.past_confirmed!
  } else {
    meta = statusConfig[status] ?? statusConfig.inquiry
  }

  return (
    <span className={cn(
      'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap',
      meta.className,
      className,
    )}>
      {meta.label}
    </span>
  )
}

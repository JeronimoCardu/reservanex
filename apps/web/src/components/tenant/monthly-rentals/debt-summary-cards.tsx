import { AlertCircleIcon, ClockIcon, CalendarIcon, BanknoteIcon } from 'lucide-react'
import type { MonthlyRentalDebtSummary } from '@/lib/repositories/monthly-rentals.repository'

interface Props {
  summary:  MonthlyRentalDebtSummary
  currency: string
}

function fmtAmount(n: number, currency: string) {
  return `${n.toLocaleString('es-AR')} ${currency}`
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

function Card({
  label, value, sub, icon: Icon, alert = false,
}: {
  label: string; value: string; sub?: string
  icon: React.ElementType; alert?: boolean
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className={`h-4 w-4 ${alert ? 'text-destructive/60' : 'text-muted-foreground/50'}`} />
      </div>
      <p className={`text-xl font-bold tabular-nums leading-tight ${alert ? 'text-destructive' : ''}`}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground/60 mt-0.5">{sub}</p>}
    </div>
  )
}

export function DebtSummaryCards({ summary, currency }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card
        label="Deuda total"
        value={fmtAmount(summary.totalDebt, currency)}
        sub={`${summary.overdueCount + summary.pendingCount} cuota${summary.overdueCount + summary.pendingCount !== 1 ? 's' : ''}`}
        icon={BanknoteIcon}
        alert={summary.totalDebt > 0}
      />
      <Card
        label="Deuda vencida"
        value={fmtAmount(summary.overdueDebt, currency)}
        sub={summary.overdueCount > 0 ? `${summary.overdueCount} vencida${summary.overdueCount !== 1 ? 's' : ''}` : 'Sin vencidas'}
        icon={AlertCircleIcon}
        alert={summary.overdueCount > 0}
      />
      <Card
        label="Próximo vencimiento"
        value={fmtDate(summary.nextDueDate)}
        sub={summary.nextDueAmount !== null ? fmtAmount(summary.nextDueAmount, currency) : undefined}
        icon={CalendarIcon}
      />
      <Card
        label="Cuotas pendientes"
        value={String(summary.pendingCount)}
        sub={summary.cancelledCount > 0 ? `${summary.cancelledCount} cancelada${summary.cancelledCount !== 1 ? 's' : ''}` : undefined}
        icon={ClockIcon}
      />
    </div>
  )
}

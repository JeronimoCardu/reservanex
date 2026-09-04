'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangleIcon, CalendarClockIcon, ClockIcon, ChevronDownIcon, ChevronUpIcon,
} from 'lucide-react'
import type {
  MonthlyRentalAlertCharge,
  MonthlyRentalAlertContract,
} from '@/lib/repositories/monthly-rentals.repository'

interface Props {
  overdueCharges:   MonthlyRentalAlertCharge[]
  upcomingCharges:  MonthlyRentalAlertCharge[]
  endingContracts:  MonthlyRentalAlertContract[]
  expiredContracts: MonthlyRentalAlertContract[]
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  const part = d.slice(0, 10)
  const [y, m, day] = part.split('-')
  if (!y || !m || !day) return d
  return `${day}/${m}/${y}`
}

function fmtAmount(n: number, paid: number) {
  const saldo = n - paid
  return saldo.toLocaleString('es-AR')
}

function ChargeRow({ item }: { item: MonthlyRentalAlertCharge }) {
  return (
    <Link
      href={`/dashboard/monthly-rentals/${item.contract_id}`}
      className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors rounded-md"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium line-clamp-1">{item.property_title ?? '—'}</p>
        <p className="text-[11px] text-muted-foreground line-clamp-1">
          {item.contact_name ?? '—'} · {item.period_month}/{item.period_year}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs font-semibold tabular-nums">${fmtAmount(item.total_amount, item.amount_paid)}</p>
        <p className="text-[11px] text-muted-foreground">vence {fmtDate(item.due_date)}</p>
      </div>
    </Link>
  )
}

function ContractRow({ item }: { item: MonthlyRentalAlertContract }) {
  return (
    <Link
      href={`/dashboard/monthly-rentals/${item.id}`}
      className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors rounded-md"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium line-clamp-1">{item.property_title ?? '—'}</p>
        <p className="text-[11px] text-muted-foreground line-clamp-1">{item.contact_name ?? '—'}</p>
      </div>
      <p className="text-[11px] text-muted-foreground shrink-0">{fmtDate(item.end_date)}</p>
    </Link>
  )
}

interface SectionProps {
  title:     string
  count:     number
  icon:      React.ElementType
  iconClass: string
  children:  React.ReactNode
}

function AlertSection({ title, count, icon: Icon, iconClass, children }: SectionProps) {
  const [open, setOpen] = useState(true)
  if (count === 0) return null
  return (
    <div className="rounded-lg border overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Icon className={`h-3.5 w-3.5 ${iconClass}`} />
          <span className="text-xs font-semibold">{title}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
            {count}
          </span>
        </div>
        {open
          ? <ChevronUpIcon   className="h-3.5 w-3.5 text-muted-foreground" />
          : <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
        }
      </button>
      {open && <div className="divide-y px-1 py-1">{children}</div>}
    </div>
  )
}

export function RentalAlertsPanel({
  overdueCharges, upcomingCharges, endingContracts, expiredContracts,
}: Props) {
  const total = overdueCharges.length + upcomingCharges.length + endingContracts.length + expiredContracts.length
  if (total === 0) return null

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Alertas
      </p>

      <AlertSection
        title="Cuotas vencidas"
        count={overdueCharges.length}
        icon={AlertTriangleIcon}
        iconClass="text-destructive/70"
      >
        {overdueCharges.map((c) => <ChargeRow key={c.id} item={c} />)}
      </AlertSection>

      <AlertSection
        title="Cuotas próximas (5 días)"
        count={upcomingCharges.length}
        icon={CalendarClockIcon}
        iconClass="text-orange-500/80"
      >
        {upcomingCharges.map((c) => <ChargeRow key={c.id} item={c} />)}
      </AlertSection>

      <AlertSection
        title="Contratos vencidos activos"
        count={expiredContracts.length}
        icon={AlertTriangleIcon}
        iconClass="text-destructive/70"
      >
        {expiredContracts.map((c) => <ContractRow key={c.id} item={c} />)}
      </AlertSection>

      <AlertSection
        title="Por vencer (30 días)"
        count={endingContracts.length}
        icon={ClockIcon}
        iconClass="text-muted-foreground"
      >
        {endingContracts.map((c) => <ContractRow key={c.id} item={c} />)}
      </AlertSection>
    </div>
  )
}

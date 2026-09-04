'use client'

import { PencilIcon, XCircleIcon, PlusIcon, BanknoteIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChargeStatusBadge } from './charge-status-badge'
import type { MonthlyRentalChargeRow } from '@orderflow/types'

interface Props {
  charges:         MonthlyRentalChargeRow[]
  currency:        string
  isOwner:         boolean
  onEdit:          (charge: MonthlyRentalChargeRow) => void
  onCancelRequest: (chargeId: string) => void
  onPayRequest:    (charge: MonthlyRentalChargeRow) => void
  onNew:           () => void
}

const MONTH_ABBR = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']

function fmt(n: number | null | undefined) {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('es-AR')
}

function fmtDate(d: string) {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

function periodLabel(year: number, month: number) {
  return `${MONTH_ABBR[month - 1]} ${year}`
}

export function ChargesTable({ charges, currency, isOwner, onEdit, onCancelRequest, onPayRequest, onNew }: Props) {
  if (charges.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm font-medium">Sin cuotas</p>
        <p className="text-xs text-muted-foreground mt-1">Este contrato aún no tiene cuotas generadas.</p>
        {isOwner && (
          <Button size="sm" variant="outline" className="mt-4 gap-1.5" onClick={onNew}>
            <PlusIcon className="h-3.5 w-3.5" />
            Nueva cuota
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b">
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Período</th>
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Vencimiento</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Alquiler</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Expensas</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Servicios</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Ajustes</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Mora</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Total</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Pagado</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Saldo</th>
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Estado</th>
            {isOwner && <th className="py-2" />}
          </tr>
        </thead>
        <tbody className="divide-y">
          {charges.map((ch) => {
            const saldo = ch.total_amount - (ch.amount_paid ?? 0)
            const isCancelled = ch.status === 'cancelled'
            const isPaid      = ch.status === 'paid'
            const canPay      = isOwner && !isCancelled && !isPaid && saldo > 0
            return (
              <tr key={ch.id} className={`hover:bg-muted/30 transition-colors ${isCancelled ? 'opacity-50' : ''}`}>
                <td className="py-2 pr-3 whitespace-nowrap font-medium">
                  {periodLabel(ch.period_year, ch.period_month)}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                  {fmtDate(ch.due_date)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmt(ch.rent_amount)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{fmt(ch.expenses_amount)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{fmt(ch.services_amount)}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${ch.adjustments_amount > 0 ? 'text-sky-600 dark:text-sky-400 font-medium' : 'text-muted-foreground'}`}>{fmt(ch.adjustments_amount)}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${ch.late_fee_amount > 0 ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-muted-foreground'}`}>{fmt(ch.late_fee_amount)}</td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium">{fmt(ch.total_amount)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-green-600 dark:text-green-400">
                  {fmt(ch.amount_paid)}
                </td>
                <td className={`py-2 pr-3 text-right tabular-nums font-medium ${saldo > 0 && !isCancelled ? 'text-destructive' : ''}`}>
                  {isCancelled ? '—' : fmt(saldo)}
                </td>
                <td className="py-2 pr-3">
                  <ChargeStatusBadge status={ch.status} dueDate={ch.due_date} />
                </td>
                {isOwner && (
                  <td className="py-2 pl-2">
                    <div className="flex items-center gap-1 justify-end">
                      {canPay && (
                        <Button
                          variant="ghost" size="icon"
                          className="h-6 w-6 text-green-600 dark:text-green-400 hover:text-green-700"
                          title="Registrar pago"
                          onClick={() => onPayRequest(ch)}
                        >
                          <BanknoteIcon className="h-3 w-3" />
                        </Button>
                      )}
                      {!isCancelled && (
                        <Button
                          variant="ghost" size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-foreground"
                          title={isPaid ? 'Editar cuota (ej. agregar mora)' : 'Editar cuota'}
                          onClick={() => onEdit(ch)}
                        >
                          <PencilIcon className="h-3 w-3" />
                        </Button>
                      )}
                      {!isCancelled && !isPaid && (
                        <Button
                          variant="ghost" size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          title="Cancelar cuota"
                          onClick={() => onCancelRequest(ch.id)}
                        >
                          <XCircleIcon className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/20">
            <td colSpan={7} className="py-2 pr-3 text-xs text-muted-foreground font-medium">
              {charges.length} cuota{charges.length !== 1 ? 's' : ''} · {currency}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums font-bold text-xs">
              {fmt(charges.filter(c => c.status !== 'cancelled').reduce((s, c) => s + c.total_amount, 0))}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums font-bold text-xs text-green-600 dark:text-green-400">
              {fmt(charges.reduce((s, c) => s + (c.amount_paid ?? 0), 0))}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums font-bold text-xs text-destructive">
              {fmt(charges.filter(c => c.status !== 'cancelled').reduce((s, c) => s + (c.total_amount - (c.amount_paid ?? 0)), 0))}
            </td>
            <td colSpan={isOwner ? 2 : 1} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

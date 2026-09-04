'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button }   from '@/components/ui/button'
import { Input }    from '@/components/ui/input'
import { Label }    from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { recordMonthlyRentalPaymentAction } from '@/actions/monthly-rentals'
import type { MonthlyRentalChargeRow } from '@orderflow/types'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  open:     boolean
  onClose:  () => void
  charge:   MonthlyRentalChargeRow
  currency: string
}

const PAYMENT_METHODS = [
  { value: 'transfer', label: 'Transferencia' },
  { value: 'cash',     label: 'Efectivo' },
  { value: 'check',    label: 'Cheque' },
  { value: 'card',     label: 'Tarjeta' },
  { value: 'other',    label: 'Otro' },
] as const

const MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

function todayDate() {
  return new Date().toISOString().split('T')[0]!
}

function fmt(n: number) {
  return n.toLocaleString('es-AR')
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PaymentFormDialog({ open, onClose, charge, currency }: Props) {
  const [isPending, startTrans] = useTransition()
  const saldo = charge.total_amount - (charge.amount_paid ?? 0)

  const [amount,        setAmount]        = useState(String(saldo))
  const [paidAt,        setPaidAt]        = useState(todayDate)
  const [paymentMethod, setPaymentMethod] = useState<typeof PAYMENT_METHODS[number]['value']>('transfer')
  const [notes,         setNotes]         = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const amountNum = Number(amount)
    if (!amountNum || amountNum <= 0) {
      toast.error('El monto debe ser mayor a 0.')
      return
    }
    if (amountNum > saldo) {
      toast.error(`El monto no puede superar el saldo pendiente (${fmt(saldo)} ${currency}).`)
      return
    }
    startTrans(async () => {
      const result = await recordMonthlyRentalPaymentAction(charge.id, {
        amount:        amountNum,
        paidAt,
        paymentMethod,
        notes:         notes || null,
      })
      if (result.success) {
        toast.success('Pago registrado.')
        onClose()
      } else {
        toast.error(result.error ?? 'Error al registrar el pago.')
      }
    })
  }

  const period = `${MONTH_NAMES[charge.period_month - 1]} ${charge.period_year}`

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="text-sm">Registrar pago — {period}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col">
          <div className="px-6 py-5 space-y-4">

            {/* Resumen de saldo */}
            <div className="rounded-lg border bg-muted/30 px-4 py-3 flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-[11px] text-muted-foreground">Total cuota</p>
                <p className="text-xs font-semibold tabular-nums">{fmt(charge.total_amount)} {currency}</p>
              </div>
              <div className="space-y-0.5 text-right">
                <p className="text-[11px] text-muted-foreground">Ya pagado</p>
                <p className="text-xs tabular-nums text-green-600 dark:text-green-400">{fmt(charge.amount_paid ?? 0)} {currency}</p>
              </div>
              <div className="space-y-0.5 text-right">
                <p className="text-[11px] text-muted-foreground">Saldo pendiente</p>
                <p className="text-xs font-bold tabular-nums text-destructive">{fmt(saldo)} {currency}</p>
              </div>
            </div>

            {/* Monto */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-amount" className="text-xs">
                Monto a registrar ({currency}) <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pf-amount"
                type="number" min="0.01" max={saldo} step="0.01"
                value={amount} onChange={(e) => setAmount(e.target.value)}
                className="h-8 text-xs" required disabled={isPending}
              />
              <p className="text-[10px] text-muted-foreground">Máximo: {fmt(saldo)} {currency}</p>
            </div>

            {/* Fecha */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-date" className="text-xs">Fecha de pago <span className="text-destructive">*</span></Label>
              <Input
                id="pf-date"
                type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)}
                className="h-8 text-xs" required disabled={isPending}
              />
            </div>

            {/* Método */}
            <div className="space-y-1.5">
              <Label className="text-xs">Método de pago <span className="text-destructive">*</span></Label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as typeof PAYMENT_METHODS[number]['value'])}
                disabled={isPending}
                className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            {/* Notas */}
            <div className="space-y-1.5">
              <Label className="text-xs">Notas</Label>
              <Textarea
                value={notes} onChange={(e) => setNotes(e.target.value)}
                rows={2} maxLength={2000} disabled={isPending}
                className="text-xs resize-none" placeholder="Referencia, número de comprobante, etc."
              />
            </div>
          </div>

          <DialogFooter className="px-6 py-4 border-t gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? 'Registrando…' : 'Registrar pago'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

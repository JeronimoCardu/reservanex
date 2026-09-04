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
import {
  createMonthlyRentalChargeAction,
  updateMonthlyRentalChargeAction,
} from '@/actions/monthly-rentals'
import type { MonthlyRentalChargeRow, MonthlyRentalContractRow } from '@orderflow/types'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  open:       boolean
  onClose:    () => void
  contract:   Pick<MonthlyRentalContractRow, 'id' | 'rent_amount' | 'expenses_amount' | 'due_day' | 'currency'>
  charge?:    MonthlyRentalChargeRow  // present = edit mode
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(n: number | null | undefined) {
  return n !== null && n !== undefined ? String(n) : '0'
}

// Calculates due date for a given period + contract due_day (clamped to last day of month)
function calcDueDate(year: number, month: number, dueDay: number): string {
  const lastDay = new Date(year, month, 0).getDate()  // day=0 of next month = last day of this month
  const day     = Math.min(dueDay, lastDay)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ChargeFormDialog({ open, onClose, contract, charge }: Props) {
  const isEdit = Boolean(charge)
  const [isPending, startTrans] = useTransition()

  const now = new Date()

  // Initial period: from charge if editing, otherwise current month/year
  const initYear  = charge ? charge.period_year  : now.getFullYear()
  const initMonth = charge ? charge.period_month : now.getMonth() + 1

  const [periodYear,        setPeriodYear]        = useState(String(initYear))
  const [periodMonth,       setPeriodMonth]       = useState(String(initMonth))
  const [dueDate,           setDueDate]           = useState(
    charge?.due_date ?? calcDueDate(initYear, initMonth, contract.due_day),
  )
  const [rentAmount,        setRentAmount]        = useState(charge ? str(charge.rent_amount)        : str(contract.rent_amount))
  const [expensesAmount,    setExpensesAmount]    = useState(charge ? str(charge.expenses_amount)    : str(contract.expenses_amount))
  const [servicesAmount,    setServicesAmount]    = useState(str(charge?.services_amount))
  const [adjustmentsAmount, setAdjustmentsAmount] = useState(str(charge?.adjustments_amount))
  const [lateFeeAmount,     setLateFeeAmount]     = useState(str(charge?.late_fee_amount))
  const [notes,             setNotes]             = useState(charge?.notes ?? '')

  const amountPaid = charge?.amount_paid ?? 0

  const total =
    (Number(rentAmount)        || 0) +
    (Number(expensesAmount)    || 0) +
    (Number(servicesAmount)    || 0) +
    (Number(adjustmentsAmount) || 0) +
    (Number(lateFeeAmount)     || 0)

  const newBalance = total - amountPaid

  // When period changes in create mode, recalculate due_date from period + contract.due_day
  function handleMonthChange(v: string) {
    setPeriodMonth(v)
    if (!isEdit) {
      setDueDate(calcDueDate(Number(periodYear), Number(v), contract.due_day))
    }
  }

  function handleYearChange(v: string) {
    setPeriodYear(v)
    const yr = Number(v)
    if (!isEdit && v.length === 4 && yr >= 2000 && yr <= 2100) {
      setDueDate(calcDueDate(yr, Number(periodMonth), contract.due_day))
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isEdit && total < amountPaid) {
      toast.error('El total no puede ser menor a lo ya pagado.')
      return
    }
    const payload = {
      periodYear:        Number(periodYear),
      periodMonth:       Number(periodMonth),
      dueDate,
      rentAmount:        Number(rentAmount)        || 0,
      expensesAmount:    Number(expensesAmount)    || 0,
      servicesAmount:    Number(servicesAmount)    || 0,
      adjustmentsAmount: Number(adjustmentsAmount) || 0,
      lateFeeAmount:     Number(lateFeeAmount)     || 0,
      notes:             notes || null,
    }

    startTrans(async () => {
      if (isEdit && charge) {
        const result = await updateMonthlyRentalChargeAction(charge.id, payload)
        if (result.success) { toast.success('Cuota actualizada.'); onClose() }
        else                { toast.error(result.error ?? 'Error al actualizar.') }
      } else {
        const result = await createMonthlyRentalChargeAction(contract.id, payload)
        if (result.success) { toast.success('Cuota creada.'); onClose() }
        else                { toast.error(result.error ?? 'Error al crear la cuota.') }
      }
    })
  }

  const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="text-sm">
            {isEdit ? 'Editar cuota' : 'Nueva cuota'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

            {/* Período */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Período</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Mes <span className="text-destructive">*</span></Label>
                  <select
                    value={periodMonth}
                    onChange={(e) => handleMonthChange(e.target.value)}
                    disabled={isPending}
                    className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {monthNames.map((name, i) => (
                      <option key={i + 1} value={String(i + 1)}>{name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Año <span className="text-destructive">*</span></Label>
                  <Input
                    type="number" min="2000" max="2100" value={periodYear}
                    onChange={(e) => handleYearChange(e.target.value)}
                    className="h-8 text-xs" required disabled={isPending}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Fecha de vencimiento <span className="text-destructive">*</span></Label>
                <Input
                  type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
                  className="h-8 text-xs" required disabled={isPending}
                />
              </div>
            </section>

            {/* Montos */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Montos ({contract.currency})</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cf-rent" className="text-xs">Alquiler <span className="text-destructive">*</span></Label>
                  <Input id="cf-rent" type="number" min="0" step="0.01" value={rentAmount}
                    onChange={(e) => setRentAmount(e.target.value)} className="h-8 text-xs" required disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Expensas</Label>
                  <Input type="number" min="0" step="0.01" value={expensesAmount}
                    onChange={(e) => setExpensesAmount(e.target.value)} className="h-8 text-xs" disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Servicios</Label>
                  <Input type="number" min="0" step="0.01" value={servicesAmount}
                    onChange={(e) => setServicesAmount(e.target.value)} className="h-8 text-xs" disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Ajustes</Label>
                  <Input type="number" min="0" step="0.01" value={adjustmentsAmount}
                    onChange={(e) => setAdjustmentsAmount(e.target.value)} className="h-8 text-xs" disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Mora</Label>
                  <Input type="number" min="0" step="0.01" value={lateFeeAmount}
                    onChange={(e) => setLateFeeAmount(e.target.value)} className="h-8 text-xs" disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Total (calculado)</Label>
                  <div className="flex h-8 items-center rounded-md border bg-muted px-3 text-xs font-semibold tabular-nums">
                    {total.toLocaleString('es-AR')} {contract.currency}
                  </div>
                </div>
              </div>
            </section>

            {/* Edit-mode context: warnings + preview */}
            {isEdit && (
              <>
                {charge?.status === 'paid' && amountPaid > 0 && total <= amountPaid && (
                  <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
                    La cuota está marcada como pagada. El total nuevo es igual o menor a lo pagado — el estado no cambiará.
                  </div>
                )}
                {charge?.status === 'paid' && total > amountPaid && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                    La cuota está pagada. Si el total nuevo supera lo pagado, pasará a <strong>pago parcial</strong>.
                  </div>
                )}
                {charge?.status !== 'paid' && amountPaid > 0 && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                    Esta cuota tiene <strong>{amountPaid.toLocaleString('es-AR')} {contract.currency}</strong> ya pagados. No podés bajar el total por debajo de ese importe.
                  </div>
                )}
                {amountPaid > 0 && (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-1">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Resumen</p>
                    <div className="grid grid-cols-3 gap-2 text-xs tabular-nums">
                      <div>
                        <p className="text-[10px] text-muted-foreground">Total anterior</p>
                        <p className="font-medium">{(charge?.total_amount ?? 0).toLocaleString('es-AR')}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Pagado</p>
                        <p className="font-medium text-green-600 dark:text-green-400">{amountPaid.toLocaleString('es-AR')}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Saldo nuevo</p>
                        <p className={`font-semibold ${newBalance > 0 ? 'text-destructive' : 'text-green-600 dark:text-green-400'}`}>
                          {newBalance.toLocaleString('es-AR')}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Notas */}
            <section className="space-y-1.5">
              <Label className="text-xs">Notas</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                rows={2} maxLength={2000} disabled={isPending}
                className="text-xs resize-none" placeholder="Observaciones de esta cuota..." />
            </section>
          </div>

          <DialogFooter className="px-6 py-4 border-t gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? (isEdit ? 'Guardando…' : 'Creando…') : isEdit ? 'Guardar cambios' : 'Crear cuota'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

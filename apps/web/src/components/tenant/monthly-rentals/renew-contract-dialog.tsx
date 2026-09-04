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
import { renewMonthlyRentalContractAction } from '@/actions/monthly-rentals'

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open:               boolean
  onClose:            () => void
  originalContractId: string
  defaults: {
    rentAmount:     number
    expensesAmount: number | null | undefined
    dueDay:         number
    currency:       string
  }
  onRenewed: (newContractId: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(n: number | null | undefined) {
  return n !== null && n !== undefined ? String(n) : ''
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RenewContractDialog({
  open, onClose, originalContractId, defaults, onRenewed,
}: Props) {
  const [isPending, startTrans] = useTransition()

  const [startDate,      setStartDate]      = useState('')
  const [endDate,        setEndDate]        = useState('')
  const [rentAmount,     setRentAmount]     = useState(str(defaults.rentAmount))
  const [expensesAmount, setExpensesAmount] = useState(str(defaults.expensesAmount))
  const [depositAmount,  setDepositAmount]  = useState('')
  const [dueDay,         setDueDay]         = useState(str(defaults.dueDay))
  const [contractNotes,  setContractNotes]  = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    startTrans(async () => {
      const result = await renewMonthlyRentalContractAction(originalContractId, {
        startDate,
        endDate:        endDate || null,
        rentAmount:     Number(rentAmount)     || 0,
        dueDay:         Number(dueDay)         || 10,
        expensesAmount: expensesAmount !== '' ? Number(expensesAmount) : null,
        depositAmount:  depositAmount  !== '' ? Number(depositAmount)  : null,
        contractNotes:  contractNotes  || null,
      })

      if (result.success) {
        toast.success('Nuevo contrato creado como borrador.')
        onRenewed(result.data!.newContractId)
        onClose()
      } else {
        toast.error(result.error ?? 'Error al renovar el contrato.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="text-sm">Renovar contrato</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
              La renovación crea un contrato nuevo en borrador con la misma propiedad e inquilino.
              El contrato actual no se finaliza automáticamente — hacelo manualmente desde ese contrato cuando corresponda.
            </div>

            {/* Período */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Nuevo período</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Fecha inicio <span className="text-destructive">*</span></Label>
                  <Input
                    type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                    className="h-8 text-xs" required disabled={isPending}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Fecha fin (opcional)</Label>
                  <Input
                    type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                    className="h-8 text-xs" disabled={isPending}
                  />
                </div>
              </div>
            </section>

            {/* Montos */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Montos ({defaults.currency})
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Alquiler mensual <span className="text-destructive">*</span></Label>
                  <Input
                    type="number" min="0" step="0.01" value={rentAmount}
                    onChange={(e) => setRentAmount(e.target.value)}
                    className="h-8 text-xs" required disabled={isPending}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Día de vencimiento</Label>
                  <Input
                    type="number" min="1" max="31" value={dueDay}
                    onChange={(e) => setDueDay(e.target.value)}
                    className="h-8 text-xs" disabled={isPending}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Expensas</Label>
                  <Input
                    type="number" min="0" step="0.01" value={expensesAmount}
                    onChange={(e) => setExpensesAmount(e.target.value)}
                    className="h-8 text-xs" disabled={isPending} placeholder="0"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Depósito</Label>
                  <Input
                    type="number" min="0" step="0.01" value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    className="h-8 text-xs" disabled={isPending} placeholder="0"
                  />
                </div>
              </div>
            </section>

            {/* Notas */}
            <section className="space-y-1.5">
              <Label className="text-xs">Notas del contrato</Label>
              <Textarea
                value={contractNotes} onChange={(e) => setContractNotes(e.target.value)}
                rows={2} maxLength={5000} disabled={isPending}
                className="text-xs resize-none"
                placeholder="Condiciones especiales, aclaraciones..."
              />
            </section>

          </div>

          <DialogFooter className="px-6 py-4 border-t gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? 'Creando…' : 'Renovar contrato'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

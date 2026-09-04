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
import { extendMonthlyRentalContractAction } from '@/actions/monthly-rentals'

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open:           boolean
  onClose:        () => void
  contractId:     string
  currentEndDate: string | null | undefined
  currency:       string
  onExtended:     () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ExtendContractDialog({
  open, onClose, contractId, currentEndDate, currency, onExtended,
}: Props) {
  const [isPending, startTrans] = useTransition()

  const [newEndDate,    setNewEndDate]    = useState(currentEndDate ?? '')
  const [newRentAmount, setNewRentAmount] = useState('')
  const [notes,         setNotes]         = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    startTrans(async () => {
      const result = await extendMonthlyRentalContractAction(contractId, {
        newEndDate,
        newRentAmount: newRentAmount !== '' ? Number(newRentAmount) : undefined,
        notes:         notes || null,
      })

      if (result.success) {
        toast.success('Contrato extendido correctamente.')
        onExtended()
        onClose()
      } else {
        toast.error(result.error ?? 'Error al extender el contrato.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Extender contrato</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">

          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            Extender el contrato no genera cuotas automáticamente. Podés generarlas
            después desde la sección Cuotas.
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              Nueva fecha de fin <span className="text-destructive">*</span>
            </Label>
            {currentEndDate && (
              <p className="text-[10px] text-muted-foreground">
                Fecha actual: {currentEndDate.split('-').reverse().join('/')}
              </p>
            )}
            <Input
              type="date" value={newEndDate} onChange={(e) => setNewEndDate(e.target.value)}
              className="h-8 text-xs" required disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              Nuevo alquiler mensual ({currency}) — opcional
            </Label>
            <Input
              type="number" min="0" step="0.01" value={newRentAmount}
              onChange={(e) => setNewRentAmount(e.target.value)}
              className="h-8 text-xs" disabled={isPending}
              placeholder="Sin cambios"
            />
            <p className="text-[10px] text-muted-foreground">
              Si ingresás un valor, se actualizará el importe base del contrato.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notas de la extensión (opcional)</Label>
            <Textarea
              value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={2} maxLength={5000} disabled={isPending}
              className="text-xs resize-none"
              placeholder="Motivo de la extensión, acuerdos, etc."
            />
            <p className="text-[10px] text-muted-foreground">
              Se agregará a las notas internas del contrato con fecha y hora.
            </p>
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? 'Guardando…' : 'Extender contrato'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

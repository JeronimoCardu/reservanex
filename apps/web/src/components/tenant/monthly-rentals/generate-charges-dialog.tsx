'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import { Label }  from '@/components/ui/label'
import { generateMonthlyRentalChargesAction } from '@/actions/monthly-rentals'

interface Props {
  open:       boolean
  onClose:    () => void
  contractId: string
}

const MONTH_NAMES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
]

export function GenerateChargesDialog({ open, onClose, contractId }: Props) {
  const now = new Date()
  const [fromMonth,    setFromMonth]    = useState(String(now.getMonth() + 1))
  const [fromYear,     setFromYear]     = useState(String(now.getFullYear()))
  const [monthsCount,  setMonthsCount]  = useState('3')
  const [isPending,    startTrans]      = useTransition()

  const [result, setResult] = useState<{
    createdCount: number
    skippedCount: number
    createdPeriods: string[]
    skippedPeriods: string[]
  } | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setResult(null)
    startTrans(async () => {
      const res = await generateMonthlyRentalChargesAction(contractId, {
        fromYear:    Number(fromYear),
        fromMonth:   Number(fromMonth),
        monthsCount: Number(monthsCount),
      })
      if (res.success && res.data) {
        setResult(res.data)
        if (res.data.createdCount > 0) {
          toast.success(`${res.data.createdCount} cuota${res.data.createdCount !== 1 ? 's' : ''} generada${res.data.createdCount !== 1 ? 's' : ''}.`)
        } else {
          toast.info('No se generaron cuotas nuevas — los períodos ya existen.')
        }
      } else {
        toast.error((res as { success: false; error?: string }).error ?? 'Error al generar cuotas.')
      }
    })
  }

  function handleClose() {
    setResult(null)
    onClose()
  }

  function periodLabel(p: string) {
    const [y, m] = p.split('-')
    return `${MONTH_NAMES[(Number(m) - 1)]} ${y}`
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent className="max-w-md flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="text-sm">Generar cuotas en lote</DialogTitle>
        </DialogHeader>

        {result ? (
          // Result view
          <div className="px-6 py-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-card p-3 text-center">
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">{result.createdCount}</p>
                <p className="text-xs text-muted-foreground mt-1">Generadas</p>
              </div>
              <div className="rounded-lg border bg-card p-3 text-center">
                <p className="text-2xl font-bold text-muted-foreground">{result.skippedCount}</p>
                <p className="text-xs text-muted-foreground mt-1">Saltadas (ya existían)</p>
              </div>
            </div>

            {result.createdPeriods.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Cuotas generadas</p>
                <div className="flex flex-wrap gap-1.5">
                  {result.createdPeriods.map((p) => (
                    <span key={p} className="inline-flex rounded border bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900 px-2 py-0.5 text-xs">
                      {periodLabel(p)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {result.skippedPeriods.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Ya existían</p>
                <div className="flex flex-wrap gap-1.5">
                  {result.skippedPeriods.map((p) => (
                    <span key={p} className="inline-flex rounded border bg-muted text-muted-foreground border-border px-2 py-0.5 text-xs">
                      {periodLabel(p)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={handleClose}>Cerrar</Button>
            </div>
          </div>
        ) : (
          // Form view
          <form onSubmit={handleSubmit} className="flex flex-col">
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Mes inicial <span className="text-destructive">*</span></Label>
                  <select
                    value={fromMonth}
                    onChange={(e) => setFromMonth(e.target.value)}
                    disabled={isPending}
                    className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {MONTH_NAMES.map((name, i) => (
                      <option key={i + 1} value={String(i + 1)}>{name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Año <span className="text-destructive">*</span></Label>
                  <Input
                    type="number" min="2000" max="2100" value={fromYear}
                    onChange={(e) => setFromYear(e.target.value)}
                    className="h-8 text-xs" required disabled={isPending}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  Cantidad de meses <span className="text-destructive">*</span>
                  <span className="text-muted-foreground ml-1">(máx. 24)</span>
                </Label>
                <Input
                  type="number" min="1" max="24" value={monthsCount}
                  onChange={(e) => setMonthsCount(e.target.value)}
                  className="h-8 text-xs" required disabled={isPending}
                />
              </div>

              <p className="text-[11px] text-muted-foreground">
                Los períodos que ya tienen cuota serán saltados automáticamente.
                Los montos se tomarán del contrato al momento de generar.
              </p>
            </div>

            <DialogFooter className="px-6 py-4 border-t gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleClose} disabled={isPending}>
                Cancelar
              </Button>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? 'Generando…' : 'Generar cuotas'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

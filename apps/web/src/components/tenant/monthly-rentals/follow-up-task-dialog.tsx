'use client'

import { useState, useTransition } from 'react'
import { AlertCircleIcon, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { createMonthlyRentalFollowUpTaskAction } from '@/actions/monthly-rentals'
import type { MonthlyRentalFollowUpTask } from '@/lib/repositories/monthly-rentals.repository'

interface Props {
  open:          boolean
  onClose:       () => void
  contractId:    string
  existingTasks: MonthlyRentalFollowUpTask[]
  defaultTitle?: string
}

const QUICK_TITLES = [
  'Seguimiento de cuota vencida',
  'Contactar al inquilino',
  'Renovar contrato',
  'Recordatorio de vencimiento',
  'Verificar pago pendiente',
]

export function FollowUpTaskDialog({
  open, onClose, contractId, existingTasks, defaultTitle,
}: Props) {
  const [isPending, startTrans] = useTransition()

  const [title,       setTitle]       = useState(defaultTitle ?? '')
  const [description, setDescription] = useState('')
  const [dueDate,     setDueDate]     = useState('')
  const [priority,    setPriority]    = useState('medium')

  const openTasks = existingTasks.filter(
    (t) => t.status !== 'completed' && t.status !== 'cancelled',
  )

  function reset() {
    setTitle(defaultTitle ?? '')
    setDescription('')
    setDueDate('')
    setPriority('medium')
  }

  function handleClose() {
    reset()
    onClose()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return

    startTrans(async () => {
      const result = await createMonthlyRentalFollowUpTaskAction(contractId, {
        title:       title.trim(),
        description: description.trim() || undefined,
        due_date:    dueDate || undefined,
        priority,
      })
      if (result.success) {
        if (result.data?.reused) {
          toast.info('Ya existe una tarea abierta para este seguimiento.')
        } else {
          toast.success('Tarea creada.')
        }
        handleClose()
      } else {
        toast.error(result.error ?? 'Error al crear la tarea.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva tarea de seguimiento</DialogTitle>
        </DialogHeader>

        {openTasks.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30 p-3 text-xs text-yellow-800 dark:text-yellow-400">
            <AlertCircleIcon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Ya hay {openTasks.length} tarea{openTasks.length !== 1 ? 's' : ''} pendiente{openTasks.length !== 1 ? 's' : ''} en este contrato. Podés crear una adicional igual.
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Quick title chips */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Acceso rápido</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_TITLES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTitle(t)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                    title === t
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border hover:border-primary/60 hover:bg-muted'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Título *</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: Cuota vencida 07/2026"
              className="h-8 text-sm"
              required
              maxLength={300}
            />
            <p className="text-[10px] text-muted-foreground">
              Incluí el período para distinguir tareas de cuotas distintas.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Vencimiento</label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Prioridad</label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-background border shadow-md">
                  <SelectItem value="low"    className="text-xs">Baja</SelectItem>
                  <SelectItem value="medium" className="text-xs">Media</SelectItem>
                  <SelectItem value="high"   className="text-xs">Alta</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Descripción (opcional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detalles adicionales..."
              rows={3}
              maxLength={2000}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0 resize-none"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={handleClose} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={isPending || !title.trim()} className="gap-1.5">
              <PlusIcon className="h-3.5 w-3.5" />
              Crear tarea
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

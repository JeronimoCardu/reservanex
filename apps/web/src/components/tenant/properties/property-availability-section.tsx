'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { CalendarOffIcon, PlusIcon, Trash2Icon, CalendarIcon, UsersIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ReservationStatusBadge } from '@/components/tenant/conversations/reservation-status-badge'
import { createAvailabilityBlockAction, deleteAvailabilityBlockAction } from '@/actions/property-availability'
import type { PropertyAvailabilityBlock } from '@/lib/repositories/property-availability.repository'
import type { UpcomingPropertyReservation } from '@/lib/repositories/reservations.repository'

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-')
  return `${day}/${month}/${year}`
}

function formatExpiresAt(expiresAt: string | null): string | null {
  if (!expiresAt) return null
  const exp  = new Date(expiresAt)
  const now  = new Date()
  const diff = exp.getTime() - now.getTime()
  if (diff <= 0) return 'Vencida'
  const hrs = Math.floor(diff / 3600000)
  if (hrs < 1) return `Vence en ${Math.floor(diff / 60000)} min`
  return `Vence en ${hrs} h`
}

function AddBlockDialog({
  propertyId,
  onSuccess,
}: {
  propertyId: string
  onSuccess: () => void
}) {
  const [open, setOpen]           = useState(false)
  const [isPending, startTrans]   = useTransition()
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate]     = useState('')
  const [reason, setReason]       = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTrans(async () => {
      const result = await createAvailabilityBlockAction({
        property_id: propertyId,
        start_date:  startDate,
        end_date:    endDate,
        reason:      reason || null,
      })
      if (result.success) {
        toast.success('Bloqueo creado.')
        setOpen(false)
        setStartDate('')
        setEndDate('')
        setReason('')
        onSuccess()
      } else {
        toast.error(result.error ?? 'Error al crear el bloqueo.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
          <PlusIcon className="h-3 w-3" />
          Bloquear fechas
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Bloquear fechas</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="start_date" className="text-xs">Desde</Label>
              <Input
                id="start_date"
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                required
                disabled={isPending}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="end_date" className="text-xs">Hasta</Label>
              <Input
                id="end_date"
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                required
                disabled={isPending}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reason" className="text-xs">Motivo (opcional)</Label>
            <Input
              id="reason"
              type="text"
              placeholder="Mantenimiento, uso propio..."
              value={reason}
              onChange={e => setReason(e.target.value)}
              disabled={isPending}
              maxLength={500}
              className="h-8 text-xs"
            />
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={isPending}>
            {isPending ? 'Guardando…' : 'Confirmar bloqueo'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface PropertyAvailabilitySectionProps {
  propertyId:   string
  reservations: UpcomingPropertyReservation[]
  blocks:       PropertyAvailabilityBlock[]
  canManage:    boolean
}

export function PropertyAvailabilitySection({
  propertyId,
  reservations,
  blocks,
  canManage,
}: PropertyAvailabilitySectionProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [isPending, startTrans]     = useTransition()

  function handleDeleteBlock(blockId: string) {
    setDeletingId(blockId)
    startTrans(async () => {
      const result = await deleteAvailabilityBlockAction(blockId, propertyId)
      setDeletingId(null)
      if (result.success) {
        toast.success('Bloqueo eliminado.')
      } else {
        toast.error(result.error ?? 'Error al eliminar el bloqueo.')
      }
    })
  }

  const hasContent = reservations.length > 0 || blocks.length > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <CalendarOffIcon className="h-4 w-4 text-muted-foreground" />
          Disponibilidad
        </h2>
        {canManage && (
          <AddBlockDialog propertyId={propertyId} onSuccess={() => {}} />
        )}
      </div>

      {!hasContent && (
        <p className="text-xs text-muted-foreground py-3">
          Sin reservas ni bloqueos próximos.
        </p>
      )}

      {/* Upcoming reservations */}
      {reservations.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Reservas próximas</p>
          <div className="space-y-1.5">
            {reservations.map(r => {
              const isExpired = r.status === 'pre_reserved' && r.expires_at != null && new Date(r.expires_at) <= new Date()
              const expiresLabel = r.status === 'pre_reserved' ? formatExpiresAt(r.expires_at) : null
              return (
                <div key={r.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex items-center gap-1 text-muted-foreground whitespace-nowrap">
                      <CalendarIcon className="h-3 w-3" />
                      {formatDate(r.start_date)} – {formatDate(r.end_date)}
                    </span>
                    <span className="flex items-center gap-0.5 text-muted-foreground">
                      <UsersIcon className="h-3 w-3" />
                      {r.guests}
                    </span>
                    {r.contact?.name && (
                      <span className="truncate text-muted-foreground">{r.contact.name}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {expiresLabel && (
                      <span className={`text-[10px] ${isExpired ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}>
                        {expiresLabel}
                      </span>
                    )}
                    <ReservationStatusBadge status={r.status} expired={isExpired} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Manual blocks */}
      {blocks.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Bloqueos manuales</p>
          <div className="space-y-1.5">
            {blocks.map(block => (
              <div key={block.id} className="flex items-center justify-between rounded-md border border-dashed px-3 py-2 text-xs">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex items-center gap-1 text-muted-foreground whitespace-nowrap">
                    <CalendarIcon className="h-3 w-3" />
                    {formatDate(block.start_date)} – {formatDate(block.end_date)}
                  </span>
                  {block.reason && (
                    <span className="truncate text-muted-foreground">{block.reason}</span>
                  )}
                </div>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => handleDeleteBlock(block.id)}
                    disabled={isPending && deletingId === block.id}
                    className="shrink-0 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                    title="Eliminar bloqueo"
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

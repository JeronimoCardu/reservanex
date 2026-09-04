'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { CalendarIcon, Building2Icon, UsersIcon, ExternalLinkIcon, CheckCircle2Icon, BotIcon, ClockIcon, XCircleIcon } from 'lucide-react'
import { toast } from 'sonner'
import { updateReservationStatusAction, confirmReservationAction, cancelReservationAction } from '@/actions/reservations'
import type { ReservationForConversation } from '@/lib/repositories/reservations.repository'
import { ReservationStatusBadge } from './reservation-status-badge'
import { CreateReservationDialog } from './create-reservation-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

function formatExpiresAt(expiresAt: string | null): string | null {
  if (!expiresAt) return null
  const exp  = new Date(expiresAt)
  const now  = new Date()
  const diff = exp.getTime() - now.getTime()
  if (diff <= 0) return 'Vencida'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `Vence en ${mins} min`
  const hrs = Math.floor(mins / 60)
  return `Vence en ${hrs} h`
}

type ConversationProperty = {
  id:             string
  title:          string
  city:           string | null
  operation_type: string | null
}

type ConversationUnit = {
  id:   string
  name: string
}

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-')
  return `${day}/${month}/${year}`
}

function formatAmount(amount: number | null, currency: string): string | null {
  if (amount == null) return null
  return new Intl.NumberFormat('es-AR', {
    style:    'currency',
    currency: currency ?? 'ARS',
    maximumFractionDigits: 0,
  }).format(amount)
}

function CancelReservationDialog({
  reservationId,
  open,
  onClose,
}: {
  reservationId: string
  open:          boolean
  onClose:       () => void
}) {
  const [reason, setReason]     = useState('')
  const [isPending, startTrans] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTrans(async () => {
      const result = await cancelReservationAction(reservationId, { reason: reason || undefined })
      if (result.success) {
        toast.success('Reserva cancelada.')
        onClose()
        setReason('')
      } else {
        toast.error(result.error ?? 'Error al cancelar.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Cancelar reserva</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="cp-cancel-reason" className="text-xs">Motivo (opcional)</Label>
            <Textarea
              id="cp-cancel-reason"
              placeholder="Ej: El huésped no pudo viajar..."
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              maxLength={1000}
              disabled={isPending}
              className="text-sm resize-none"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isPending}>
              Volver
            </Button>
            <Button type="submit" size="sm" variant="destructive" disabled={isPending}>
              {isPending ? 'Cancelando…' : 'Confirmar cancelación'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const PAYMENT_BADGE_CFG: Record<string, { label: string; className: string }> = {
  pending:      { label: 'Pago pendiente', className: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-900' },
  deposit_paid: { label: 'Seña pagada',   className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900'            },
  paid:         { label: 'Pagada',        className: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900'       },
  refunded:     { label: 'Reembolsada',   className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'         },
  not_required: { label: 'No requiere',   className: 'bg-muted text-muted-foreground border-border'                                                                      },
}

function PaymentBadge({ status }: { status: string | null }) {
  const cfg = status ? PAYMENT_BADGE_CFG[status] : null
  if (!cfg) return null
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${cfg.className}`}>
      {cfg.label}
    </span>
  )
}

function ReservationCard({
  reservation,
  canConfirm,
}: {
  reservation: ReservationForConversation
  canConfirm:  boolean
}) {
  const [isPending, startTransition] = useTransition()
  const [cancelOpen, setCancelOpen]  = useState(false)
  const property      = reservation.property ?? null
  const propertyTitle = property?.title ?? 'Propiedad sin título'

  const isPreReserved = reservation.status === 'pre_reserved'
  const isExpired     = isPreReserved && reservation.expires_at != null && new Date(reservation.expires_at) <= new Date()
  const expiresLabel  = isPreReserved ? formatExpiresAt(reservation.expires_at) : null
  const isCancellable = reservation.status !== 'cancelled' && canConfirm
  const isChangeable  = reservation.status === 'inquiry' || reservation.status === 'interested'

  function handleStatusChange(newStatus: string) {
    startTransition(async () => {
      const result = await updateReservationStatusAction(reservation.id, { status: newStatus })
      if (!result.success) toast.error(result.error ?? 'Error al actualizar el estado.')
    })
  }

  function handleConfirm() {
    startTransition(async () => {
      const result = await confirmReservationAction(reservation.id)
      if (result.success) {
        toast.success('Reserva confirmada.')
      } else {
        toast.error(result.error ?? 'Error al confirmar.')
      }
    })
  }

  return (
    <>
      <div className="rounded-md border bg-background p-3 space-y-2.5 text-sm">
        {/* Property + link */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Building2Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium truncate">{propertyTitle}</span>
            {reservation.unit && (
              <span className="text-[10px] text-muted-foreground">· {reservation.unit.name}</span>
            )}
            {reservation.source === 'ai' && (
              <span className="inline-flex items-center gap-0.5 rounded border border-blue-200 bg-blue-50 px-1 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-800">
                <BotIcon className="h-2.5 w-2.5" />
                IA
              </span>
            )}
          </div>
          <Link
            href={`/dashboard/reservations`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="Ver en Reservas"
          >
            <ExternalLinkIcon className="h-3.5 w-3.5" />
          </Link>
        </div>

        {/* Dates + guests */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <CalendarIcon className="h-3 w-3" />
            {formatDate(reservation.start_date)} – {formatDate(reservation.end_date)}
          </span>
          <span className="flex items-center gap-1">
            <UsersIcon className="h-3 w-3" />
            {reservation.guests}
          </span>
        </div>

        {/* Amount */}
        {reservation.total_amount != null && (
          <p className="text-xs font-medium text-foreground">
            {formatAmount(reservation.total_amount, reservation.price_currency ?? reservation.currency)}
          </p>
        )}

        {/* Status row */}
        <div className="flex items-center gap-2 flex-wrap">
          <ReservationStatusBadge status={reservation.status} expired={isExpired} />
          <PaymentBadge status={reservation.payment_status ?? null} />

          {isChangeable && (
            <Select value={reservation.status} onValueChange={handleStatusChange} disabled={isPending}>
              <SelectTrigger className="h-6 w-auto border-0 bg-transparent p-0 text-[10px] text-muted-foreground hover:text-foreground shadow-none focus:ring-0 gap-1 disabled:opacity-50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md text-xs">
                <SelectItem value="inquiry">Consulta</SelectItem>
                <SelectItem value="interested">Interesado</SelectItem>
              </SelectContent>
            </Select>
          )}

          {isPreReserved && expiresLabel && (
            <span className={`flex items-center gap-1 text-[10px] ${isExpired ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}>
              <ClockIcon className="h-2.5 w-2.5" />
              {expiresLabel}
            </span>
          )}

          {isPreReserved && canConfirm && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px] px-2 gap-1 text-green-700 border-green-300 hover:bg-green-50 dark:text-green-400 dark:border-green-700 dark:hover:bg-green-950"
              onClick={handleConfirm}
              disabled={isPending}
            >
              <CheckCircle2Icon className="h-3 w-3" />
              Confirmar
            </Button>
          )}

          {isCancellable && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[11px] px-2 gap-1 text-muted-foreground hover:text-destructive"
              onClick={() => setCancelOpen(true)}
              disabled={isPending}
            >
              <XCircleIcon className="h-3 w-3" />
              Cancelar
            </Button>
          )}
        </div>

        {/* Notes */}
        {reservation.notes && (
          <p className="text-[11px] text-muted-foreground border-t pt-2 leading-relaxed">
            {reservation.notes}
          </p>
        )}
      </div>

      <CancelReservationDialog
        reservationId={reservation.id}
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
      />
    </>
  )
}

interface ReservationPanelProps {
  conversationId: string
  contactId:      string
  property?:      ConversationProperty | null
  unit?:          ConversationUnit     | null
  reservations:   ReservationForConversation[]
  canConfirm:     boolean
}

export function ReservationPanel({
  conversationId,
  contactId,
  property,
  unit,
  reservations,
  canConfirm,
}: ReservationPanelProps) {
  const isTemporaryRental = property?.operation_type === 'temporary_rental'

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        {(!property || isTemporaryRental) ? (
          <CreateReservationDialog
            conversationId={conversationId}
            contactId={contactId}
            property={property}
            unit={unit}
          />
        ) : (
          <p className="text-xs text-muted-foreground italic">
            Solo las propiedades de alquiler temporario admiten reservas.
          </p>
        )}
      </div>

      {reservations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <CalendarIcon className="mb-2 h-8 w-8 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">
            Sin reservas en esta conversación.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {reservations.map(r => <ReservationCard key={r.id} reservation={r} canConfirm={canConfirm} />)}
        </div>
      )}
    </div>
  )
}

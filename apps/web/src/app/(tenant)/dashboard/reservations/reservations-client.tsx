'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
  CalendarIcon,
  UsersIcon,
  PhoneIcon,
  SearchIcon,
  BotIcon,
  ClockIcon,
  XCircleIcon,
  CalendarArrowUpIcon,
  PlusIcon,
  UserIcon,
  BuildingIcon,
  CheckCircle2Icon,
  CheckCheckIcon,
  MessageSquareIcon,
  EllipsisIcon,
  EyeIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  confirmReservationAction,
  cancelReservationAction,
  rescheduleReservationAction,
  createReservationAction,
  completeReservationAction,
} from '@/actions/reservations'
import type { ReservationWithDetails } from '@/lib/repositories/reservations.repository'
import type { ReservationDocumentBadge } from '@/lib/repositories/reservation-badges.repository'
import { ReservationStatusBadge } from '@/components/tenant/conversations/reservation-status-badge'
import { ReservationDetailDrawer } from '@/components/tenant/reservations/reservation-detail-drawer'
import { Input } from '@/components/ui/input'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-')
  return `${day}/${month}/${year}`
}

function formatAmount(amount: number | null, currency: string): string | null {
  if (amount == null) return null
  return new Intl.NumberFormat('es-AR', {
    style:                 'currency',
    currency:              currency ?? 'ARS',
    maximumFractionDigits: 0,
  }).format(amount)
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]!
}

// ─── Dialogs ─────────────────────────────────────────────────────────────────

function CancelDialog({
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
            <Label htmlFor="cancel-reason" className="text-xs">Motivo (opcional)</Label>
            <Textarea
              id="cancel-reason"
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

function RescheduleDialog({
  reservation,
  open,
  onClose,
}: {
  reservation: ReservationWithDetails
  open:        boolean
  onClose:     () => void
}) {
  const [startDate, setStartDate] = useState(reservation.start_date)
  const [endDate, setEndDate]     = useState(reservation.end_date)
  const [guests, setGuests]       = useState(String(reservation.guests))
  const [isPending, startTrans]   = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTrans(async () => {
      const result = await rescheduleReservationAction(reservation.id, {
        start_date: startDate,
        end_date:   endDate,
        guests:     Number(guests),
      })
      if (result.success) {
        toast.success('Reserva reprogramada.')
        onClose()
      } else {
        toast.error(result.error ?? 'Error al reprogramar.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Reprogramar reserva</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="r-start" className="text-xs">Entrada</Label>
              <Input id="r-start" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required disabled={isPending} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-end" className="text-xs">Salida</Label>
              <Input id="r-end" type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} required disabled={isPending} className="h-8 text-xs" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="r-guests" className="text-xs">Personas</Label>
            <Input id="r-guests" type="number" min={1} value={guests} onChange={e => setGuests(e.target.value)} required disabled={isPending} className="h-8 text-xs w-24" />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isPending}>Volver</Button>
            <Button type="submit" size="sm" disabled={isPending}>{isPending ? 'Guardando…' : 'Guardar cambios'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface ContactOption  { id: string; name: string | null; phone: string | null }
interface PropertyOption { id: string; title: string; city: string | null }

function CreateReservationDialog({
  contacts,
  properties,
  open,
  onClose,
}: {
  contacts:   ContactOption[]
  properties: PropertyOption[]
  open:       boolean
  onClose:    () => void
}) {
  const [contactId,      setContactId]      = useState('')
  const [propertyId,     setPropertyId]     = useState('')
  const [startDate,      setStartDate]      = useState('')
  const [endDate,        setEndDate]        = useState('')
  const [guests,         setGuests]         = useState('1')
  const [status,         setStatus]         = useState<'pre_reserved' | 'confirmed'>('pre_reserved')
  const [notes,          setNotes]          = useState('')
  const [contactSearch,  setContactSearch]  = useState('')
  const [isPending, startTrans]             = useTransition()

  const filteredContacts = contacts.filter(c => {
    if (!contactSearch) return true
    const q = contactSearch.toLowerCase()
    return c.name?.toLowerCase().includes(q) || c.phone?.toLowerCase().includes(q)
  })

  function handleClose() {
    setContactId(''); setPropertyId(''); setStartDate(''); setEndDate('')
    setGuests('1'); setStatus('pre_reserved'); setNotes(''); setContactSearch('')
    onClose()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTrans(async () => {
      const result = await createReservationAction({
        contact_id: contactId, conversation_id: null, property_id: propertyId,
        start_date: startDate, end_date: endDate, guests: Number(guests), status, notes: notes || null,
      })
      if (result.success) { toast.success('Reserva creada.'); handleClose() }
      else toast.error(result.error ?? 'Error al crear.')
    })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Nueva reserva manual</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1"><UserIcon className="h-3 w-3" />Contacto</Label>
            <Input placeholder="Buscar contacto..." value={contactSearch} onChange={e => setContactSearch(e.target.value)} className="h-8 text-xs" />
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Seleccionar contacto" /></SelectTrigger>
              <SelectContent className="bg-background border shadow-md max-h-48">
                {filteredContacts.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">Sin resultados</div>}
                {filteredContacts.map(c => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">
                    {c.name ?? c.phone ?? c.id.slice(0, 8)}
                    {c.phone && c.name && <span className="text-muted-foreground ml-1">· {c.phone}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1"><BuildingIcon className="h-3 w-3" />Propiedad</Label>
            <Select value={propertyId} onValueChange={setPropertyId}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Seleccionar propiedad" /></SelectTrigger>
              <SelectContent className="bg-background border shadow-md max-h-48">
                {properties.map(p => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">{p.title}{p.city ? ` — ${p.city}` : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="c-start" className="text-xs">Entrada</Label>
              <Input id="c-start" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required disabled={isPending} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-end" className="text-xs">Salida</Label>
              <Input id="c-end" type="date" value={endDate} min={startDate || undefined} onChange={e => setEndDate(e.target.value)} required disabled={isPending} className="h-8 text-xs" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="c-guests" className="text-xs">Personas</Label>
              <Input id="c-guests" type="number" min={1} value={guests} onChange={e => setGuests(e.target.value)} required disabled={isPending} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Estado inicial</Label>
              <Select value={status} onValueChange={v => setStatus(v as 'pre_reserved' | 'confirmed')}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-background border shadow-md">
                  <SelectItem value="pre_reserved" className="text-xs">Pendiente</SelectItem>
                  <SelectItem value="confirmed" className="text-xs">Confirmada</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-notes" className="text-xs">Notas (opcional)</Label>
            <Textarea id="c-notes" placeholder="Pedidos especiales..." value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={2000} disabled={isPending} className="text-xs resize-none" />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleClose} disabled={isPending}>Cancelar</Button>
            <Button type="submit" size="sm" disabled={isPending || !contactId || !propertyId}>{isPending ? 'Creando…' : 'Crear reserva'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Filter types & logic ────────────────────────────────────────────────────

type FilterKey =  'all' | 'active' | 'pending' | 'expired_pending' | 'confirmed' | 'completed' | 'cancelled'

const FILTER_OPTIONS: { value: FilterKey; label: string }[] = [
  { value: 'all',             label: 'Todas'               },
  { value: 'active',          label: 'Activas'             },
  { value: 'pending',         label: 'Pendientes'          },
  { value: 'expired_pending', label: 'Pendientes vencidas' },
  { value: 'confirmed',       label: 'Confirmadas'         },
  { value: 'completed',       label: 'Completadas'         },
  { value: 'cancelled',       label: 'Canceladas'          },
]

function isPastConfirmed(r: ReservationWithDetails, today: string): boolean {
  return r.status === 'confirmed' && r.end_date <= today
}

function isExpiredPending(r: ReservationWithDetails, now: Date): boolean {
  return r.status === 'pre_reserved' && r.expires_at != null && new Date(r.expires_at) <= now
}

function matchesFilter(r: ReservationWithDetails, filter: FilterKey, today: string, now: Date): boolean {
  switch (filter) {
    case 'active':
      return (r.status === 'pre_reserved' && !isExpiredPending(r, now))
          || (r.status === 'confirmed' && r.end_date > today)
    case 'pending':
      return r.status === 'pre_reserved'
    case 'expired_pending':
      return isExpiredPending(r, now)
    case 'confirmed':
      return r.status === 'confirmed'
    case 'completed':
      return r.status === 'completed' || isPastConfirmed(r, today)
    case 'cancelled':
      return r.status === 'cancelled'
    case 'all':
      return true
  }
}

// ─── Actions dropdown per row ─────────────────────────────────────────────────

function ActionsDropdown({
  reservation,
  canConfirm,
  today,
  onCancel,
  onReschedule,
  onDetail,
}: {
  reservation:  ReservationWithDetails
  canConfirm:   boolean
  today:        string
  onCancel:     () => void
  onReschedule: () => void
  onDetail:     () => void
}) {
  const [isPending, startTransition] = useTransition()

  const isPreReserved    = reservation.status === 'pre_reserved'
  const isConfirmed      = reservation.status === 'confirmed'
  const isCompleted      = reservation.status === 'completed'
  const isCancelled      = reservation.status === 'cancelled'
  const pastConf         = isPastConfirmed(reservation, today)
  const canBeCompleted   = isConfirmed && pastConf && canConfirm
  const canBeConfirmed   = isPreReserved && canConfirm
  const canBeRescheduled = (isPreReserved || isConfirmed) && canConfirm
  const canBeCancelled   = !isCancelled && !isCompleted && canConfirm

  function handleConfirm() {
    startTransition(async () => {
      const result = await confirmReservationAction(reservation.id)
      if (result.success) toast.success('Reserva confirmada.')
      else toast.error(result.error ?? 'Error al confirmar.')
    })
  }

  function handleComplete() {
    startTransition(async () => {
      const result = await completeReservationAction(reservation.id)
      if (result.success) toast.success('Reserva marcada como completada.')
      else toast.error(result.error ?? 'Error al completar.')
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs gap-1.5"
          disabled={isPending}
        >
          <EllipsisIcon className="h-3.5 w-3.5" />
          Acciones
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 text-sm">
        <DropdownMenuItem className="gap-2" onSelect={onDetail} disabled={isPending}>
          <EyeIcon className="h-3.5 w-3.5" />
          Ver detalle
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {canBeConfirmed && (
          <DropdownMenuItem
            className="gap-2 text-green-700 dark:text-green-400 focus:text-green-700 dark:focus:text-green-400"
            onSelect={handleConfirm}
            disabled={isPending}
          >
            <CheckCircle2Icon className="h-3.5 w-3.5" />
            Confirmar
          </DropdownMenuItem>
        )}
        {canBeCompleted && (
          <DropdownMenuItem
            className="gap-2 text-purple-700 dark:text-purple-400 focus:text-purple-700 dark:focus:text-purple-400"
            onSelect={handleComplete}
            disabled={isPending}
          >
            <CheckCheckIcon className="h-3.5 w-3.5" />
            Marcar completada
          </DropdownMenuItem>
        )}
        {canBeRescheduled && (
          <DropdownMenuItem className="gap-2" onSelect={onReschedule} disabled={isPending}>
            <CalendarArrowUpIcon className="h-3.5 w-3.5" />
            Reprogramar
          </DropdownMenuItem>
        )}
        {canBeCancelled && (
          <>
            {(canBeConfirmed || canBeCompleted || canBeRescheduled) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className="gap-2 text-destructive focus:text-destructive"
              onSelect={onCancel}
              disabled={isPending}
            >
              <XCircleIcon className="h-3.5 w-3.5" />
              Cancelar
            </DropdownMenuItem>
          </>
        )}
        {reservation.conversation_id && (
          <>
            {(canBeConfirmed || canBeCompleted || canBeRescheduled || canBeCancelled) && <DropdownMenuSeparator />}
            <DropdownMenuItem asChild>
              <Link
                href={`/dashboard/conversations/${reservation.conversation_id}`}
                className="gap-2 flex items-center"
              >
                <MessageSquareIcon className="h-3.5 w-3.5" />
                Abrir chat
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ─── Reservation row ─────────────────────────────────────────────────────────

const PAYMENT_STATUS_LABELS: Record<string, { label: string; className: string }> = {
  pending:      { label: 'Pago pendiente',  className: 'text-orange-600 dark:text-orange-400' },
  deposit_paid: { label: 'Seña pagada',     className: 'text-blue-600 dark:text-blue-400' },
  paid:         { label: 'Pagada',          className: 'text-green-700 dark:text-green-400' },
  refunded:     { label: 'Reembolsada',     className: 'text-slate-500' },
  not_required: { label: 'No requiere',     className: 'text-muted-foreground' },
}

function DocumentBadges({ badge }: { badge: ReservationDocumentBadge | undefined }) {
  if (!badge) return null
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {badge.hasPaymentProof && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-400 dark:border-violet-900 whitespace-nowrap">
          Tiene comprobante
        </span>
      )}
      {badge.receiptFailed && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900 whitespace-nowrap">
          Error envío recibo
        </span>
      )}
      {badge.receiptSent && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900 whitespace-nowrap">
          Recibo enviado
        </span>
      )}
      {badge.hasReceipt && !badge.receiptSent && !badge.receiptFailed && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700 whitespace-nowrap">
          Recibo generado
        </span>
      )}
    </div>
  )
}

function ReservationRow({
  reservation,
  canConfirm,
  today,
  now,
  documentBadge,
}: {
  reservation:   ReservationWithDetails
  canConfirm:    boolean
  today:         string
  now:           Date
  documentBadge: ReservationDocumentBadge | undefined
}) {
  const [cancelOpen,     setCancelOpen]     = useState(false)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [detailOpen,     setDetailOpen]     = useState(false)

  const property      = reservation.property ?? reservation.unit?.property ?? null
  const contactName   = reservation.contact?.name ?? reservation.contact?.phone ?? 'Contacto'
  const priceCurrency = reservation.price_currency ?? reservation.currency
  const amount        = formatAmount(reservation.total_amount, priceCurrency)

  const isPreReserved = reservation.status === 'pre_reserved'
  const expired       = isExpiredPending(reservation, now)
  const pastConf      = isPastConfirmed(reservation, today)
  const expiresLabel  = isPreReserved ? formatExpiresAt(reservation.expires_at) : null

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/30 transition-colors">
        {/* Contact */}
        <td className="px-4 py-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium leading-snug">{contactName}</p>
            {reservation.contact?.phone && (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <PhoneIcon className="h-3 w-3 shrink-0" />
                {reservation.contact.phone}
              </p>
            )}
          </div>
        </td>

        {/* Property */}
        <td className="px-4 py-3">
          <div className="space-y-0.5">
            <p className="text-sm leading-snug">
              {property?.title ?? <span className="text-muted-foreground italic">Sin propiedad</span>}
            </p>
            {property?.city && <p className="text-xs text-muted-foreground">{property.city}</p>}
          </div>
        </td>

        {/* Dates + nights */}
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="flex items-center gap-1 text-sm">
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span>{formatDate(reservation.start_date)}</span>
            <span className="text-muted-foreground">–</span>
            <span>{formatDate(reservation.end_date)}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <UsersIcon className="h-3 w-3" />
              {reservation.guests} pers.
            </span>
            {reservation.nights_count != null && reservation.nights_count > 0 && (
              <span>{reservation.nights_count} n.</span>
            )}
          </div>
        </td>

        {/* Status */}
        <td className="px-4 py-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <ReservationStatusBadge
                status={reservation.status}
                expired={expired}
                pastConfirmed={pastConf}
              />
              {reservation.source === 'ai' ? (
                <span className="inline-flex items-center gap-0.5 rounded border border-blue-200 bg-blue-50 px-1 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-800">
                  <BotIcon className="h-2.5 w-2.5" />IA
                </span>
              ) : reservation.source === 'manual' ? (
                <span className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700">
                  Manual
                </span>
              ) : null}
            </div>
            {isPreReserved && expiresLabel && (
              <span className={`flex items-center gap-1 text-[10px] ${expired ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}>
                <ClockIcon className="h-2.5 w-2.5" />
                {expiresLabel}
              </span>
            )}
          </div>
        </td>

        {/* Amount + pago */}
        <td className="px-4 py-3 text-sm tabular-nums">
          {amount ? (
            <span className="font-medium">{amount}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {(() => {
            const ps   = reservation.payment_status as string | null
            const meta = ps ? PAYMENT_STATUS_LABELS[ps] : null
            return meta ? (
              <p className={`text-[10px] mt-0.5 ${meta.className}`}>{meta.label}</p>
            ) : null
          })()}
          <DocumentBadges badge={documentBadge} />
        </td>

        {/* Actions — fixed width dropdown, always same visual footprint */}
        <td className="px-4 py-3">
          <ActionsDropdown
            reservation={reservation}
            canConfirm={canConfirm}
            today={today}
            onCancel={() => setCancelOpen(true)}
            onReschedule={() => setRescheduleOpen(true)}
            onDetail={() => setDetailOpen(true)}
          />
        </td>
      </tr>

      {cancelOpen && (
        <CancelDialog
          reservationId={reservation.id}
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
        />
      )}
      {rescheduleOpen && (
        <RescheduleDialog
          reservation={reservation}
          open={rescheduleOpen}
          onClose={() => setRescheduleOpen(false)}
        />
      )}
      <ReservationDetailDrawer
        reservation={detailOpen ? reservation : null}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        canConfirm={canConfirm}
      />
    </>
  )
}

// ─── Main client ──────────────────────────────────────────────────────────────

interface ReservationsClientProps {
  reservations:   ReservationWithDetails[]
  canConfirm:     boolean
  contacts:       ContactOption[]
  properties:     PropertyOption[]
  documentBadges: Map<string, ReservationDocumentBadge>
}

export function ReservationsClient({
  reservations,
  canConfirm,
  contacts,
  properties,
  documentBadges,
}: ReservationsClientProps) {
  const [search,       setSearch]       = useState('')
  const [filterKey,    setFilterKey]    = useState<FilterKey>('all')
  const [createOpen,   setCreateOpen]   = useState(false)

  const now   = new Date()
  const today = todayStr()

  const filtered = reservations.filter(r => {
    if (!matchesFilter(r, filterKey, today, now)) return false
    if (!search) return true
    const q     = search.toLowerCase()
    const name  = r.contact?.name?.toLowerCase() ?? ''
    const phone = r.contact?.phone?.toLowerCase() ?? ''
    const prop  = (r.property ?? r.unit?.property)?.title.toLowerCase() ?? ''
    return name.includes(q) || phone.includes(q) || prop.includes(q)
  })

  const counts = {
    active:          reservations.filter(r => matchesFilter(r, 'active',          today, now)).length,
    completed:       reservations.filter(r => matchesFilter(r, 'completed',       today, now)).length,
    cancelled:       reservations.filter(r => matchesFilter(r, 'cancelled',       today, now)).length,
    expired_pending: reservations.filter(r => matchesFilter(r, 'expired_pending', today, now)).length,
  }

  function handleFilterChange(value: string) {
    setFilterKey(value as FilterKey)
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Filters + actions */}
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Buscar contacto, propiedad..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 w-64 h-8 text-sm"
          />
        </div>

        <Select value={filterKey} onValueChange={handleFilterChange}>
          <SelectTrigger className="w-52 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-background border shadow-md">
            {FILTER_OPTIONS.map(opt => {
              const count =
                opt.value === 'active'          ? counts.active          :
                opt.value === 'completed'       ? counts.completed       :
                opt.value === 'cancelled'       ? counts.cancelled       :
                opt.value === 'expired_pending' ? counts.expired_pending : null
              return (
                <SelectItem key={opt.value} value={opt.value} className="text-sm">
                  {opt.label}{count != null && count > 0 ? ` (${count})` : ''}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>

        {canConfirm && (
          <Button size="sm" variant="outline" className="ml-auto h-8 gap-1.5 text-sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="h-3.5 w-3.5" />
            Nueva reserva
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <CalendarIcon className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm font-medium text-foreground">Sin reservas</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-xs">
              {search || filterKey !== 'active'
                ? 'No hay reservas con esos filtros.'
                : 'Las reservas activas (pendientes y confirmadas futuras) aparecen acá.'}
            </p>
          </div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b bg-muted/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <th className="px-4 py-2.5">Contacto</th>
                <th className="px-4 py-2.5">Propiedad</th>
                <th className="px-4 py-2.5">Fechas</th>
                <th className="px-4 py-2.5">Estado</th>
                <th className="px-4 py-2.5">Total / Pago</th>
                <th className="px-4 py-2.5">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <ReservationRow
                  key={r.id}
                  reservation={r}
                  canConfirm={canConfirm}
                  today={today}
                  now={now}
                  documentBadge={documentBadges.get(r.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && canConfirm && (
        <CreateReservationDialog
          contacts={contacts}
          properties={properties}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  )
}

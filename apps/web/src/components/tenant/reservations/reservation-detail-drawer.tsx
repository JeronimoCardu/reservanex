'use client'

import { useState, useTransition, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  CalendarIcon, UsersIcon, PhoneIcon, BotIcon, ClockIcon,
  XCircleIcon, CalendarArrowUpIcon, CheckCircle2Icon, CheckCheckIcon,
  MessageSquareIcon, BuildingIcon, UserIcon, HomeIcon, MapPinIcon,
  BanknoteIcon, StickyNoteIcon, HistoryIcon, TrashIcon, PlusIcon,
  ExternalLinkIcon, FileIcon, ReceiptIcon, DownloadIcon, SendIcon,
} from 'lucide-react'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ReservationStatusBadge } from '@/components/tenant/conversations/reservation-status-badge'
import type { ReservationWithDetails } from '@/lib/repositories/reservations.repository'
import type { NoteRow } from '@/lib/repositories/notes.repository'
import type { ReservationEventRow } from '@/lib/repositories/reservation-events.repository'
import {
  confirmReservationAction,
  completeReservationAction,
  cancelReservationAction,
  rescheduleReservationAction,
  getReservationNotesAction,
  getReservationEventsAction,
} from '@/actions/reservations'
import {
  createReservationNoteAction,
  deleteReservationNoteAction,
} from '@/actions/notes'
import {
  getReservationPaymentProofsAction,
  type PaymentProofDoc,
} from '@/actions/documents'
import {
  saveReservationPaymentManualAction,
  type MarkPaymentResult,
} from '@/actions/reservation-payments'
import {
  generateReservationReceiptAction,
  getReservationReceiptsAction,
  type GenerateReceiptResult,
  type ReceiptDoc,
} from '@/actions/receipts'
import {
  sendReceiptDocumentByWhatsAppAction,
} from '@/actions/receipt-whatsapp'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-')
  return `${day}/${month}/${year}`
}

function formatDateTime(isoStr: string): string {
  const d = new Date(isoStr)
  return d.toLocaleString('es-AR', {
    day:    '2-digit', month: '2-digit', year: 'numeric',
    hour:   '2-digit', minute: '2-digit',
  })
}

function formatAmount(amount: number | null | undefined, currency: string): string {
  if (amount == null) return '—'
  return new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: currency ?? 'ARS', maximumFractionDigits: 0,
  }).format(amount)
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]!
}

function isPastConfirmed(r: ReservationWithDetails, today: string): boolean {
  return r.status === 'confirmed' && r.end_date <= today
}

function isExpiredPending(r: ReservationWithDetails): boolean {
  return r.status === 'pre_reserved' && r.expires_at != null && new Date(r.expires_at) <= new Date()
}

const EVENT_LABELS: Record<string, string> = {
  manual_created:  'Creada manualmente',
  ai_created:      'Creada por IA',
  confirmed:       'Confirmada',
  cancelled:       'Cancelada',
  completed:       'Marcada como completada',
  rescheduled:     'Reprogramada',
  payment_updated: 'Pago actualizado',
  note_created:    'Nota interna agregada',
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending:      'Pendiente',
  deposit_paid: 'Seña pagada',
  paid:         'Pagada',
  refunded:     'Reembolsada',
  not_required: 'No requiere pago',
}

// ─── Cancel inline dialog ─────────────────────────────────────────────────────

function CancelDialog({
  reservationId,
  open,
  onClose,
}: {
  reservationId: string
  open:          boolean
  onClose:       () => void
}) {
  const [reason, setReason] = useState('')
  const [isPending, start]  = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    start(async () => {
      const r = await cancelReservationAction(reservationId, { reason: reason || undefined })
      if (r.success) { toast.success('Reserva cancelada.'); onClose(); setReason('') }
      else toast.error(r.error)
    })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="text-sm">Cancelar reserva</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label className="text-xs">Motivo (opcional)</Label>
            <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={1000} disabled={isPending} className="text-sm resize-none" placeholder="Ej: El huésped canceló..." />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isPending}>Volver</Button>
            <Button type="submit" size="sm" variant="destructive" disabled={isPending}>{isPending ? 'Cancelando…' : 'Confirmar cancelación'}</Button>
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
  const [isPending, start]        = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    start(async () => {
      const r = await rescheduleReservationAction(reservation.id, { start_date: startDate, end_date: endDate, guests: Number(guests) })
      if (r.success) { toast.success('Reserva reprogramada.'); onClose() }
      else toast.error(r.error)
    })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="text-sm">Reprogramar reserva</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Entrada</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required disabled={isPending} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Salida</Label>
              <Input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} required disabled={isPending} className="h-8 text-xs" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Personas</Label>
            <Input type="number" min={1} value={guests} onChange={e => setGuests(e.target.value)} required disabled={isPending} className="h-8 text-xs w-24" />
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

// ─── Tab: Detalle ─────────────────────────────────────────────────────────────

function DetailTab({ reservation }: { reservation: ReservationWithDetails }) {
  const property    = reservation.property ?? reservation.unit?.property ?? null
  const contact     = reservation.contact
  const currency    = reservation.price_currency ?? reservation.currency ?? 'ARS'
  const expired     = isExpiredPending(reservation)

  return (
    <div className="space-y-6 py-4">
      {/* Propiedad */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <BuildingIcon className="h-3 w-3" /> Propiedad
        </div>
        {property ? (
          <div className="rounded-lg border p-3 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium leading-snug">{property.title}</p>
              <Link href={`/dashboard/properties/${property.id}`} className="text-muted-foreground hover:text-foreground shrink-0">
                <ExternalLinkIcon className="h-3.5 w-3.5" />
              </Link>
            </div>
            {property.city && (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPinIcon className="h-3 w-3" /> {property.city}
              </p>
            )}
            {reservation.property_id && (
              <p className="text-[10px] text-muted-foreground/60 font-mono">{reservation.property_id.slice(0, 8)}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">Sin propiedad asignada</p>
        )}
      </section>

      {/* Contacto */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <UserIcon className="h-3 w-3" /> Contacto
        </div>
        {contact ? (
          <div className="rounded-lg border p-3 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{contact.name ?? contact.phone ?? 'Sin nombre'}</p>
              <Link href={`/dashboard/contacts/${contact.id}`} className="text-muted-foreground hover:text-foreground shrink-0">
                <ExternalLinkIcon className="h-3.5 w-3.5" />
              </Link>
            </div>
            {contact.phone && (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <PhoneIcon className="h-3 w-3" /> {contact.phone}
              </p>
            )}
            {reservation.conversation_id && (
              <Link href={`/dashboard/conversations/${reservation.conversation_id}`} className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">
                <MessageSquareIcon className="h-3 w-3" /> Abrir conversación
              </Link>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">Sin contacto</p>
        )}
      </section>

      {/* Estadía */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <CalendarIcon className="h-3 w-3" /> Estadía
        </div>
        <div className="rounded-lg border p-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Entrada</p>
            <p className="font-medium">{formatDate(reservation.start_date)}</p>
            {property?.check_in_time && (
              <p className="text-xs text-muted-foreground">desde {String(property.check_in_time).slice(0, 5)}</p>
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Salida</p>
            <p className="font-medium">{formatDate(reservation.end_date)}</p>
            {property?.check_out_time && (
              <p className="text-xs text-muted-foreground">hasta {String(property.check_out_time).slice(0, 5)}</p>
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Noches</p>
            <p className="font-medium">{reservation.nights_count ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Personas</p>
            <p className="flex items-center gap-1 font-medium"><UsersIcon className="h-3 w-3" /> {reservation.guests}</p>
          </div>
          {reservation.status === 'pre_reserved' && reservation.expires_at && (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Vencimiento hold</p>
              <p className={`flex items-center gap-1 text-xs font-medium ${expired ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}>
                <ClockIcon className="h-3 w-3" /> {formatDateTime(reservation.expires_at)}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Precio */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <BanknoteIcon className="h-3 w-3" /> Precio
        </div>
        <div className="rounded-lg border p-3 space-y-1.5 text-sm">
          {reservation.pricing_mode_snapshot && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Modo</span>
              <span className="capitalize">{reservation.pricing_mode_snapshot}</span>
            </div>
          )}
          {reservation.nightly_price_snapshot != null && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Por noche</span>
              <span>{formatAmount(reservation.nightly_price_snapshot, currency)}</span>
            </div>
          )}
          {reservation.nights_count != null && reservation.nightly_price_snapshot != null && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{reservation.nights_count} noches</span>
              <span>{formatAmount(reservation.subtotal_amount, currency)}</span>
            </div>
          )}
          {(reservation.fees_amount ?? 0) > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Limpieza / fees</span>
              <span>{formatAmount(reservation.fees_amount, currency)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold border-t pt-1.5 mt-1">
            <span>Total</span>
            <span>{formatAmount(reservation.total_amount, currency)}</span>
          </div>
          {reservation.deposit_required_amount != null && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Seña requerida</span>
              <span>{formatAmount(reservation.deposit_required_amount, currency)}</span>
            </div>
          )}
        </div>
      </section>

      {/* Notas del cliente */}
      {(reservation.customer_notes || reservation.notes) && (
        <section className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <StickyNoteIcon className="h-3 w-3" /> Notas del cliente
          </div>
          <div className="rounded-lg border p-3 text-sm text-muted-foreground whitespace-pre-wrap">
            {reservation.customer_notes ?? reservation.notes}
          </div>
        </section>
      )}

      {/* Origen / metadata */}
      <section className="space-y-1 pb-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {reservation.source === 'ai' ? (
            <span className="inline-flex items-center gap-1"><BotIcon className="h-3 w-3" /> Creada por IA</span>
          ) : (
            <span className="inline-flex items-center gap-1"><HomeIcon className="h-3 w-3" /> Creada manualmente</span>
          )}
          <span>·</span>
          <span>{formatDateTime(reservation.created_at)}</span>
        </div>
        <p className="text-[10px] text-muted-foreground/50 font-mono"># {reservation.id.slice(0, 8).toUpperCase()}</p>
      </section>
    </div>
  )
}

// ─── Generate receipt dialog ──────────────────────────────────────────────────

function GenerateReceiptDialog({
  mode,
  reservation,
  open,
  onClose,
  onSuccess,
}: {
  mode:        'deposit' | 'full'
  reservation: ReservationWithDetails
  open:        boolean
  onClose:     () => void
  onSuccess:   (result: GenerateReceiptResult) => void
}) {
  const [notes,    setNotes]    = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setNotes('')
    setError(null)
  }, [open])

  async function handleGenerate() {
    setIsSaving(true)
    setError(null)
    const res = await generateReservationReceiptAction({
      reservationId: reservation.id,
      receiptKind:   mode,
      notes:         notes.trim() || undefined,
    })
    setIsSaving(false)
    if (res.success && res.data) {
      toast.success('Recibo generado.')
      onSuccess(res.data)
    } else if (!res.success) {
      setError(res.error)
    }
  }

  const title   = mode === 'deposit' ? 'Generar recibo de seña' : 'Generar recibo de pago completo'
  const currency = reservation.price_currency ?? reservation.currency ?? 'ARS'
  const amount   = mode === 'deposit'
    ? (reservation.amount_paid ?? reservation.deposit_required_amount)
    : reservation.amount_paid

  const amtDisplay = amount != null
    ? new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
    : '—'

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            Esto genera un PDF y lo guarda en la reserva. No se enviará automáticamente.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/30 px-3 py-2.5 space-y-1 text-xs">
            <p className="text-muted-foreground">Monto a reflejar en el recibo</p>
            <p className="font-semibold text-sm text-emerald-700 dark:text-emerald-400">{amtDisplay}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Nota del recibo (opcional)</Label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              maxLength={1000}
              disabled={isSaving}
              className="text-sm resize-none"
              placeholder="Ej: Transferencia bancaria confirmada"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>Cancelar</Button>
          <Button size="sm" onClick={handleGenerate} disabled={isSaving} className="gap-1.5">
            <ReceiptIcon className="h-3.5 w-3.5" />
            {isSaving ? 'Generando…' : 'Generar PDF'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Tab: Pago ────────────────────────────────────────────────────────────────

function PaymentTab({
  reservation,
  canConfirm,
  onReceiptCreated,
}: {
  reservation:      ReservationWithDetails
  canConfirm:       boolean
  onReceiptCreated?: () => void
}) {
  const currency = reservation.price_currency ?? reservation.currency ?? 'ARS'

  // realStatus: server-confirmed status. Updated only after a successful save.
  // Drives receipt button enablement — immune to Select dropdown changes.
  const [realStatus,    setRealStatus]    = useState(reservation.payment_status ?? 'pending')
  const [paymentStatus, setPaymentStatus] = useState(reservation.payment_status ?? 'pending')
  const [amountPaid,    setAmountPaid]    = useState(String(reservation.amount_paid ?? 0))
  const [documentId,    setDocumentId]    = useState('')
  const [paymentNotes,  setPaymentNotes]  = useState(reservation.payment_notes ?? '')
  const [depositPaidAt, setDepositPaidAt] = useState(reservation.deposit_paid_at)
  const [paidAt,        setPaidAt]        = useState(reservation.paid_at)
  const [docs,          setDocs]          = useState<PaymentProofDoc[]>([])
  const [docsLoading,   setDocsLoading]   = useState(false)
  const [isPending,     start]            = useTransition()
  const [receiptDeposOpen, setReceiptDeposOpen] = useState(false)
  const [receiptFullOpen,  setReceiptFullOpen]  = useState(false)

  useEffect(() => {
    setDocsLoading(true)
    getReservationPaymentProofsAction(reservation.id)
      .then(res => { if (res.success && res.data) setDocs(res.data) })
      .finally(() => setDocsLoading(false))
  }, [reservation.id])

  function applyServerResult(result: MarkPaymentResult) {
    setRealStatus(result.paymentStatus)
    setPaymentStatus(result.paymentStatus)
    setAmountPaid(String(result.amountPaid ?? amountPaid))
    if (result.paymentNotes !== null) setPaymentNotes(result.paymentNotes ?? '')
    if (result.depositPaidAt) setDepositPaidAt(result.depositPaidAt)
    if (result.paidAt) setPaidAt(result.paidAt)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    start(async () => {
      const r = await saveReservationPaymentManualAction({
        reservationId: reservation.id,
        paymentStatus,
        amountPaid:    Number(amountPaid) || 0,
        documentId:    documentId || undefined,
        notes:         paymentNotes.trim() || null,
      })
      if (r.success && r.data) {
        toast.success('Pago guardado.')
        applyServerResult(r.data)
      } else if (!r.success) {
        toast.error(r.error)
      }
    })
  }

  // Select locked once fully paid — can't downgrade.
  const selectLocked = realStatus === 'paid'
  // Show proof + amount fields only when a payment is being registered.
  const showProofAndAmount = paymentStatus === 'deposit_paid' || paymentStatus === 'paid'
  // Receipt buttons enabled based on server-confirmed state + timestamps.
  const canReceiptDeposit = realStatus === 'deposit_paid' || (realStatus === 'paid' && depositPaidAt != null)
  const canReceiptFull    = realStatus === 'paid' && paidAt != null

  return (
    <form onSubmit={handleSubmit} className="space-y-5 py-4">
      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        {reservation.deposit_required_amount != null && (
          <span className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs">
            Seña requerida: {formatAmount(reservation.deposit_required_amount, currency)}
          </span>
        )}
        {reservation.total_amount != null && (
          <span className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs">
            Total: {formatAmount(reservation.total_amount, currency)}
          </span>
        )}
      </div>

      {/* Estado de pago */}
      <div className="space-y-1.5">
        <Label className="text-xs">Estado de pago</Label>
        <Select value={paymentStatus} onValueChange={setPaymentStatus} disabled={!canConfirm || isPending || selectLocked}>
          <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent className="bg-background border shadow-md">
            {Object.entries(PAYMENT_STATUS_LABELS).map(([v, l]) => (
              <SelectItem key={v} value={v} className="text-sm">{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Monto + comprobante — solo para seña/pago completo */}
      {showProofAndAmount && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">Monto recibido ({currency})</Label>
            <Input
              type="number"
              min={0}
              step="any"
              value={amountPaid}
              onChange={e => setAmountPaid(e.target.value)}
              disabled={!canConfirm || isPending}
              className="h-8 text-sm w-40"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Comprobante (opcional)</Label>
            {docsLoading ? (
              <Skeleton className="h-8 w-full rounded-md" />
            ) : docs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No hay comprobantes guardados para esta reserva.</p>
            ) : (
              <select
                value={documentId}
                onChange={e => setDocumentId(e.target.value)}
                disabled={!canConfirm || isPending}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Sin comprobante</option>
                {docs.map(doc => (
                  <option key={doc.id} value={doc.id}>
                    {doc.name}{doc.notes ? ` — ${doc.notes}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        </>
      )}

      {/* Notas */}
      <div className="space-y-1.5">
        <Label className="text-xs">Notas de pago</Label>
        <Textarea
          value={paymentNotes}
          onChange={e => setPaymentNotes(e.target.value)}
          rows={3}
          maxLength={2000}
          disabled={!canConfirm || isPending}
          className="text-sm resize-none"
          placeholder="Transferencia recibida el …"
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Este registro es manual. No genera recibo ni envía WhatsApp automáticamente.
      </p>

      {canConfirm && (
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Guardando…' : 'Guardar pago'}
        </Button>
      )}

      {/* Timestamps */}
      {(depositPaidAt || paidAt) && (
        <div className="rounded-lg border p-3 space-y-1 text-xs text-muted-foreground">
          {depositPaidAt && <p>Seña registrada: {formatDateTime(depositPaidAt)}</p>}
          {paidAt && <p>Pago completo: {formatDateTime(paidAt)}</p>}
        </div>
      )}

      {/* Generar recibo */}
      {canConfirm && (
        <div className="border-t pt-4 space-y-2">
          <p className="text-xs text-muted-foreground font-medium">Generar recibo</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-xs gap-1.5"
              disabled={!canReceiptDeposit}
              onClick={() => setReceiptDeposOpen(true)}
            >
              <ReceiptIcon className="h-3.5 w-3.5" />
              Recibo de seña
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-xs gap-1.5"
              disabled={!canReceiptFull}
              onClick={() => setReceiptFullOpen(true)}
            >
              <ReceiptIcon className="h-3.5 w-3.5" />
              Recibo de pago completo
            </Button>
          </div>
          {!canReceiptDeposit && !canReceiptFull && (
            <p className="text-xs text-muted-foreground">
              Primero guardá la seña o el pago para generar el recibo.
            </p>
          )}
        </div>
      )}

      <GenerateReceiptDialog
        mode="deposit"
        reservation={reservation}
        open={receiptDeposOpen}
        onClose={() => setReceiptDeposOpen(false)}
        onSuccess={() => { setReceiptDeposOpen(false); onReceiptCreated?.() }}
      />
      <GenerateReceiptDialog
        mode="full"
        reservation={reservation}
        open={receiptFullOpen}
        onClose={() => setReceiptFullOpen(false)}
        onSuccess={() => { setReceiptFullOpen(false); onReceiptCreated?.() }}
      />
    </form>
  )
}

// ─── Tab: Notas internas ──────────────────────────────────────────────────────

function NotesTab({
  reservationId,
  open,
}: {
  reservationId: string
  open:          boolean
}) {
  const [notes, setNotes]         = useState<NoteRow[]>([])
  const [loading, setLoading]     = useState(false)
  const [content, setContent]     = useState('')
  const [isPending, start]        = useTransition()

  const fetchNotes = useCallback(async () => {
    setLoading(true)
    const r = await getReservationNotesAction(reservationId)
    if (r.success && r.data) setNotes(r.data)
    setLoading(false)
  }, [reservationId])

  useEffect(() => {
    if (open) fetchNotes()
  }, [open, fetchNotes])

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim()) return
    start(async () => {
      const r = await createReservationNoteAction({ reservation_id: reservationId, content: content.trim() })
      if (r.success) {
        if (r.data) {
          setNotes(prev => [...prev, r.data!])
          setContent('')
          toast.success('Nota guardada.')
        }
      } else {
        toast.error(r.error ?? 'Error al guardar.')
      }
    })
  }

  function handleDelete(noteId: string) {
    start(async () => {
      const r = await deleteReservationNoteAction(noteId, reservationId)
      if (r.success) {
        setNotes(prev => prev.filter(n => n.id !== noteId))
        toast.success('Nota eliminada.')
      } else {
        toast.error(r.error ?? 'Error al eliminar.')
      }
    })
  }

  return (
    <div className="space-y-4 py-4">
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      ) : notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin notas internas.</p>
      ) : (
        <div className="space-y-2">
          {notes.map(note => (
            <div key={note.id} className="rounded-lg border p-3 text-sm group">
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap leading-snug">{note.content}</p>
                <button
                  onClick={() => handleDelete(note.id)}
                  disabled={isPending}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {(note.author as { name?: string } | null)?.name ?? 'Sistema'} · {formatDateTime(note.created_at)}
              </p>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleCreate} className="space-y-2 border-t pt-4">
        <Textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={3}
          maxLength={5000}
          disabled={isPending}
          className="text-sm resize-none"
          placeholder="Agregar nota interna (no se envía al cliente)..."
        />
        <Button type="submit" size="sm" disabled={isPending || !content.trim()} className="gap-1.5">
          <PlusIcon className="h-3.5 w-3.5" />
          {isPending ? 'Guardando…' : 'Agregar nota'}
        </Button>
      </form>
    </div>
  )
}

// ─── Tab: Historial ───────────────────────────────────────────────────────────

function HistoryTab({
  reservationId,
  open,
}: {
  reservationId: string
  open:          boolean
}) {
  const [evts, setEvts]       = useState<ReservationEventRow[]>([])
  const [loading, setLoading] = useState(false)

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    const r = await getReservationEventsAction(reservationId)
    if (r.success && r.data) setEvts(r.data)
    setLoading(false)
  }, [reservationId])

  useEffect(() => {
    if (open) fetchEvents()
  }, [open, fetchEvents])

  return (
    <div className="space-y-2 py-4">
      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
        </div>
      ) : evts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin eventos registrados.</p>
      ) : (
        <ol className="relative border-l ml-3 space-y-4">
          {evts.map(evt => {
            const meta = evt.metadata as Record<string, unknown>
            const actor = (evt.actor as { name?: string } | null)?.name
            return (
              <li key={evt.id} className="ml-4">
                <div className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-background bg-muted-foreground/40" />
                <p className="text-sm font-medium leading-snug">
                  {EVENT_LABELS[evt.event_type] ?? evt.event_type}
                </p>
                {actor && <p className="text-xs text-muted-foreground">por {actor}</p>}
                {evt.event_type === 'rescheduled' && !!meta.old_start_date && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDate(meta.old_start_date as string)} – {formatDate(meta.old_end_date as string)}
                    {' → '}
                    {formatDate(meta.new_start_date as string)} – {formatDate(meta.new_end_date as string)}
                  </p>
                )}
                {evt.event_type === 'cancelled' && !!meta.reason && (
                  <p className="text-xs text-muted-foreground mt-0.5">&ldquo;{String(meta.reason)}&rdquo;</p>
                )}
                {evt.event_type === 'payment_updated' && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {PAYMENT_STATUS_LABELS[meta.old_payment_status as string] ?? String(meta.old_payment_status)} → {PAYMENT_STATUS_LABELS[meta.payment_status as string] ?? String(meta.payment_status)}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground/60 mt-0.5">{formatDateTime(evt.created_at)}</p>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

// ─── Tab: Comprobantes ───────────────────────────────────────────────────────

function ComprobantesTab({
  reservationId,
  open,
}: {
  reservationId: string
  open:          boolean
}) {
  const [docs, setDocs]       = useState<PaymentProofDoc[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    getReservationPaymentProofsAction(reservationId)
      .then((r) => { if (r.success && r.data) setDocs(r.data) })
      .finally(() => setLoading(false))
  }, [open, reservationId])

  return (
    <div className="space-y-3 py-4">
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
      ) : docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin comprobantes guardados.</p>
      ) : (
        <div className="space-y-2">
          {docs.map((doc) => {
            const href = doc.mime_type?.startsWith('image/')
              ? doc.file_url
              : `${doc.file_url}?download=1`
            return (
              <div key={doc.id} className="rounded-lg border p-3 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-snug truncate">{doc.name}</p>
                      {doc.notes && (
                        <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                          Nota: {doc.notes}
                        </p>
                      )}
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                        {formatDateTime(doc.created_at)}
                      </p>
                    </div>
                  </div>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    title="Ver comprobante"
                  >
                    <ExternalLinkIcon className="h-4 w-4" />
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Send receipt via WhatsApp dialog ────────────────────────────────────────

function SendReceiptWhatsAppDialog({
  receipt,
  contactPhone,
  open,
  onClose,
}: {
  receipt:      ReceiptDoc
  contactPhone: string | null
  open:         boolean
  onClose:      () => void
}) {
  const [caption,   setCaption]   = useState('')
  const [isSending, setIsSending] = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setCaption('')
    setError(null)
  }, [open])

  async function handleSend() {
    setIsSending(true)
    setError(null)
    try {
      const res = await sendReceiptDocumentByWhatsAppAction({
        documentId:    receipt.id,
        customCaption: caption.trim() || undefined,
      })
      if (res.success) {
        if ('warning' in res && res.warning) {
          toast.success(`Recibo enviado por WhatsApp. ${res.warning}`)
        } else {
          toast.success('Recibo enviado por WhatsApp.')
        }
        onClose()
      } else {
        setError(res.error)
      }
    } catch {
      setError('Error inesperado. Revisá la conexión e intentá de nuevo.')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Enviar recibo por WhatsApp</DialogTitle>
          <DialogDescription className="text-xs">
            Esto enviará el PDF al cliente directamente por WhatsApp. No se generará un recibo nuevo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/30 px-3 py-2.5 space-y-0.5 text-xs">
            <p className="text-muted-foreground">Recibo</p>
            <p className="font-medium text-sm">{receipt.name}</p>
            {receipt.receipt_number && (
              <p className="text-muted-foreground font-mono">{receipt.receipt_number}</p>
            )}
          </div>
          {contactPhone && (
            <div className="rounded-lg border bg-muted/30 px-3 py-2.5 space-y-0.5 text-xs">
              <p className="text-muted-foreground">Destinatario</p>
              <p className="font-medium">{contactPhone}</p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Mensaje de acompañamiento (opcional)</Label>
            <Textarea
              value={caption}
              onChange={e => setCaption(e.target.value)}
              rows={3}
              maxLength={1000}
              disabled={isSending}
              className="text-sm resize-none"
              placeholder="Te enviamos el recibo de tu reserva. Cualquier consulta, respondé por este chat."
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isSending}>Cancelar</Button>
          <Button size="sm" onClick={handleSend} disabled={isSending} className="gap-1.5">
            <SendIcon className="h-3.5 w-3.5" />
            {isSending ? 'Enviando…' : 'Enviar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Tab: Recibos ────────────────────────────────────────────────────────────

function RecibosTab({
  reservationId,
  open,
  canConfirm,
  contactPhone,
  refreshKey,
}: {
  reservationId: string
  open:          boolean
  canConfirm:    boolean
  contactPhone:  string | null
  refreshKey?:   number
}) {
  const [receipts,         setReceipts]         = useState<ReceiptDoc[]>([])
  const [loading,          setLoading]          = useState(false)
  const [sendDialogReceipt, setSendDialogReceipt] = useState<ReceiptDoc | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    getReservationReceiptsAction(reservationId)
      .then(r => { if (r.success && r.data) setReceipts(r.data) })
      .finally(() => setLoading(false))
  }, [open, reservationId, refreshKey])

  return (
    <div className="space-y-3 py-4">
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
      ) : receipts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <ReceiptIcon className="mb-2 h-7 w-7 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Sin recibos generados.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {receipts.map(r => (
            <div key={r.id} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <ReceiptIcon className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug truncate">{r.name}</p>
                    {r.receipt_number && (
                      <p className="text-xs text-muted-foreground font-mono">{r.receipt_number}</p>
                    )}
                    {r.notes && (
                      <p className="text-xs text-muted-foreground mt-0.5 leading-snug">Nota: {r.notes}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                      {formatDateTime(r.created_at)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <a
                    href={r.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Ver recibo"
                  >
                    <ExternalLinkIcon className="h-4 w-4" />
                  </a>
                  <a
                    href={`${r.file_url}?download=1`}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Descargar recibo"
                  >
                    <DownloadIcon className="h-4 w-4" />
                  </a>
                </div>
              </div>
              {canConfirm && (
                <button
                  type="button"
                  onClick={() => setSendDialogReceipt(r)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <SendIcon className="h-3.5 w-3.5" />
                  Enviar por WhatsApp
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {sendDialogReceipt && (
        <SendReceiptWhatsAppDialog
          receipt={sendDialogReceipt}
          contactPhone={contactPhone}
          open={!!sendDialogReceipt}
          onClose={() => setSendDialogReceipt(null)}
        />
      )}
    </div>
  )
}

// ─── Main drawer ──────────────────────────────────────────────────────────────

interface ReservationDetailDrawerProps {
  reservation: ReservationWithDetails | null
  open:        boolean
  onClose:     () => void
  canConfirm:  boolean
}

export function ReservationDetailDrawer({
  reservation,
  open,
  onClose,
  canConfirm,
}: ReservationDetailDrawerProps) {
  const [cancelOpen,     setCancelOpen]     = useState(false)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [isPending, start]                  = useTransition()
  const [receiptKey,     setReceiptKey]     = useState(0)

  if (!reservation) return null

  const today      = todayStr()
  const expired    = isExpiredPending(reservation)
  const pastConf   = isPastConfirmed(reservation, today)
  const shortId    = reservation.id.slice(0, 6).toUpperCase()

  const canConfirm_   = reservation.status === 'pre_reserved' && canConfirm
  const canComplete   = reservation.status === 'confirmed' && pastConf && canConfirm
  const canReschedule = (reservation.status === 'pre_reserved' || reservation.status === 'confirmed') && canConfirm
  const canCancel     = reservation.status !== 'cancelled' && reservation.status !== 'completed' && canConfirm

  function handleConfirm() {
    start(async () => {
      const r = await confirmReservationAction(reservation!.id)
      if (r.success) toast.success('Reserva confirmada.')
      else toast.error(r.error)
    })
  }

  function handleComplete() {
    start(async () => {
      const r = await completeReservationAction(reservation!.id)
      if (r.success) toast.success('Reserva marcada como completada.')
      else toast.error(r.error)
    })
  }

  return (
    <>
      <Sheet open={open} onOpenChange={v => { if (!v) onClose() }}>
        <SheetContent
          side="right"
          className="w-full sm:w-[560px] sm:max-w-[560px] flex flex-col p-0 gap-0 overflow-hidden"
        >
          {/* Header */}
          <SheetHeader className="border-b px-5 py-4 shrink-0">
            <div className="flex items-start gap-3 pr-8">
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <SheetTitle className="text-sm font-mono text-muted-foreground">
                    #{shortId}
                  </SheetTitle>
                  <ReservationStatusBadge
                    status={reservation.status}
                    expired={expired}
                    pastConfirmed={pastConf}
                  />
                  {reservation.source === 'ai' && (
                    <span className="inline-flex items-center gap-0.5 rounded border border-blue-200 bg-blue-50 px-1 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-400">
                      <BotIcon className="h-2.5 w-2.5" /> IA
                    </span>
                  )}
                </div>
                {/* Action buttons */}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {canConfirm_ && (
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-green-700 border-green-200 hover:bg-green-50" onClick={handleConfirm} disabled={isPending}>
                      <CheckCircle2Icon className="h-3 w-3" /> Confirmar
                    </Button>
                  )}
                  {canComplete && (
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-purple-700 border-purple-200 hover:bg-purple-50" onClick={handleComplete} disabled={isPending}>
                      <CheckCheckIcon className="h-3 w-3" /> Completar
                    </Button>
                  )}
                  {canReschedule && (
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setRescheduleOpen(true)} disabled={isPending}>
                      <CalendarArrowUpIcon className="h-3 w-3" /> Reprogramar
                    </Button>
                  )}
                  {canCancel && (
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-destructive border-destructive/30 hover:bg-destructive/5" onClick={() => setCancelOpen(true)} disabled={isPending}>
                      <XCircleIcon className="h-3 w-3" /> Cancelar
                    </Button>
                  )}
                  {reservation.conversation_id && (
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1" asChild>
                      <Link href={`/dashboard/conversations/${reservation.conversation_id}`}>
                        <MessageSquareIcon className="h-3 w-3" /> Chat
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </SheetHeader>

          {/* Tabs */}
          <div className="flex-1 overflow-y-auto">
            <Tabs defaultValue="detail" className="h-full flex flex-col">
              <TabsList className="w-full justify-start rounded-none border-b bg-transparent h-auto px-5 py-0 shrink-0">
                <TabsTrigger value="detail"        className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 pt-3 text-xs">Detalle</TabsTrigger>
                <TabsTrigger value="payment"       className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 pt-3 text-xs">Pago</TabsTrigger>
                <TabsTrigger value="comprobantes"  className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 pt-3 text-xs">Comprobantes</TabsTrigger>
                <TabsTrigger value="recibos"       className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 pt-3 text-xs">Recibos</TabsTrigger>
                <TabsTrigger value="notes"         className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 pt-3 text-xs">Notas</TabsTrigger>
                <TabsTrigger value="history"       className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent pb-2 pt-3 text-xs">
                  <HistoryIcon className="h-3 w-3 mr-1" /> Historial
                </TabsTrigger>
              </TabsList>
              <div className="flex-1 overflow-y-auto px-5">
                <TabsContent value="detail"       className="mt-0 h-full"><DetailTab reservation={reservation} /></TabsContent>
                <TabsContent value="payment"      className="mt-0 h-full"><PaymentTab reservation={reservation} canConfirm={canConfirm} onReceiptCreated={() => setReceiptKey(k => k + 1)} /></TabsContent>
                <TabsContent value="comprobantes" className="mt-0 h-full"><ComprobantesTab reservationId={reservation.id} open={open} /></TabsContent>
                <TabsContent value="recibos"      className="mt-0 h-full"><RecibosTab reservationId={reservation.id} open={open} canConfirm={canConfirm} contactPhone={reservation.contact?.phone ?? null} refreshKey={receiptKey} /></TabsContent>
                <TabsContent value="notes"        className="mt-0 h-full"><NotesTab reservationId={reservation.id} open={open} /></TabsContent>
                <TabsContent value="history"      className="mt-0 h-full"><HistoryTab reservationId={reservation.id} open={open} /></TabsContent>
              </div>
            </Tabs>
          </div>
        </SheetContent>
      </Sheet>

      {cancelOpen && (
        <CancelDialog reservationId={reservation.id} open={cancelOpen} onClose={() => setCancelOpen(false)} />
      )}
      {rescheduleOpen && (
        <RescheduleDialog reservation={reservation} open={rescheduleOpen} onClose={() => setRescheduleOpen(false)} />
      )}
    </>
  )
}

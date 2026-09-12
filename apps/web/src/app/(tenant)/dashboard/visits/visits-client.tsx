'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CalendarClockIcon,
  UserIcon,
  BuildingIcon,
  CheckCircle2Icon,
  XCircleIcon,
  CalendarIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  rescheduleVisitAction,
  completeVisitAction,
  cancelVisitAction,
} from '@/actions/property-visits'
import type { PropertyVisitListItem, VisitFilter } from '@/lib/repositories/property-visits.repository'
import {
  buildSnapshotLines,
  displayContactName,
  formatVisitMoment,
  timezoneCityLabel,
  visitStatusLabel,
  visitStatusTone,
} from '@/lib/operation-requests/presentation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const FILTERS = [
  { value: 'upcoming',  label: 'Próximas'  },
  { value: 'scheduled', label: 'Agendadas' },
  { value: 'completed', label: 'Realizadas' },
  { value: 'cancelled', label: 'Canceladas' },
  { value: 'all',       label: 'Todas'     },
] as const

const TONE_CLASSES: Record<string, string> = {
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  green: 'bg-green-100 text-green-800 border-green-200',
  red:   'bg-red-100 text-red-700 border-red-200',
  zinc:  'bg-zinc-100 text-zinc-700 border-zinc-200',
}

// Layout de las acciones de un diálogo.
//
// El defecto que corrige: Button trae `whitespace-nowrap`, así que los botones
// no encogen ni parten su texto. Tres de ellos en una fila sin `flex-wrap`
// dentro de un DialogContent de ancho fijo desbordaban, y como el contenedor
// tiene overflow, eso aparecía como scroll horizontal con "Marcar como
// realizada" cortado.
//
//   móvil   → apilados, cada uno al ancho completo
//   desktop → en fila, alineados a la derecha, y si no entran ENVUELVEN a una
//             segunda línea en vez de desbordar
//
// `sm:space-x-0` neutraliza el `sm:space-x-2` que trae DialogFooter por
// defecto, que se sumaba al gap y empeoraba el ancho.
const ACCIONES =
  'mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:space-x-0'

/** Nombre para la fila: el del contacto, el del formulario, o el teléfono. */
function nombreODefecto(v: PropertyVisitListItem): string {
  const nombre = displayContactName(v.contact?.name, v.request?.payload_snapshot)
  if (nombre !== 'Sin nombre') return nombre
  return v.contact?.phone ?? 'Sin contacto'
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[visitStatusTone(status)]}`}>
      {visitStatusLabel(status)}
    </span>
  )
}

/**
 * Lo que el cliente había pedido, para poder compararlo con lo agendado.
 * Sale de la FormDefinition real vía buildSnapshotLines — sin duplicar labels.
 */
function preferenciaOriginal(v: PropertyVisitListItem): string | null {
  if (!v.request?.payload_snapshot) return null
  const lines = buildSnapshotLines('property_visit', v.request.payload_snapshot, [
    'preferred_date', 'preferred_time_range',
  ])
  if (lines.length === 0) return null
  return lines.map((l) => l.value).join(' · ')
}

export function VisitsClient({
  visits,
  canManage,
  activeFilter,
}: {
  visits:       PropertyVisitListItem[]
  canManage:    boolean
  activeFilter: VisitFilter
}) {
  const router = useRouter()
  const [selected,    setSelected]    = useState<PropertyVisitListItem | null>(null)
  const [rescheduling, setRescheduling] = useState<PropertyVisitListItem | null>(null)
  const [cancelling,  setCancelling]  = useState<PropertyVisitListItem | null>(null)
  const [newDate, setNewDate] = useState('')
  const [newTime, setNewTime] = useState('')
  const [reason,  setReason]  = useState('')
  const [pending, startTransition] = useTransition()

  function cerrarTodo() {
    setSelected(null); setRescheduling(null); setCancelling(null)
    setNewDate(''); setNewTime(''); setReason('')
  }

  function reagendar(v: PropertyVisitListItem) {
    startTransition(async () => {
      const r = await rescheduleVisitAction(v.id, newDate, newTime)
      if (r.success) { toast.success('Visita reagendada.'); cerrarTodo(); router.refresh() }
      else { toast.error(r.error); router.refresh() }
    })
  }

  function completar(v: PropertyVisitListItem) {
    startTransition(async () => {
      const r = await completeVisitAction(v.id)
      if (r.success) { toast.success('Visita marcada como realizada.'); cerrarTodo(); router.refresh() }
      else { toast.error(r.error); router.refresh() }
    })
  }

  function cancelar(v: PropertyVisitListItem) {
    startTransition(async () => {
      const r = await cancelVisitAction(v.id, reason)
      if (r.success) { toast.success('Visita cancelada.'); cerrarTodo(); router.refresh() }
      else { toast.error(r.error); router.refresh() }
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Filtros ── */}
      <div className="flex gap-2 overflow-x-auto border-b px-4 py-3 sm:px-6">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => router.push(`/dashboard/visits?filter=${f.value}`)}
            className={`shrink-0 rounded-full px-3 py-1 text-sm transition ${
              activeFilter === f.value
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Listado cronológico ── */}
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        {visits.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <CalendarClockIcon className="h-10 w-10 text-zinc-300" />
            <p className="mt-3 text-sm text-muted-foreground">
              {activeFilter === 'upcoming'
                ? 'No hay visitas próximas.'
                : 'No hay visitas para este filtro.'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Las visitas se agendan desde Solicitudes.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visits.map((v) => (
              <button
                key={v.id}
                onClick={() => setSelected(v)}
                className="flex w-full flex-col gap-2 rounded-xl border bg-white p-4 text-left transition hover:border-zinc-300 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {formatVisitMoment(v.scheduled_for, v.timezone_snapshot)}
                    </div>
                    <div className="truncate text-sm text-muted-foreground">
                      {v.property?.title ?? 'Propiedad no disponible'}
                    </div>
                  </div>
                  <StatusBadge status={v.status} />
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <UserIcon className="h-3.5 w-3.5" />
                    {nombreODefecto(v)}
                  </span>
                  {v.property && (
                    <span className="inline-flex items-center gap-1">
                      <BuildingIcon className="h-3.5 w-3.5" />
                      {v.property.title}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Detalle ── */}
      <Dialog open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  Visita
                  <StatusBadge status={selected.status} />
                </DialogTitle>
                <DialogDescription className="space-y-0.5">
                  <span className="block">
                    {formatVisitMoment(selected.scheduled_for, selected.timezone_snapshot)}
                  </span>
                  {/* La zona se muestra legible, pero la fuente de verdad sigue
                      siendo timezone_snapshot: esto solo la traduce a ciudad. */}
                  <span className="block text-xs">
                    Hora local: {timezoneCityLabel(selected.timezone_snapshot)}
                  </span>
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-lg border bg-zinc-50 p-3 text-sm">
                  <div className="font-medium">
                    {displayContactName(selected.contact?.name, selected.request?.payload_snapshot)}
                  </div>
                  {selected.contact?.phone && (
                    <div className="text-muted-foreground">{selected.contact.phone}</div>
                  )}
                  {selected.property && (
                    <div className="mt-1 text-muted-foreground">{selected.property.title}</div>
                  )}
                </div>

                {/* La preferencia original, para contrastar con lo acordado. */}
                {preferenciaOriginal(selected) && (
                  <p className="text-xs text-muted-foreground">
                    El cliente había pedido: {preferenciaOriginal(selected)}.
                  </p>
                )}

                {selected.scheduler?.name && (
                  <p className="text-xs text-muted-foreground">
                    Agendada por {selected.scheduler.name}.
                  </p>
                )}

                {selected.status === 'completed' && selected.completed_at && (
                  <div className="rounded-lg border bg-green-50 p-3 text-sm text-green-800">
                    Realizada el {formatVisitMoment(selected.completed_at, selected.timezone_snapshot)}.
                  </div>
                )}

                {selected.status === 'cancelled' && (
                  <div className="rounded-lg border bg-zinc-50 p-3 text-sm">
                    <div className="font-medium">Cancelada</div>
                    {selected.cancelled_at && (
                      <div className="text-muted-foreground">
                        {formatVisitMoment(selected.cancelled_at, selected.timezone_snapshot)}
                      </div>
                    )}
                    {selected.cancellation_reason && (
                      <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                        {selected.cancellation_reason}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Acciones: solo mientras sigue agendada. */}
              {selected.status === 'scheduled' && canManage && (
                <DialogFooter className={ACCIONES}>
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      setRescheduling(selected)
                      setNewDate(''); setNewTime('')
                    }}
                    disabled={pending}
                  >
                    <CalendarIcon className="mr-1.5 h-4 w-4" />
                    Reagendar
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => { setCancelling(selected); setReason('') }}
                    disabled={pending}
                  >
                    <XCircleIcon className="mr-1.5 h-4 w-4" />
                    Cancelar
                  </Button>
                  <Button
                    className="w-full sm:w-auto"
                    onClick={() => completar(selected)}
                    disabled={pending}
                  >
                    <CheckCircle2Icon className="mr-1.5 h-4 w-4" />
                    {pending ? 'Guardando…' : 'Marcar como realizada'}
                  </Button>
                </DialogFooter>
              )}

              {selected.status === 'scheduled' && !canManage && (
                <p className="text-sm text-muted-foreground">
                  No tenés permiso para gestionar visitas. Pedile a un owner que te habilite “Gestionar visitas”.
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Reagendar ── */}
      <Dialog open={rescheduling !== null} onOpenChange={(o) => !o && setRescheduling(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reagendar la visita</DialogTitle>
            <DialogDescription>
              Elegí la fecha y la hora nuevas. Se interpretan en la zona horaria de tu
              organización. La solicitud original del cliente no cambia.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="re-date" className="text-xs">Fecha *</Label>
              <Input id="re-date" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="re-time" className="text-xs">Hora *</Label>
              <Input id="re-time" type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} required />
            </div>
          </div>

          <DialogFooter className={ACCIONES}>
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setRescheduling(null)}
              disabled={pending}
            >
              Cancelar
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={() => rescheduling && reagendar(rescheduling)}
              disabled={pending || !newDate || !newTime}
            >
              {pending ? 'Guardando…' : 'Reagendar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Cancelar ── */}
      <Dialog open={cancelling !== null} onOpenChange={(o) => !o && setCancelling(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancelar la visita</DialogTitle>
            <DialogDescription>
              La visita queda cancelada. La solicitud sigue figurando como agendada en su
              momento: cancelar la cita no reescribe esa decisión. El cliente no recibe un
              aviso automático todavía.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Motivo (opcional)</Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Por qué se cancela"
            />
            <p className="text-xs text-muted-foreground">{reason.length}/500</p>
          </div>

          <DialogFooter className={ACCIONES}>
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setCancelling(null)}
              disabled={pending}
            >
              Volver
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              onClick={() => cancelling && cancelar(cancelling)}
              disabled={pending}
            >
              {pending ? 'Guardando…' : 'Cancelar visita'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

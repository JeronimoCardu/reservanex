'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  UtensilsCrossedIcon,
  UserIcon,
  UsersIcon,
  CheckCircle2Icon,
  XCircleIcon,
  CalendarIcon,
  UserXIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  editTableReservationAction,
  completeTableReservationAction,
  cancelTableReservationAction,
  markTableReservationNoShowAction,
} from '@/actions/table-reservations'
import type {
  TableReservationListItem,
  TableReservationFilter,
} from '@/lib/repositories/table-reservations.repository'
import {
  buildSnapshotLines,
  displayContactName,
  formatVisitMoment,
  tableReservationStatusLabel,
  tableReservationStatusTone,
  timezoneCityLabel,
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
  { value: 'upcoming',  label: 'Próximas'   },
  { value: 'confirmed', label: 'Confirmadas' },
  { value: 'completed', label: 'Realizadas' },
  { value: 'cancelled', label: 'Canceladas' },
  { value: 'no_show',   label: 'No asistió' },
  { value: 'all',       label: 'Todas'      },
] as const

const TONE_CLASSES: Record<string, string> = {
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  green: 'bg-green-100 text-green-800 border-green-200',
  red:   'bg-red-100 text-red-700 border-red-200',
  zinc:  'bg-zinc-100 text-zinc-700 border-zinc-200',
}

// Mismo layout de acciones que las visitas: en móvil apiladas al ancho
// completo, en desktop en fila y envolviendo si no entran. Button trae
// whitespace-nowrap, así que sin flex-wrap cuatro botones desbordarían.
const ACCIONES =
  'mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:space-x-0'

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tableReservationStatusTone(status)]}`}>
      {tableReservationStatusLabel(status)}
    </span>
  )
}

/** Nombre del cliente: el del contacto, el del formulario, o el teléfono. */
function nombreODefecto(r: TableReservationListItem): string {
  const nombre = displayContactName(r.contact?.name, r.request?.payload_snapshot)
  if (nombre !== 'Sin nombre') return nombre
  return r.contact?.phone ?? 'Sin contacto'
}

/**
 * Lo que el cliente había pedido, para contrastarlo con lo acordado.
 * Sale de la FormDefinition real vía buildSnapshotLines — sin duplicar labels.
 */
function loSolicitado(r: TableReservationListItem): string | null {
  if (!r.request?.payload_snapshot) return null
  const lines = buildSnapshotLines('table_reservation', r.request.payload_snapshot, [
    'date', 'time', 'people',
  ])
  if (lines.length === 0) return null
  return lines.map((l) => l.value).join(' · ')
}

export function TableReservationsClient({
  reservations,
  canManage,
  activeFilter,
}: {
  reservations: TableReservationListItem[]
  canManage:    boolean
  activeFilter: TableReservationFilter
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<TableReservationListItem | null>(null)
  const [editing,  setEditing]  = useState<TableReservationListItem | null>(null)
  const [cancelling, setCancelling] = useState<TableReservationListItem | null>(null)
  const [newDate, setNewDate] = useState('')
  const [newTime, setNewTime] = useState('')
  const [newParty, setNewParty] = useState('')
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()

  function cerrarTodo() {
    setSelected(null); setEditing(null); setCancelling(null)
    setNewDate(''); setNewTime(''); setNewParty(''); setReason('')
  }

  function correr(fn: () => Promise<{ success: boolean; error?: string }>, ok: string) {
    startTransition(async () => {
      const r = await fn()
      if (r.success) { toast.success(ok); cerrarTodo(); router.refresh() }
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
            onClick={() => router.push(`/dashboard/table-reservations?filter=${f.value}`)}
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
        {reservations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <UtensilsCrossedIcon className="h-10 w-10 text-zinc-300" />
            <p className="mt-3 text-sm text-muted-foreground">
              {activeFilter === 'upcoming'
                ? 'No hay reservas próximas.'
                : 'No hay reservas para este filtro.'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Las reservas se confirman desde Solicitudes.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {reservations.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r)}
                className="flex w-full flex-col gap-2 rounded-xl border bg-white p-4 text-left transition hover:border-zinc-300 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {formatVisitMoment(r.scheduled_for, r.timezone_snapshot)}
                    </div>
                    <div className="truncate text-sm text-muted-foreground">
                      {nombreODefecto(r)}
                    </div>
                  </div>
                  <StatusBadge status={r.status} />
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <UsersIcon className="h-3.5 w-3.5" />
                    {r.party_size} persona{r.party_size !== 1 ? 's' : ''}
                  </span>
                  {r.contact?.phone && (
                    <span className="inline-flex items-center gap-1">
                      <UserIcon className="h-3.5 w-3.5" />
                      {r.contact.phone}
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
                  Reserva de mesa
                  <StatusBadge status={selected.status} />
                </DialogTitle>
                <DialogDescription className="space-y-0.5">
                  <span className="block">
                    {formatVisitMoment(selected.scheduled_for, selected.timezone_snapshot)}
                    {' · '}{selected.party_size} persona{selected.party_size !== 1 ? 's' : ''}
                  </span>
                  <span className="block text-xs">
                    Hora local: {timezoneCityLabel(selected.timezone_snapshot)}
                  </span>
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-lg border bg-zinc-50 p-3 text-sm">
                  <div className="font-medium">{nombreODefecto(selected)}</div>
                  {selected.contact?.phone && (
                    <div className="text-muted-foreground">{selected.contact.phone}</div>
                  )}
                </div>

                {/* Lo acordado vs lo pedido: la distinción que define la fase. */}
                {loSolicitado(selected) && (
                  <p className="text-xs text-muted-foreground">
                    El cliente había pedido: {loSolicitado(selected)}.
                  </p>
                )}

                {selected.confirmer?.name && (
                  <p className="text-xs text-muted-foreground">
                    Confirmada por {selected.confirmer.name}.
                  </p>
                )}

                {selected.status === 'completed' && selected.completed_at && (
                  <div className="rounded-lg border bg-green-50 p-3 text-sm text-green-800">
                    Realizada el {formatVisitMoment(selected.completed_at, selected.timezone_snapshot)}.
                  </div>
                )}

                {selected.status === 'no_show' && selected.no_show_at && (
                  <div className="rounded-lg border bg-red-50 p-3 text-sm text-red-700">
                    El cliente no se presentó. Registrado el{' '}
                    {formatVisitMoment(selected.no_show_at, selected.timezone_snapshot)}.
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

              {/* Acciones: solo mientras sigue confirmada. */}
              {selected.status === 'confirmed' && canManage && (
                <DialogFooter className={ACCIONES}>
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      setEditing(selected)
                      setNewDate(''); setNewTime(''); setNewParty(String(selected.party_size))
                    }}
                    disabled={pending}
                  >
                    <CalendarIcon className="mr-1.5 h-4 w-4" />
                    Editar
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
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => correr(
                      () => markTableReservationNoShowAction(selected.id),
                      'Marcada como ausencia.',
                    )}
                    disabled={pending}
                  >
                    <UserXIcon className="mr-1.5 h-4 w-4" />
                    No asistió
                  </Button>
                  <Button
                    className="w-full sm:w-auto"
                    onClick={() => correr(
                      () => completeTableReservationAction(selected.id),
                      'Reserva marcada como realizada.',
                    )}
                    disabled={pending}
                  >
                    <CheckCircle2Icon className="mr-1.5 h-4 w-4" />
                    {pending ? 'Guardando…' : 'Marcar como realizada'}
                  </Button>
                </DialogFooter>
              )}

              {selected.status === 'confirmed' && !canManage && (
                <p className="text-sm text-muted-foreground">
                  No tenés permiso para gestionar reservas de mesa. Pedile a un owner que te habilite “Gestionar reservas de mesa”.
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Editar ── */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Editar la reserva</DialogTitle>
            <DialogDescription>
              Cambiá la fecha, la hora o la cantidad de personas. Se interpreta en la
              zona horaria de tu organización. Lo que pidió el cliente originalmente no
              cambia.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ed-date" className="text-xs">Fecha *</Label>
              <Input id="ed-date" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ed-time" className="text-xs">Hora *</Label>
              <Input id="ed-time" type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ed-party" className="text-xs">Personas *</Label>
              <Input
                id="ed-party" type="number" min={1} max={50}
                value={newParty} onChange={(e) => setNewParty(e.target.value)} required
              />
            </div>
          </div>

          <DialogFooter className={ACCIONES}>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setEditing(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={() => editing && correr(
                () => editTableReservationAction(editing.id, newDate, newTime, Number(newParty) || undefined),
                'Reserva actualizada.',
              )}
              disabled={pending || !newDate || !newTime || !newParty}
            >
              {pending ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Cancelar ── */}
      <Dialog open={cancelling !== null} onOpenChange={(o) => !o && setCancelling(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancelar la reserva</DialogTitle>
            <DialogDescription>
              La reserva queda cancelada. La solicitud sigue figurando como reservada en
              su momento: cancelar no reescribe esa decisión. El cliente no recibe un
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
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setCancelling(null)} disabled={pending}>
              Volver
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              onClick={() => cancelling && correr(
                () => cancelTableReservationAction(cancelling.id, reason),
                'Reserva cancelada.',
              )}
              disabled={pending}
            >
              {pending ? 'Guardando…' : 'Cancelar reserva'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

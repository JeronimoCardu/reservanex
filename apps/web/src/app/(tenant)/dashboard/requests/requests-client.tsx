'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2Icon,
  XCircleIcon,
  ClockIcon,
  UserIcon,
  BuildingIcon,
  InboxIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { decideOperationRequestAction } from '@/actions/operation-requests'
import type { OperationRequestListItem, OperationRequestStatus } from '@/lib/repositories/operation-requests.repository'
import {
  buildSnapshotLines,
  intentTitle,
  kindLabel,
  statusLabel,
  statusTone,
} from '@/lib/operation-requests/presentation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const FILTERS = [
  { value: 'pending',   label: 'Pendientes' },
  { value: 'confirmed', label: 'Aprobadas'  },
  { value: 'rejected',  label: 'Rechazadas' },
  { value: 'all',       label: 'Todas'      },
] as const

const TONE_CLASSES: Record<string, string> = {
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  green: 'bg-green-100 text-green-800 border-green-200',
  red:   'bg-red-100 text-red-700 border-red-200',
  zinc:  'bg-zinc-100 text-zinc-700 border-zinc-200',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[statusTone(status)]}`}>
      {statusLabel(status)}
    </span>
  )
}

// Fase 3E-A — solo temporary_rental materializa una reserva al aprobarse.
// Los demás kinds siguen comportándose como en 3D, y el copy tiene que
// decir la verdad en cada caso.
function materializaReserva(op: OperationRequestListItem): boolean {
  return op.kind === 'reservation_request' && op.intent === 'temporary_rental'
}

// Sin propiedad asociada no se puede crear la reserva: la RPC devolvería
// missing_reservation_context. Se detecta antes para no ofrecer un botón que
// no puede funcionar (§17).
function faltaContexto(op: OperationRequestListItem): boolean {
  return materializaReserva(op) && !op.entity_title_snapshot
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function RequestsClient({
  requests,
  canDecide,
  activeFilter,
}: {
  requests:     OperationRequestListItem[]
  canDecide:    boolean
  activeFilter: OperationRequestStatus | 'all'
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<OperationRequestListItem | null>(null)
  // El rechazo pide confirmación explícita y motivo opcional (§12): aprobar o
  // rechazar de un solo tap sin feedback sería demasiado fácil de hacer sin
  // querer sobre el pedido de un cliente real.
  const [rejecting, setRejecting] = useState<OperationRequestListItem | null>(null)
  const [confirming, setConfirming] = useState<OperationRequestListItem | null>(null)
  const [notes, setNotes] = useState('')
  const [pending, startTransition] = useTransition()

  function decide(op: OperationRequestListItem, action: 'confirmed' | 'rejected', motivo?: string) {
    startTransition(async () => {
      const result = await decideOperationRequestAction(op.id, action, motivo)
      if (result.success) {
        toast.success(action === 'confirmed' ? 'Solicitud aprobada.' : 'Solicitud rechazada.')
        setSelected(null); setRejecting(null); setConfirming(null); setNotes('')
        router.refresh()
      } else {
        toast.error(result.error)
        // Si otra persona decidió primero, la pantalla tiene que mostrar el
        // estado real, no el que teníamos cargado.
        router.refresh()
      }
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Filtros (§15) ── */}
      <div className="flex gap-2 border-b px-6 py-3">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => router.push(`/dashboard/requests?status=${f.value}`)}
            className={`rounded-full px-3 py-1 text-sm transition ${
              activeFilter === f.value
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Listado ── */}
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <InboxIcon className="h-10 w-10 text-zinc-300" />
            <p className="mt-3 text-sm text-muted-foreground">
              No hay solicitudes {activeFilter !== 'all' ? statusLabel(activeFilter).toLowerCase() : ''}.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {requests.map((op) => (
              <button
                key={op.id}
                onClick={() => setSelected(op)}
                className="flex w-full flex-col gap-2 rounded-xl border bg-white p-4 text-left transition hover:border-zinc-300 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{kindLabel(op.kind)}</div>
                    <div className="text-sm text-muted-foreground">{intentTitle(op.intent)}</div>
                  </div>
                  <StatusBadge status={op.status} />
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <UserIcon className="h-3.5 w-3.5" />
                    {op.contact?.name ?? op.contact?.phone ?? 'Sin contacto'}
                  </span>
                  {op.entity_title_snapshot && (
                    <span className="inline-flex items-center gap-1">
                      <BuildingIcon className="h-3.5 w-3.5" />
                      {op.entity_title_snapshot}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <ClockIcon className="h-3.5 w-3.5" />
                    {formatDateTime(op.created_at)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Detalle (§12) ── */}
      <Dialog open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {kindLabel(selected.kind)}
                  <StatusBadge status={selected.status} />
                </DialogTitle>
                <DialogDescription>{intentTitle(selected.intent)}</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-lg border bg-zinc-50 p-3 text-sm">
                  <div className="font-medium">
                    {selected.contact?.name ?? 'Sin nombre'}
                  </div>
                  {selected.contact?.phone && (
                    <div className="text-muted-foreground">{selected.contact.phone}</div>
                  )}
                  {selected.entity_title_snapshot && (
                    <div className="mt-1 text-muted-foreground">
                      {selected.entity_title_snapshot}
                      {selected.publication_ref ? ` · ${selected.publication_ref}` : ''}
                    </div>
                  )}
                </div>

                {/* Los datos del cliente, legibles — nunca el JSON crudo (§2). */}
                <dl className="space-y-1.5 text-sm">
                  {buildSnapshotLines(selected.intent, selected.payload_snapshot).map((line) => (
                    <div key={line.label} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{line.label}</dt>
                      <dd className="text-right font-medium">{line.value}</dd>
                    </div>
                  ))}
                </dl>

                <p className="text-xs text-muted-foreground">
                  El cliente confirmó estos datos el {formatDateTime(selected.customer_confirmed_at)}.
                </p>

                {/* ── Ya decidida (§13) ── */}
                {selected.status !== 'pending' && (
                  <div className="rounded-lg border bg-zinc-50 p-3 text-sm">
                    <div className="font-medium">{statusLabel(selected.status)}</div>
                    {selected.decided_at && (
                      <div className="text-muted-foreground">
                        {selected.decider?.name ?? selected.decider?.email ?? 'Alguien del equipo'}
                        {' · '}
                        {formatDateTime(selected.decided_at)}
                      </div>
                    )}
                    {selected.decision_notes && (
                      <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                        {selected.decision_notes}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* ── Acciones: solo si sigue pendiente (§13) ── */}
              {selected.status === 'pending' && canDecide && (
                <>
                  {/* §17 — sin propiedad no se puede materializar la reserva.
                      Se avisa y se deshabilita Aprobar en vez de dejar que la
                      RPC lo rechace después de un click que parecía válido.
                      Rechazar sigue disponible: es una salida legítima. */}
                  {faltaContexto(selected) && (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      Esta solicitud no tiene una propiedad asociada, así que no se
                      puede crear la reserva. Asociala primero o rechazala.
                    </p>
                  )}

                  <DialogFooter className="gap-2 sm:justify-between">
                    <Button
                      variant="outline"
                      onClick={() => { setRejecting(selected); setNotes('') }}
                      disabled={pending}
                    >
                      <XCircleIcon className="mr-1.5 h-4 w-4" />
                      Rechazar
                    </Button>
                    <Button
                      onClick={() => { setConfirming(selected); setNotes('') }}
                      disabled={pending || faltaContexto(selected)}
                    >
                      <CheckCircle2Icon className="mr-1.5 h-4 w-4" />
                      Aprobar
                    </Button>
                  </DialogFooter>
                </>
              )}

              {selected.status === 'pending' && !canDecide && (
                <p className="text-sm text-muted-foreground">
                  No tenés permiso para decidir solicitudes.
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Confirmación de APROBAR (§12: nunca de un solo tap) ── */}
      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>¿Aprobar esta solicitud?</DialogTitle>
            <DialogDescription>
              {confirming && materializaReserva(confirming)
                ? 'Se va a crear una PRE-RESERVA para las fechas solicitadas y esas fechas van a dejar de estar disponibles. Todavía no queda confirmada: falta el paso de confirmación (y el pago, si corresponde).'
                : 'Queda registrado que vos la aprobaste. Todavía no se crea ninguna operación.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="approve-notes">Nota (opcional)</Label>
            <Textarea
              id="approve-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Algo que quieras dejar anotado"
            />
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={() => confirming && decide(confirming, 'confirmed', notes)} disabled={pending}>
              {pending ? 'Aprobando…' : 'Aprobar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirmación de RECHAZAR, con motivo (§12) ── */}
      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>¿Rechazar esta solicitud?</DialogTitle>
            <DialogDescription>
              Queda registrado que vos la rechazaste. El cliente no recibe un aviso
              automático todavía.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="reject-notes">Motivo (opcional)</Label>
            <Textarea
              id="reject-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Por qué se rechaza"
            />
            <p className="text-xs text-muted-foreground">{notes.length}/500</p>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRejecting(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => rejecting && decide(rejecting, 'rejected', notes)}
              disabled={pending}
            >
              {pending ? 'Rechazando…' : 'Rechazar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ReceiptTextIcon, BikeIcon, StoreIcon } from 'lucide-react'
import { toast } from 'sonner'
import { transitionOrderAction } from '@/actions/orders'
import type { OrderDetail, OrderStatus } from '@/lib/repositories/orders.repository'
import { StatusFilterTabs } from '@/components/tenant/shared/status-filter-tabs'
import {
  ORDER_FILTERS,
  actionsForStatus,
  emptyOrdersCopy,
  orderFilterHref,
  formatOrderMoney,
  fulfillmentLabel,
  orderLineLabel,
  orderStatusLabel,
  orderStatusTone,
  paymentLabel,
  type OrderFilter,
} from '@/lib/orders/presentation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

// Fase 3E-C3C — la bandeja operacional.
//
// ── TODO ES SNAPSHOT (§20) ──────────────────────────────────────────────────
//
// Cada línea muestra name_snapshot y unit_price_snapshot; el total, subtotal y
// currency del pedido. NO se consulta el catálogo: cambiar un precio o archivar
// un producto no puede alterar lo que dice una comanda ya aceptada.
//
// ── SOLO CICLO DE VIDA (§24) ────────────────────────────────────────────────
//
// No se editan items, cantidades, precios, entrega, dirección ni pago. Un pedido
// es evidencia de lo que la empresa aceptó; corregirlo es otra fase, con su
// propia auditoría.

function tonoBadge(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (orderStatusTone(status)) {
    case 'ok':     return 'default'
    case 'danger': return 'destructive'
    case 'muted':  return 'outline'
    default:       return 'secondary'
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function OrdersClient({
  orders, activeFilter, canManageOrders,
}: {
  orders:          OrderDetail[]
  activeFilter:    OrderFilter
  canManageOrders: boolean
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<OrderDetail | null>(null)
  // Cancelar pide confirmación explícita: es la única acción que no se puede
  // deshacer avanzando, y el motivo es opcional.
  const [cancelling, setCancelling] = useState<OrderDetail | null>(null)
  const [motivo, setMotivo] = useState('')
  const [pending, startTransition] = useTransition()

  function transicionar(order: OrderDetail, target: OrderStatus, reason?: string) {
    startTransition(async () => {
      const res = await transitionOrderAction(order.id, target, reason)
      if (res.success) {
        toast.success(
          target === 'cancelled' ? 'Pedido cancelado.' : `Pedido: ${orderStatusLabel(target)}.`,
        )
        setSelected(null)
        setCancelling(null)
        setMotivo('')
        router.refresh()
        return
      }
      toast.error(res.error ?? 'No pudimos actualizar el pedido.')
      router.refresh()
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Filtros ── */}
      <StatusFilterTabs
        options={ORDER_FILTERS}
        active={activeFilter}
        hrefFor={orderFilterHref}
        ariaLabel="Filtrar pedidos por estado"
      />

      {/* ── Lista ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <ReceiptTextIcon className="h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium">{emptyOrdersCopy(activeFilter).title}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {emptyOrdersCopy(activeFilter).hint}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {orders.map((o) => {
              const acciones = canManageOrders ? actionsForStatus(o.status) : []
              return (
                <li key={o.id} className="rounded-xl border p-3 sm:p-4">
                  <button
                    type="button"
                    onClick={() => setSelected(o)}
                    className="w-full text-left"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {o.contact_name ?? 'Sin nombre'}
                          </span>
                          <Badge variant={tonoBadge(o.status)}>{orderStatusLabel(o.status)}</Badge>
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            {o.fulfillment === 'delivery'
                              ? <BikeIcon className="h-3.5 w-3.5" />
                              : <StoreIcon className="h-3.5 w-3.5" />}
                            {fulfillmentLabel(o.fulfillment)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatDateTime(o.created_at)}
                          {o.reference && (
                            <> · <span className="font-mono">{o.reference}</span></>
                          )}
                          {' · '}{o.item_count} {o.item_count === 1 ? 'línea' : 'líneas'}
                        </p>
                      </div>
                      <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">
                        {formatOrderMoney(o.subtotal, o.currency)}
                      </span>
                    </div>
                  </button>

                  {acciones.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {acciones.map((a) => (
                        <Button
                          key={a.target}
                          size="sm"
                          variant={a.primary ? 'default' : 'outline'}
                          disabled={pending}
                          onClick={() =>
                            a.target === 'cancelled'
                              ? (setCancelling(o), setMotivo(''))
                              : transicionar(o, a.target)
                          }
                        >
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* ── Detalle (§20) ── */}
      <Dialog open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{selected.contact_name ?? 'Sin nombre'}</DialogTitle>
                <DialogDescription>
                  {orderStatusLabel(selected.status)}
                  {selected.reference && <> · <span className="font-mono">{selected.reference}</span></>}
                </DialogDescription>
              </DialogHeader>

              {/* La comanda. Todo del snapshot. */}
              <div className="rounded-lg border">
                <p className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Pedido</p>
                <ul className="divide-y">
                  {selected.items.map((it) => (
                    <li key={it.id} className="px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 break-words text-sm">
                          {orderLineLabel(it.quantity, it.name_snapshot)}
                        </span>
                        <span className="shrink-0 whitespace-nowrap text-sm tabular-nums">
                          {formatOrderMoney(it.line_total, selected.currency)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatOrderMoney(it.unit_price_snapshot, selected.currency)} c/u
                      </p>
                      {it.notes && (
                        <p className="mt-0.5 break-words text-xs italic text-muted-foreground">
                          {it.notes}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between border-t px-3 py-2">
                  <span className="text-sm font-medium">Subtotal</span>
                  <span className="font-semibold tabular-nums">
                    {formatOrderMoney(selected.subtotal, selected.currency)}
                  </span>
                </div>
              </div>

              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Entrega</dt>
                  <dd className="text-right font-medium">{fulfillmentLabel(selected.fulfillment)}</dd>
                </div>
                {selected.delivery_address_snapshot && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Dirección</dt>
                    <dd className="break-words text-right font-medium">{selected.delivery_address_snapshot}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Pago</dt>
                  <dd className="text-right font-medium">{paymentLabel(selected.payment_method)}</dd>
                </div>
                {selected.contact_phone && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Teléfono</dt>
                    <dd className="text-right font-medium">{selected.contact_phone}</dd>
                  </div>
                )}
                {selected.notes && (
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">Observaciones</dt>
                    <dd className="break-words font-medium">{selected.notes}</dd>
                  </div>
                )}
              </dl>

              {/* Los hitos del ciclo. No se borran al avanzar. */}
              <dl className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
                <div className="flex justify-between gap-4">
                  <dt>Aceptado</dt><dd>{formatDateTime(selected.confirmed_at)}</dd>
                </div>
                {selected.preparing_at && (
                  <div className="flex justify-between gap-4">
                    <dt>En preparación</dt><dd>{formatDateTime(selected.preparing_at)}</dd>
                  </div>
                )}
                {selected.ready_at && (
                  <div className="flex justify-between gap-4">
                    <dt>Listo</dt><dd>{formatDateTime(selected.ready_at)}</dd>
                  </div>
                )}
                {selected.completed_at && (
                  <div className="flex justify-between gap-4">
                    <dt>Completado</dt><dd>{formatDateTime(selected.completed_at)}</dd>
                  </div>
                )}
                {selected.cancelled_at && (
                  <>
                    <div className="flex justify-between gap-4">
                      <dt>Cancelado</dt><dd>{formatDateTime(selected.cancelled_at)}</dd>
                    </div>
                    {selected.cancellation_reason && (
                      <p className="pt-1 italic">Motivo: {selected.cancellation_reason}</p>
                    )}
                  </>
                )}
              </dl>

              {canManageOrders && actionsForStatus(selected.status).length > 0 && (
                <DialogFooter className="flex-col gap-2 sm:flex-row">
                  {actionsForStatus(selected.status).map((a) => (
                    <Button
                      key={a.target}
                      variant={a.primary ? 'default' : 'outline'}
                      disabled={pending}
                      className="w-full sm:w-auto"
                      onClick={() =>
                        a.target === 'cancelled'
                          ? (setCancelling(selected), setMotivo(''))
                          : transicionar(selected, a.target)
                      }
                    >
                      {a.label}
                    </Button>
                  ))}
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Confirmación de cancelar (§21) ── */}
      <Dialog open={cancelling !== null} onOpenChange={(o) => !o && setCancelling(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancelar el pedido</DialogTitle>
            <DialogDescription>
              El pedido queda cancelado y no se puede reabrir. La solicitud de origen no cambia.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="motivo-cancelacion">Motivo (opcional)</Label>
            <Textarea
              id="motivo-cancelacion"
              value={motivo}
              maxLength={500}
              rows={3}
              placeholder="Por qué se cancela"
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setCancelling(null)}>
              Volver
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={pending}
              onClick={() => cancelling && transicionar(cancelling, 'cancelled', motivo.trim() || undefined)}
            >
              Cancelar el pedido
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

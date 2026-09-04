'use client'

import { BanIcon, FileTextIcon, LoaderCircleIcon, ReceiptIcon, UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MonthlyRentalPaymentRow, MonthlyRentalChargeRow } from '@orderflow/types'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  payments:          MonthlyRentalPaymentRow[]
  charges:           MonthlyRentalChargeRow[]
  currency:          string
  isOwner:           boolean
  receiptLoadingId?: string | null
  onVoidRequest:     (paymentId: string) => void
  onReceiptRequest:  (paymentId: string) => void
  onProofRequest?:   (paymentId: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_ABBR = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']

const METHOD_LABEL: Record<string, string> = {
  transfer: 'Transferencia',
  cash:     'Efectivo',
  check:    'Cheque',
  card:     'Tarjeta',
  other:    'Otro',
}

function fmt(n: number) {
  return n.toLocaleString('es-AR')
}

function fmtDate(d: string) {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PaymentsHistoryTable({
  payments, charges, currency, isOwner, receiptLoadingId,
  onVoidRequest, onReceiptRequest, onProofRequest,
}: Props) {
  const chargeMap = new Map(charges.map((c) => [c.id, c]))

  if (payments.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">
        Todavía no hay pagos registrados.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b">
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Fecha</th>
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Cuota</th>
            <th className="text-right font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap tabular-nums">Monto</th>
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Método</th>
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Estado</th>
            <th className="text-left font-medium text-muted-foreground py-2 pr-3">Notas</th>
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Comprobante</th>
            <th className="text-left font-medium text-muted-foreground py-2 pr-3 whitespace-nowrap">Recibo</th>
            {isOwner && <th className="py-2" />}
          </tr>
        </thead>
        <tbody className="divide-y">
          {payments.map((p) => {
            const isVoided   = p.status === 'voided'
            const isActive   = p.status === 'active'
            const charge     = chargeMap.get(p.charge_id)
            const period     = charge
              ? `${MONTH_ABBR[charge.period_month - 1]} ${charge.period_year}`
              : '—'
            const isLoadingReceipt = receiptLoadingId === p.id

            return (
              <tr key={p.id} className={`hover:bg-muted/30 transition-colors ${isVoided ? 'opacity-50' : ''}`}>
                <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(p.paid_at)}</td>
                <td className="py-2 pr-3 whitespace-nowrap font-medium">{period}</td>
                <td className={`py-2 pr-3 text-right tabular-nums font-medium ${isVoided ? '' : 'text-green-600 dark:text-green-400'}`}>
                  {fmt(p.amount)} {currency}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                  {METHOD_LABEL[p.payment_method] ?? p.payment_method}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {isVoided ? (
                    <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900">
                      Anulado
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900">
                      Activo
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 max-w-[200px] truncate text-muted-foreground">
                  {p.notes ?? (isVoided && p.void_reason ? `Motivo: ${p.void_reason}` : '—')}
                </td>

                {/* Comprobante */}
                <td className="py-2 pr-3">
                  {p.proof_document_id ? (
                    <a
                      href={`/api/documents/${p.proof_document_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Ver comprobante"
                      className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground hover:text-primary transition-colors"
                    >
                      <FileTextIcon className="h-3 w-3" />
                    </a>
                  ) : isActive && isOwner && onProofRequest ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-primary"
                      title="Subir comprobante"
                      onClick={() => onProofRequest(p.id)}
                    >
                      <UploadIcon className="h-3 w-3" />
                    </Button>
                  ) : null}
                </td>

                {/* Recibo */}
                <td className="py-2 pr-3">
                  {p.receipt_document_id ? (
                    <a
                      href={`/api/documents/${p.receipt_document_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Ver recibo"
                      className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground hover:text-primary transition-colors"
                    >
                      <FileTextIcon className="h-3 w-3" />
                    </a>
                  ) : isActive && isOwner ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-primary"
                      title="Generar recibo"
                      disabled={isLoadingReceipt}
                      onClick={() => onReceiptRequest(p.id)}
                    >
                      {isLoadingReceipt
                        ? <LoaderCircleIcon className="h-3 w-3 animate-spin" />
                        : <ReceiptIcon className="h-3 w-3" />}
                    </Button>
                  ) : null}
                </td>

                {isOwner && (
                  <td className="py-2 pl-2">
                    {!isVoided && (
                      <Button
                        variant="ghost" size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        title="Anular pago"
                        onClick={() => onVoidRequest(p.id)}
                      >
                        <BanIcon className="h-3 w-3" />
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/20">
            <td colSpan={2} className="py-2 pr-3 text-xs text-muted-foreground font-medium">
              {payments.filter(p => p.status === 'active').length} activo{payments.filter(p => p.status === 'active').length !== 1 ? 's' : ''}
              {payments.some(p => p.status === 'voided') && ` · ${payments.filter(p => p.status === 'voided').length} anulado${payments.filter(p => p.status === 'voided').length !== 1 ? 's' : ''}`}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums font-bold text-xs text-green-600 dark:text-green-400">
              {fmt(payments.filter(p => p.status === 'active').reduce((s, p) => s + p.amount, 0))} {currency}
            </td>
            <td colSpan={isOwner ? 6 : 5} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

'use client'

import { useState } from 'react'
import {
  CopyIcon, CheckIcon, DownloadIcon,
  BanknoteIcon, TrendingDownIcon, AlertCircleIcon, CalendarIcon, ReceiptTextIcon,
  FileTextIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ChargeStatusBadge } from './charge-status-badge'
import {
  computeStatementSummary,
  downloadStatementCsv,
  generateStatementCopyText,
  fmtStatementDate,
  fmtStatementPeriod,
  PAYMENT_METHOD_LABEL,
} from '@/lib/monthly-rental-statement-export'
import type { MonthlyRentalContractDetail } from '@/lib/repositories/monthly-rentals.repository'
import type { MonthlyRentalPaymentRow } from '@orderflow/types'

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  contract: MonthlyRentalContractDetail
  payments: MonthlyRentalPaymentRow[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, currency: string) {
  return `${n.toLocaleString('es-AR')} ${currency}`
}

function SummaryCard({
  label, value, sub, icon: Icon, variant = 'default',
}: {
  label: string
  value: string
  sub?: string
  icon: React.ElementType
  variant?: 'default' | 'alert' | 'success' | 'warn'
}) {
  const iconCls =
    variant === 'alert'   ? 'text-destructive/60' :
    variant === 'success' ? 'text-green-600/60 dark:text-green-400/60' :
    variant === 'warn'    ? 'text-amber-600/60 dark:text-amber-400/60' :
    'text-muted-foreground/50'
  const valueCls =
    variant === 'alert'   ? 'text-destructive' :
    variant === 'success' ? 'text-green-600 dark:text-green-400' :
    variant === 'warn'    ? 'text-amber-600 dark:text-amber-400' :
    ''

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
        <Icon className={`h-3.5 w-3.5 ${iconCls}`} />
      </div>
      <p className={`text-base font-bold tabular-nums leading-tight ${valueCls}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground/60 mt-0.5">{sub}</p>}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AccountStatementSection({ contract: c, payments }: Props) {
  const [copied, setCopied] = useState(false)

  const charges = c.charges   // already ordered period_year asc, period_month asc
  const currency = c.currency

  // Payments sorted chronologically for statement view
  const sortedPayments = [...payments].sort(
    (a, b) => a.paid_at.localeCompare(b.paid_at) || a.created_at.localeCompare(b.created_at),
  )

  const chargeMap = new Map(charges.map((ch) => [ch.id, ch]))

  const summary = computeStatementSummary(charges, payments)

  const statementParams = {
    propertyTitle:  c.property?.title   ?? null,
    contactName:    c.contact?.name     ?? null,
    startDate:      c.start_date,
    endDate:        c.end_date ?? null,
    currency,
    rentAmount:     c.rent_amount,
    contractStatus: c.status,
    charges,
    payments,
  }

  async function handleCopy() {
    const text = generateStatementCopyText(statementParams)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success('Resumen copiado al portapapeles.')
    } catch {
      toast.error('No se pudo copiar. Revisá los permisos del navegador.')
    }
  }

  function handleExport() {
    try {
      downloadStatementCsv(statementParams)
      toast.success('Descarga iniciada.')
    } catch {
      toast.error('Error al generar el CSV.')
    }
  }

  return (
    <section>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Estado de cuenta
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-7 text-xs"
            onClick={handleCopy}
          >
            {copied
              ? <><CheckIcon className="h-3 w-3 text-green-600" /> Copiado</>
              : <><CopyIcon className="h-3 w-3" /> Copiar resumen</>}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-7 text-xs"
            onClick={handleExport}
          >
            <DownloadIcon className="h-3 w-3" />
            Exportar CSV
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5 mb-4">
        <SummaryCard
          label="Total emitido"
          value={fmt(summary.totalIssued, currency)}
          sub={`${charges.filter(c => c.status !== 'cancelled').length} cuota${charges.filter(c => c.status !== 'cancelled').length !== 1 ? 's' : ''}`}
          icon={ReceiptTextIcon}
        />
        <SummaryCard
          label="Total pagado"
          value={fmt(summary.totalPaid, currency)}
          sub={summary.activePaymentsTotal !== summary.voidedPaymentsTotal && summary.voidedPaymentsTotal > 0
            ? `${fmt(summary.voidedPaymentsTotal, currency)} anulados`
            : `${payments.filter(p => p.status === 'active').length} pago${payments.filter(p => p.status === 'active').length !== 1 ? 's' : ''}`}
          icon={BanknoteIcon}
          variant={summary.totalPaid > 0 ? 'success' : 'default'}
        />
        <SummaryCard
          label="Saldo pendiente"
          value={fmt(summary.totalPending, currency)}
          sub={summary.pendingChargesCount > 0
            ? `${summary.pendingChargesCount} cuota${summary.pendingChargesCount !== 1 ? 's' : ''}`
            : 'Al día'}
          icon={TrendingDownIcon}
          variant={summary.totalPending > 0 ? 'alert' : 'default'}
        />
        <SummaryCard
          label="Saldo vencido"
          value={fmt(summary.overdueBalance, currency)}
          sub={summary.overdueChargesCount > 0
            ? `${summary.overdueChargesCount} vencida${summary.overdueChargesCount !== 1 ? 's' : ''}`
            : 'Sin vencidas'}
          icon={AlertCircleIcon}
          variant={summary.overdueBalance > 0 ? 'alert' : 'default'}
        />
        <SummaryCard
          label="Próx. vencimiento"
          value={summary.nextDueDate ? fmtStatementDate(summary.nextDueDate) : '—'}
          sub={summary.nextDueAmount !== null ? fmt(summary.nextDueAmount, currency) : undefined}
          icon={CalendarIcon}
          variant={
            summary.nextDueDate && summary.nextDueDate < new Date().toISOString().slice(0, 10)
              ? 'warn'
              : 'default'
          }
        />
      </div>

      {/* Charges table */}
      {charges.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center mb-3">
          <p className="text-xs text-muted-foreground">Sin cuotas en este contrato.</p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden mb-3">
          <div className="px-4 py-2 bg-muted/20">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Cuotas
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b">
                  <th className="text-left font-medium text-muted-foreground py-2 px-4 whitespace-nowrap">Período</th>
                  <th className="text-left font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap">Vencimiento</th>
                  <th className="text-right font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap tabular-nums">Total</th>
                  <th className="text-right font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap tabular-nums">Pagado</th>
                  <th className="text-right font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap tabular-nums">Saldo</th>
                  <th className="text-left font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {charges.map((ch) => {
                  const balance     = ch.total_amount - ch.amount_paid
                  const isCancelled = ch.status === 'cancelled'
                  return (
                    <tr
                      key={ch.id}
                      className={`hover:bg-muted/20 transition-colors ${isCancelled ? 'opacity-40' : ''}`}
                    >
                      <td className="py-2 px-4 whitespace-nowrap font-medium">
                        {fmtStatementPeriod(ch.period_year, ch.period_month)}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                        {fmtStatementDate(ch.due_date)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums font-medium">
                        {ch.total_amount.toLocaleString('es-AR')}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-green-600 dark:text-green-400">
                        {ch.amount_paid > 0 ? ch.amount_paid.toLocaleString('es-AR') : '—'}
                      </td>
                      <td className={`py-2 pr-4 text-right tabular-nums font-medium ${
                        balance > 0 && !isCancelled ? 'text-destructive' : 'text-muted-foreground'
                      }`}>
                        {isCancelled ? '—' : balance.toLocaleString('es-AR')}
                      </td>
                      <td className="py-2 pr-4">
                        <ChargeStatusBadge status={ch.status} dueDate={ch.due_date} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/20">
                  <td colSpan={2} className="py-2 px-4 text-[10px] text-muted-foreground font-medium">
                    {charges.filter(c => c.status !== 'cancelled').length} activa{charges.filter(c => c.status !== 'cancelled').length !== 1 ? 's' : ''}
                    {summary.cancelledChargesCount > 0 && ` · ${summary.cancelledChargesCount} cancelada${summary.cancelledChargesCount !== 1 ? 's' : ''}`}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-bold text-xs">
                    {summary.totalIssued.toLocaleString('es-AR')}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-bold text-xs text-green-600 dark:text-green-400">
                    {summary.totalPaid.toLocaleString('es-AR')}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-bold text-xs text-destructive">
                    {summary.totalPending.toLocaleString('es-AR')}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Payments table */}
      {sortedPayments.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="px-4 py-2 bg-muted/20">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Pagos
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b">
                  <th className="text-left font-medium text-muted-foreground py-2 px-4 whitespace-nowrap">Fecha</th>
                  <th className="text-left font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap">Período</th>
                  <th className="text-right font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap tabular-nums">Monto</th>
                  <th className="text-left font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap">Método</th>
                  <th className="text-left font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap">Estado</th>
                  <th className="text-left font-medium text-muted-foreground py-2 pr-4 whitespace-nowrap">Docs</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sortedPayments.map((p) => {
                  const ch      = chargeMap.get(p.charge_id)
                  const isVoided = p.status === 'voided'
                  return (
                    <tr
                      key={p.id}
                      className={`hover:bg-muted/20 transition-colors ${isVoided ? 'opacity-50' : ''}`}
                    >
                      <td className="py-2 px-4 whitespace-nowrap text-muted-foreground">
                        {fmtStatementDate(p.paid_at)}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap font-medium">
                        {ch ? fmtStatementPeriod(ch.period_year, ch.period_month) : '—'}
                      </td>
                      <td className={`py-2 pr-4 text-right tabular-nums font-medium ${isVoided ? '' : 'text-green-600 dark:text-green-400'}`}>
                        {p.amount.toLocaleString('es-AR')} {currency}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                        {PAYMENT_METHOD_LABEL[p.payment_method] ?? p.payment_method}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">
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
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-1">
                          {p.receipt_document_id && (
                            <a
                              href={`/api/documents/${p.receipt_document_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Ver recibo"
                              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-primary transition-colors"
                            >
                              <FileTextIcon className="h-3 w-3" />
                            </a>
                          )}
                          {p.proof_document_id && (
                            <a
                              href={`/api/documents/${p.proof_document_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Ver comprobante"
                              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-primary transition-colors"
                            >
                              <FileTextIcon className="h-3 w-3" />
                            </a>
                          )}
                          {!p.receipt_document_id && !p.proof_document_id && (
                            <span className="text-muted-foreground/40 text-[10px]">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/20">
                  <td colSpan={2} className="py-2 px-4 text-[10px] text-muted-foreground font-medium">
                    {payments.filter(p => p.status === 'active').length} activo{payments.filter(p => p.status === 'active').length !== 1 ? 's' : ''}
                    {payments.some(p => p.status === 'voided') && ` · ${payments.filter(p => p.status === 'voided').length} anulado${payments.filter(p => p.status === 'voided').length !== 1 ? 's' : ''}`}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-bold text-xs text-green-600 dark:text-green-400">
                    {summary.totalPaid.toLocaleString('es-AR')} {currency}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

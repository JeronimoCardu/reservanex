import type { MonthlyRentalChargeRow, MonthlyRentalPaymentRow } from '@orderflow/types'

// ─── Types ──────────────────────────────────────────────────────────────────────

export type StatementSummary = {
  totalIssued:           number
  totalPaid:             number
  totalPending:          number
  overdueBalance:        number
  nextDueDate:           string | null
  nextDueAmount:         number | null
  paidChargesCount:      number
  pendingChargesCount:   number
  overdueChargesCount:   number
  cancelledChargesCount: number
  activePaymentsTotal:   number
  voidedPaymentsTotal:   number
}

// ─── Shared helpers ──────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
]

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  transfer: 'Transferencia',
  cash:     'Efectivo',
  check:    'Cheque',
  card:     'Tarjeta',
  other:    'Otro',
}

export function fmtStatementDate(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

export function fmtStatementPeriod(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? ''} ${year}`
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

// ─── Summary computation ──────────────────────────────────────────────────────────

export function computeStatementSummary(
  charges:  MonthlyRentalChargeRow[],
  payments: MonthlyRentalPaymentRow[],
): StatementSummary {
  const today  = new Date().toISOString().slice(0, 10)
  const active = charges.filter((c) => c.status !== 'cancelled')

  const totalIssued  = active.reduce((s, c) => s + c.total_amount, 0)
  const totalPaid    = payments
    .filter((p) => p.status === 'active')
    .reduce((s, p) => s + p.amount, 0)
  const totalPending = Math.max(0, totalIssued - totalPaid)

  const overdueBalance = active
    .filter((c) => c.status !== 'paid' && c.due_date < today)
    .reduce((s, c) => s + Math.max(0, c.total_amount - c.amount_paid), 0)

  const paidChargesCount     = active.filter((c) => c.status === 'paid').length
  const cancelledChargesCount = charges.filter((c) => c.status === 'cancelled').length
  const overdueChargesCount  = active.filter(
    (c) => c.status !== 'paid' && c.due_date < today,
  ).length
  const pendingChargesCount  = active.filter(
    (c) => c.status !== 'paid' && c.due_date >= today,
  ).length

  const next = [...active]
    .filter((c) => c.status !== 'paid' && c.due_date >= today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0]

  const activePaymentsTotal = payments
    .filter((p) => p.status === 'active')
    .reduce((s, p) => s + p.amount, 0)
  const voidedPaymentsTotal = payments
    .filter((p) => p.status === 'voided')
    .reduce((s, p) => s + p.amount, 0)

  return {
    totalIssued, totalPaid, totalPending, overdueBalance,
    nextDueDate:   next?.due_date   ?? null,
    nextDueAmount: next != null ? Math.max(0, next.total_amount - next.amount_paid) : null,
    paidChargesCount, pendingChargesCount, overdueChargesCount, cancelledChargesCount,
    activePaymentsTotal, voidedPaymentsTotal,
  }
}

// ─── CSV ─────────────────────────────────────────────────────────────────────────

function csvEsc(v: string | number | null | undefined): string {
  const s = String(v ?? '')
  return s.includes(';') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

function csvRow(...cells: (string | number | null | undefined)[]): string {
  return cells.map(csvEsc).join(';')
}

const CHARGE_STATUS_LABEL: Record<string, string> = {
  paid:           'Pagada',
  partially_paid: 'Pago parcial',
  overdue:        'Vencida',
  pending:        'Pendiente',
  cancelled:      'Cancelada',
}

export interface StatementParams {
  propertyTitle:  string | null
  contactName:    string | null
  startDate:      string
  endDate:        string | null
  currency:       string
  rentAmount:     number
  contractStatus: string
  charges:        MonthlyRentalChargeRow[]
  payments:       MonthlyRentalPaymentRow[]
}

export function generateStatementCsv(p: StatementParams): string {
  const summary   = computeStatementSummary(p.charges, p.payments)
  const chargeMap = new Map(p.charges.map((c) => [c.id, c]))
  const lines: string[] = []

  // Datos del contrato
  lines.push(csvRow('Estado de cuenta', 'Alquiler mensual'))
  lines.push('')
  lines.push(csvRow('Dato', 'Valor'))
  lines.push(csvRow('Inquilino',            p.contactName   ?? '—'))
  lines.push(csvRow('Propiedad',            p.propertyTitle ?? '—'))
  lines.push(csvRow('Desde',               fmtStatementDate(p.startDate)))
  lines.push(csvRow('Hasta',               p.endDate ? fmtStatementDate(p.endDate) : '—'))
  lines.push(csvRow('Moneda',              p.currency))
  lines.push(csvRow('Alquiler base',       p.rentAmount))
  lines.push(csvRow('Estado del contrato', p.contractStatus))
  lines.push('')

  // Resumen financiero
  lines.push(csvRow('Resumen financiero', ''))
  lines.push(csvRow('Concepto', 'Importe'))
  lines.push(csvRow('Total emitido',       summary.totalIssued))
  lines.push(csvRow('Total pagado',        summary.totalPaid))
  lines.push(csvRow('Saldo pendiente',     summary.totalPending))
  lines.push(csvRow('Saldo vencido',       summary.overdueBalance))
  lines.push(csvRow('Próximo vencimiento', summary.nextDueDate ? fmtStatementDate(summary.nextDueDate) : '—'))
  lines.push(csvRow('Próximo saldo',       summary.nextDueAmount ?? '—'))
  lines.push(csvRow('Cuotas pagadas',      summary.paidChargesCount))
  lines.push(csvRow('Cuotas pendientes',   summary.pendingChargesCount))
  lines.push(csvRow('Cuotas vencidas',     summary.overdueChargesCount))
  lines.push(csvRow('Cuotas canceladas',   summary.cancelledChargesCount))
  lines.push('')

  // Cuotas
  lines.push(csvRow('Cuotas', '', '', '', '', '', '', '', '', '', ''))
  lines.push(csvRow(
    'Período', 'Vencimiento', 'Alquiler', 'Expensas', 'Servicios',
    'Ajustes', 'Mora', 'Total', 'Pagado', 'Saldo', 'Estado',
  ))
  for (const c of p.charges) {
    lines.push(csvRow(
      fmtStatementPeriod(c.period_year, c.period_month),
      fmtStatementDate(c.due_date),
      c.rent_amount, c.expenses_amount, c.services_amount,
      c.adjustments_amount, c.late_fee_amount,
      c.total_amount, c.amount_paid,
      c.total_amount - c.amount_paid,
      CHARGE_STATUS_LABEL[c.status] ?? c.status,
    ))
  }
  lines.push('')

  // Pagos (cronológico)
  const sorted = [...p.payments].sort(
    (a, b) => a.paid_at.localeCompare(b.paid_at) || a.created_at.localeCompare(b.created_at),
  )
  lines.push(csvRow('Pagos', '', '', '', '', '', ''))
  lines.push(csvRow('Fecha', 'Período', 'Monto', 'Método', 'Estado', 'Recibo', 'Comprobante'))
  for (const pmt of sorted) {
    const ch = chargeMap.get(pmt.charge_id)
    lines.push(csvRow(
      fmtStatementDate(pmt.paid_at),
      ch ? fmtStatementPeriod(ch.period_year, ch.period_month) : '—',
      pmt.amount,
      PAYMENT_METHOD_LABEL[pmt.payment_method] ?? pmt.payment_method,
      pmt.status === 'active' ? 'Activo' : 'Anulado',
      pmt.receipt_document_id ? 'Sí' : 'No',
      pmt.proof_document_id   ? 'Sí' : 'No',
    ))
  }

  return lines.join('\r\n')
}

export function downloadStatementCsv(p: StatementParams): void {
  const csv  = generateStatementCsv(p)
  const BOM  = '﻿'
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const today    = new Date().toISOString().slice(0, 10)
  const property = slugify(p.propertyTitle ?? 'propiedad')
  const contact  = slugify(p.contactName   ?? 'inquilino')
  const a        = document.createElement('a')
  a.href         = url
  a.download     = `estado-cuenta-${property}-${contact}-${today}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Copy text ────────────────────────────────────────────────────────────────────

function fmtMoney(n: number, currency: string): string {
  return `${n.toLocaleString('es-AR')} ${currency}`
}

export function generateStatementCopyText(p: StatementParams): string {
  const summary = computeStatementSummary(p.charges, p.payments)
  const today   = new Date().toISOString().slice(0, 10)
  const lines: string[] = []

  lines.push('Estado de cuenta — Alquiler mensual')
  lines.push('')
  lines.push(`Inquilino: ${p.contactName  ?? '—'}`)
  lines.push(`Propiedad: ${p.propertyTitle ?? '—'}`)
  const period = p.endDate
    ? `${fmtStatementDate(p.startDate)} al ${fmtStatementDate(p.endDate)}`
    : `desde ${fmtStatementDate(p.startDate)}`
  lines.push(`Contrato: ${period}`)
  lines.push('')
  lines.push(`Total emitido:    ${fmtMoney(summary.totalIssued,   p.currency)}`)
  lines.push(`Total pagado:     ${fmtMoney(summary.totalPaid,     p.currency)}`)
  lines.push(`Saldo pendiente:  ${fmtMoney(summary.totalPending,  p.currency)}`)
  if (summary.overdueBalance > 0) {
    lines.push(`Saldo vencido:    ${fmtMoney(summary.overdueBalance, p.currency)}`)
  }
  if (summary.nextDueDate && summary.nextDueAmount !== null) {
    lines.push(`Próximo vencimiento: ${fmtStatementDate(summary.nextDueDate)} — ${fmtMoney(summary.nextDueAmount, p.currency)}`)
  }

  const overdue = p.charges
    .filter((c) => c.status !== 'paid' && c.status !== 'cancelled' && c.due_date < today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
  if (overdue.length > 0) {
    lines.push('')
    lines.push('Cuotas vencidas:')
    for (const c of overdue) {
      const bal = Math.max(0, c.total_amount - c.amount_paid)
      lines.push(`  - ${fmtStatementPeriod(c.period_year, c.period_month)}: saldo ${fmtMoney(bal, p.currency)}, vencía ${fmtStatementDate(c.due_date)}`)
    }
  }

  const pending = p.charges
    .filter((c) => c.status !== 'paid' && c.status !== 'cancelled' && c.due_date >= today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
  if (pending.length > 0) {
    lines.push('')
    lines.push('Cuotas pendientes:')
    for (const c of pending) {
      const bal = Math.max(0, c.total_amount - c.amount_paid)
      lines.push(`  - ${fmtStatementPeriod(c.period_year, c.period_month)}: saldo ${fmtMoney(bal, p.currency)}, vence ${fmtStatementDate(c.due_date)}`)
    }
  }

  lines.push('')
  lines.push('Este resumen fue generado desde ReservaNex.')

  return lines.join('\n')
}

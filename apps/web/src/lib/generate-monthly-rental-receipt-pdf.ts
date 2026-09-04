// PDF generation for monthly rental payment receipts.
// Uses pdfkit with built-in Helvetica fonts — no filesystem font loading.
// Must run in Node runtime only (server actions with runtime='nodejs').
// pdfkit is declared in serverExternalPackages so Next.js does not bundle it.

import PDFDocument from 'pdfkit'

// ─── Types ────────────────────────────────────────────────────────────────────

export type MonthlyRentalReceiptData = {
  receiptNumber:        string
  emittedAt:            string         // ISO string — display only
  // Tenant
  tenantName:           string
  tenantPublicName?:    string | null
  receiptFooterText?:   string | null
  // Contact (inquilino)
  contactName:          string
  contactPhone?:        string | null
  contactEmail?:        string | null
  // Property
  propertyTitle?:       string | null
  propertyLocation?:    string | null
  // Contract dates
  contractStartDate:    string         // YYYY-MM-DD
  contractEndDate?:     string | null  // YYYY-MM-DD
  // Charge period
  periodYear:           number
  periodMonth:          number         // 1–12
  dueDate:              string         // YYYY-MM-DD
  // Charge breakdown
  currency:             string
  rentAmount:           number
  expensesAmount?:      number | null
  servicesAmount?:      number | null
  adjustmentsAmount?:   number | null
  lateFeeAmount?:       number | null
  chargeTotalAmount:    number
  // Payment detail
  amountPaidInPayment:  number
  accumulatedPaid:      number
  paymentMethod:        string
  paidAt:               string         // YYYY-MM-DD
  notes?:               string | null
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
]

const METHOD_LABEL: Record<string, string> = {
  transfer: 'Transferencia',
  cash:     'Efectivo',
  check:    'Cheque',
  card:     'Tarjeta',
  other:    'Otro',
}

function dateOnly(dateStr: string): string {
  const parts = dateStr.slice(0, 10).split('-')
  return `${parts[2]}/${parts[1]}/${parts[0]}`
}

function dateFromIso(isoStr: string): string {
  const parts = isoStr.slice(0, 10).split('-')
  return `${parts[2]}/${parts[1]}/${parts[0]}`
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('es-AR', {
    style:                 'currency',
    currency:              currency || 'ARS',
    maximumFractionDigits: 0,
  }).format(amount)
}

function str(v: string | number | null | undefined): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

// ─── PDF builder ──────────────────────────────────────────────────────────────

export async function generateMonthlyRentalReceiptPdf(
  data: MonthlyRentalReceiptData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    const MARGIN = 48
    const doc = new PDFDocument({
      size:    'A4',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info:    { Title: `Recibo ${data.receiptNumber}`, Author: 'ReservaNex' },
    })

    doc.on('data',  (chunk: Buffer) => chunks.push(chunk))
    doc.on('end',   () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const PAGE_W  = doc.page.width - MARGIN * 2
    const L       = MARGIN
    const BOTTOM  = doc.page.height - MARGIN

    const LABEL_W = 165
    const VALUE_X = L + LABEL_W
    const VALUE_W = PAGE_W - LABEL_W

    const C_BLACK = '#111827'
    const C_DARK  = '#374151'
    const C_GRAY  = '#6b7280'
    const C_LIGHT = '#9ca3af'
    const C_GREEN = '#059669'
    const C_RULE  = '#d1d5db'

    let y = MARGIN

    function ensureSpace(needed: number) {
      if (y + needed > BOTTOM) {
        doc.addPage()
        y = MARGIN
      }
    }

    function drawDivider(color = C_RULE, weight = 0.5) {
      ensureSpace(12)
      doc.moveTo(L, y).lineTo(L + PAGE_W, y).strokeColor(color).lineWidth(weight).stroke()
      y += 12
    }

    function drawSectionTitle(title: string) {
      ensureSpace(24)
      doc.font('Helvetica-Bold')
         .fontSize(7.5)
         .fillColor(C_GRAY)
         .text(title.toUpperCase(), L, y, { width: PAGE_W, characterSpacing: 0.6 })
      y = doc.y + 7
    }

    function drawRow(
      label: string,
      value: string | undefined,
      opts: { bold?: boolean; color?: string } = {},
    ) {
      if (!value) return
      ensureSpace(16)

      const rowY   = y
      const vColor = opts.color ?? C_BLACK
      const vFont  = opts.bold ? 'Helvetica-Bold' : 'Helvetica'

      doc.font('Helvetica').fontSize(9.5).fillColor(C_GRAY)
         .text(label, L, rowY, { width: LABEL_W, lineBreak: true })
      const afterLabel = doc.y

      doc.font(vFont).fontSize(9.5).fillColor(vColor)
         .text(value, VALUE_X, rowY, { width: VALUE_W, lineBreak: true })
      const afterValue = doc.y

      y = Math.max(afterLabel, afterValue) + 5
    }

    function drawHighlightRow(label: string, value: string | undefined) {
      drawRow(label, value, { bold: true, color: C_GREEN })
    }

    function drawBodyText(text: string, color = C_GRAY) {
      ensureSpace(20)
      doc.font('Helvetica').fontSize(8.5).fillColor(color)
         .text(text, L, y, { width: PAGE_W, lineBreak: true })
      y = doc.y + 4
    }

    // ── Header ────────────────────────────────────────────────────────────────

    const displayName  = data.tenantPublicName ?? data.tenantName
    const emittedLabel = `Fecha de emisión: ${dateFromIso(data.emittedAt)}`

    const headerY = y

    doc.font('Helvetica-Bold').fontSize(17).fillColor(C_BLACK)
       .text(displayName, L, headerY, { width: PAGE_W * 0.55, lineBreak: false })
    const afterName = doc.y + doc.currentLineHeight(false) + 3

    doc.font('Helvetica').fontSize(8.5).fillColor(C_GRAY)
       .text('Generado por ReservaNex', L, afterName, { width: PAGE_W * 0.55, lineBreak: false })

    doc.font('Helvetica-Bold').fontSize(11).fillColor(C_DARK)
       .text('RECIBO DE ALQUILER MENSUAL', L, headerY, { width: PAGE_W, align: 'right', lineBreak: false })
    const afterKind = headerY + doc.currentLineHeight(false) + 4

    doc.font('Helvetica').fontSize(9).fillColor(C_GRAY)
       .text(`N.° ${data.receiptNumber}`, L, afterKind, { width: PAGE_W, align: 'right', lineBreak: false })
    const afterNum = afterKind + doc.currentLineHeight(false) + 3

    doc.font('Helvetica').fontSize(9).fillColor(C_GRAY)
       .text(emittedLabel, L, afterNum, { width: PAGE_W, align: 'right', lineBreak: false })

    y = Math.max(afterName + 20, afterNum + 20)

    drawDivider(C_RULE, 1)

    // ── Sección: Inquilino ────────────────────────────────────────────────────

    drawSectionTitle('Inquilino')
    drawRow('Inquilino:', str(data.contactName) ?? 'Sin datos')
    if (data.contactName && data.contactPhone) drawRow('Teléfono:', str(data.contactPhone))
    drawRow('Email:', str(data.contactEmail))

    drawDivider()

    // ── Sección: Contrato ─────────────────────────────────────────────────────

    drawSectionTitle('Contrato')
    if (data.propertyTitle)    drawRow('Propiedad:', str(data.propertyTitle))
    if (data.propertyLocation) drawRow('Dirección:', str(data.propertyLocation))
    drawRow('Inicio del contrato:', dateOnly(data.contractStartDate))
    drawRow(
      'Fin del contrato:',
      data.contractEndDate ? dateOnly(data.contractEndDate) : 'Sin fecha de fin',
    )

    drawDivider()

    // ── Sección: Período ──────────────────────────────────────────────────────

    drawSectionTitle('Período')
    const monthName    = MONTH_NAMES[(data.periodMonth - 1)] ?? String(data.periodMonth)
    const periodLabel  = `${monthName} ${data.periodYear}`
    drawRow('Período:', periodLabel)
    drawRow('Vencimiento:', dateOnly(data.dueDate))

    drawDivider()

    // ── Sección: Detalle de la cuota ──────────────────────────────────────────

    const cur = data.currency || 'ARS'

    drawSectionTitle('Detalle de la cuota')
    drawRow('Alquiler:', formatMoney(data.rentAmount, cur))
    if ((data.expensesAmount ?? 0) > 0)   drawRow('Expensas:',   formatMoney(data.expensesAmount!,   cur))
    if ((data.servicesAmount ?? 0) > 0)   drawRow('Servicios:',  formatMoney(data.servicesAmount!,   cur))
    if ((data.adjustmentsAmount ?? 0) > 0) drawRow('Ajustes:',   formatMoney(data.adjustmentsAmount!, cur))
    if ((data.lateFeeAmount ?? 0) > 0)    drawRow('Mora:',       formatMoney(data.lateFeeAmount!,    cur))
    drawRow('Total cuota:', formatMoney(data.chargeTotalAmount, cur), { bold: true })

    drawDivider()

    // ── Sección: Detalle del pago ─────────────────────────────────────────────

    const isPartial        = data.accumulatedPaid < data.chargeTotalAmount
    const remainingBalance = data.chargeTotalAmount - data.accumulatedPaid

    drawSectionTitle('Detalle del pago')
    drawHighlightRow('Monto de este pago:', formatMoney(data.amountPaidInPayment, cur))
    drawRow('Estado:', isPartial ? 'Pago parcial' : 'Pago total', { bold: true })
    drawRow('Pagado (acumulado):', formatMoney(data.accumulatedPaid, cur))
    if (isPartial) {
      drawRow('Saldo restante:', formatMoney(remainingBalance, cur))
    }
    drawRow('Fecha de pago:', dateOnly(data.paidAt))
    drawRow('Método de pago:', METHOD_LABEL[data.paymentMethod] ?? data.paymentMethod)
    if (data.notes) drawRow('Notas:', str(data.notes))

    // ── Footer ────────────────────────────────────────────────────────────────

    drawDivider(C_RULE, 1)

    drawBodyText(
      'Este comprobante fue generado por ReservaNex a partir de una registración manual del operador.',
      C_LIGHT,
    )

    if (data.receiptFooterText) {
      drawBodyText(data.receiptFooterText, C_GRAY)
    }

    doc.end()
  })
}

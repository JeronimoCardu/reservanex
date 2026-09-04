// PDF generation for reservation receipts.
// Uses pdfkit with built-in Helvetica fonts — no filesystem font loading.
// Must run in Node runtime only (server actions / API routes with runtime='nodejs').
// pdfkit is declared in serverExternalPackages so Next.js does not bundle it.

import PDFDocument from 'pdfkit'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReceiptKind = 'deposit' | 'full'

export type ReceiptData = {
  receiptNumber:          string
  receiptKind:            ReceiptKind
  emittedAt:              string        // ISO string — used for display only
  tenantName:             string
  tenantPublicName?:      string | null
  receiptFooterText?:     string | null
  contactName:            string
  contactPhone?:          string | null
  contactEmail?:          string | null
  propertyTitle?:         string | null
  unitName?:              string | null
  startDate:              string        // YYYY-MM-DD
  endDate:                string        // YYYY-MM-DD
  nightsCount?:           number | null
  guests:                 number
  currency:               string
  totalAmount?:           number | null
  depositRequiredAmount?: number | null
  amountPaid?:            number | null
  depositPaidAt?:         string | null // ISO string
  paidAt?:                string | null // ISO string
  paymentNotes?:          string | null
  receiptNotes?:          string | null
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

// Split YYYY-MM-DD directly to avoid new Date('YYYY-MM-DD') UTC midnight timezone bug.
function dateOnly(dateStr: string): string {
  const parts = dateStr.slice(0, 10).split('-')
  return `${parts[2]}/${parts[1]}/${parts[0]}`
}

// Format a full ISO timestamp for display (local-ish — just date portion is enough).
function dateFromIso(isoStr: string): string {
  const parts = isoStr.slice(0, 10).split('-')
  return `${parts[2]}/${parts[1]}/${parts[0]}`
}

// Night count from two YYYY-MM-DD strings — uses numeric Date constructor to avoid UTC shift.
function calcNights(start: string, end: string): number {
  const [sy, sm, sd] = start.slice(0, 10).split('-').map(Number)
  const [ey, em, ed] = end.slice(0, 10).split('-').map(Number)
  const d1 = new Date(sy!, sm! - 1, sd!)
  const d2 = new Date(ey!, em! - 1, ed!)
  return Math.max(0, Math.round((d2.getTime() - d1.getTime()) / 86400000))
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('es-AR', {
    style:                 'currency',
    currency:              currency || 'ARS',
    maximumFractionDigits: 0,
  }).format(amount)
}

// Return undefined for null/undefined/empty so drawRow can skip cleanly.
function str(v: string | number | null | undefined): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

// ─── PDF builder ──────────────────────────────────────────────────────────────

export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
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

    // Page dimensions
    const PAGE_W   = doc.page.width - MARGIN * 2   // usable width
    const L        = MARGIN
    const BOTTOM   = doc.page.height - MARGIN

    // Column layout for key-value rows
    const LABEL_W  = 165
    const VALUE_X  = L + LABEL_W
    const VALUE_W  = PAGE_W - LABEL_W

    // Colours
    const C_BLACK  = '#111827'
    const C_DARK   = '#374151'
    const C_GRAY   = '#6b7280'
    const C_LIGHT  = '#9ca3af'
    const C_GREEN  = '#059669'
    const C_RULE   = '#d1d5db'

    // Vertical cursor — the single source of truth for where to draw next.
    let y = MARGIN

    // ── Internal draw helpers ─────────────────────────────────────────────────

    // Ensure there is at least `needed` px before the bottom margin.
    // Adds a new page and resets y if not.
    function ensureSpace(needed: number) {
      if (y + needed > BOTTOM) {
        doc.addPage()
        y = MARGIN
      }
    }

    function drawDivider(color = C_RULE, weight = 0.5) {
      ensureSpace(12)
      doc.moveTo(L, y)
         .lineTo(L + PAGE_W, y)
         .strokeColor(color)
         .lineWidth(weight)
         .stroke()
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

    // Draw a two-column label → value row.
    // Both columns start at the same y. y advances by the taller of the two.
    function drawRow(
      label: string,
      value: string | undefined,
      opts: { bold?: boolean; color?: string } = {},
    ) {
      if (!value) return
      ensureSpace(16)

      const rowY    = y
      const vColor  = opts.color ?? C_BLACK
      const vFont   = opts.bold ? 'Helvetica-Bold' : 'Helvetica'

      // Draw label
      doc.font('Helvetica')
         .fontSize(9.5)
         .fillColor(C_GRAY)
         .text(label, L, rowY, { width: LABEL_W, lineBreak: true })
      const afterLabel = doc.y

      // Draw value at the SAME rowY (not relative to doc.y after label)
      doc.font(vFont)
         .fontSize(9.5)
         .fillColor(vColor)
         .text(value, VALUE_X, rowY, { width: VALUE_W, lineBreak: true })
      const afterValue = doc.y

      // Advance past whichever was taller
      y = Math.max(afterLabel, afterValue) + 5
    }

    // Draw a highlighted row (bold green value) for the key amount.
    function drawHighlightRow(label: string, value: string | undefined) {
      drawRow(label, value, { bold: true, color: C_GREEN })
    }

    // Draw plain body text (for footer/disclaimer).
    function drawBodyText(text: string, color = C_GRAY) {
      ensureSpace(20)
      doc.font('Helvetica')
         .fontSize(8.5)
         .fillColor(color)
         .text(text, L, y, { width: PAGE_W, lineBreak: true })
      y = doc.y + 4
    }

    // ── Header ────────────────────────────────────────────────────────────────
    // Left: company name + subtitle
    // Right: receipt type + number + date

    const kindLabel    = data.receiptKind === 'deposit' ? 'RECIBO DE SEÑA' : 'RECIBO DE PAGO COMPLETO'
    const displayName  = data.tenantPublicName ?? data.tenantName
    const emittedLabel = `Fecha de emisión: ${dateFromIso(data.emittedAt)}`

    const headerY = y

    // Left block
    doc.font('Helvetica-Bold')
       .fontSize(17)
       .fillColor(C_BLACK)
       .text(displayName, L, headerY, { width: PAGE_W * 0.55, lineBreak: false })

    const afterName = doc.y + doc.currentLineHeight(false) + 3

    doc.font('Helvetica')
       .fontSize(8.5)
       .fillColor(C_GRAY)
       .text('Generado por ReservaNex', L, afterName, { width: PAGE_W * 0.55, lineBreak: false })

    // Right block (aligned to right edge, anchored at same headerY)
    doc.font('Helvetica-Bold')
       .fontSize(11)
       .fillColor(C_DARK)
       .text(kindLabel, L, headerY, { width: PAGE_W, align: 'right', lineBreak: false })

    const afterKind = headerY + doc.currentLineHeight(false) + 4

    doc.font('Helvetica')
       .fontSize(9)
       .fillColor(C_GRAY)
       .text(`N.° ${data.receiptNumber}`, L, afterKind, { width: PAGE_W, align: 'right', lineBreak: false })

    const afterNum = afterKind + doc.currentLineHeight(false) + 3

    doc.font('Helvetica')
       .fontSize(9)
       .fillColor(C_GRAY)
       .text(emittedLabel, L, afterNum, { width: PAGE_W, align: 'right', lineBreak: false })

    // Advance y past the tallest of the two blocks
    y = Math.max(afterName + 20, afterNum + 20)

    drawDivider(C_RULE, 1)

    // ── Sección: Datos del cliente ────────────────────────────────────────────
    const clientName  = str(data.contactName)
    const clientPhone = str(data.contactPhone)
    const clientEmail = str(data.contactEmail)

    const clientDisplay = clientName ?? clientPhone ?? 'Sin datos'

    drawSectionTitle('Datos del cliente')
    drawRow('Cliente:',   clientDisplay)
    if (clientName && clientPhone) drawRow('Teléfono:', clientPhone)
    drawRow('Email:', clientEmail)

    drawDivider()

    // ── Sección: Detalle de la reserva ────────────────────────────────────────
    drawSectionTitle('Detalle de la reserva')

    const propStr = data.propertyTitle
      ? (data.unitName ? `${data.propertyTitle} — ${data.unitName}` : data.propertyTitle)
      : undefined

    drawRow('Propiedad:', propStr)

    const nights = data.nightsCount != null && data.nightsCount > 0
      ? data.nightsCount
      : calcNights(data.startDate, data.endDate)

    drawRow('Estadía:', `${dateOnly(data.startDate)} → ${dateOnly(data.endDate)}`)
    drawRow('Noches:',  str(nights > 0 ? nights : undefined))
    drawRow('Huéspedes:', str(data.guests))

    drawDivider()

    // ── Sección: Detalle de pago ──────────────────────────────────────────────
    drawSectionTitle('Detalle de pago')

    const cur = data.currency || 'ARS'

    drawRow('Total de la reserva:', data.totalAmount != null ? formatMoney(data.totalAmount, cur) : undefined)

    if (data.receiptKind === 'deposit') {
      drawRow('Seña requerida:', data.depositRequiredAmount != null ? formatMoney(data.depositRequiredAmount, cur) : undefined)
    }

    const paidAmt = data.amountPaid != null ? formatMoney(data.amountPaid, cur) : undefined
    drawHighlightRow('Monto recibido:', paidAmt)

    const statusLabel = data.receiptKind === 'deposit' ? 'Seña pagada' : 'Pago completo'
    drawRow('Estado:', statusLabel, { bold: true })

    if (data.receiptKind === 'deposit' && data.depositPaidAt) {
      drawRow('Seña registrada el:', dateFromIso(data.depositPaidAt))
    }
    if (data.receiptKind === 'full' && data.paidAt) {
      drawRow('Pago registrado el:', dateFromIso(data.paidAt))
    }
    drawRow('Notas de pago:', str(data.paymentNotes))
    drawRow('Notas del recibo:', str(data.receiptNotes))

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

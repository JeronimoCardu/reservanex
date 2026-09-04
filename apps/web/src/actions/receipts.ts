'use server'

import { z } from 'zod'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import { generateReceiptPdf } from '@/lib/generate-receipt-pdf'
import type { ActionResult } from '@/lib/action-result'

// ─── Types ────────────────────────────────────────────────────────────────────

export type GenerateReceiptResult = {
  documentId:    string
  receiptNumber: string
  name:          string
  fileUrl:       string
}

export type ReceiptDoc = {
  id:             string
  name:           string
  receipt_number: string | null
  notes:          string | null
  created_at:     string
  file_url:       string
  mime_type:      string | null
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const generateReceiptSchema = z.object({
  reservationId: z.string().uuid(),
  receiptKind:   z.enum(['deposit', 'full']),
  notes:         z.string().max(1000).optional(),
})

// ─── Generate receipt ─────────────────────────────────────────────────────────

export async function generateReservationReceiptAction(
  input: unknown,
): Promise<ActionResult<GenerateReceiptResult>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para generar recibos.' }
  }

  const parsed = generateReceiptSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { reservationId, receiptKind, notes } = parsed.data
  const admin = createAdminClient()

  // 1. Fetch reservation
  const { data: reservation } = await admin
    .from('reservations')
    .select('id, tenant_id, contact_id, property_id, unit_id, start_date, end_date, guests, nights_count, total_amount, price_currency, currency, deposit_required_amount, amount_paid, payment_status, deposit_paid_at, paid_at, payment_notes')
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada.' }
  }

  // 2. Validate payment state
  if (receiptKind === 'deposit') {
    const ok = reservation.payment_status === 'deposit_paid' || reservation.payment_status === 'paid'
    if (!ok) {
      return { success: false, error: 'La seña no está registrada. Registrá la seña antes de generar el recibo.' }
    }
  }
  if (receiptKind === 'full') {
    if (reservation.payment_status !== 'paid') {
      return { success: false, error: 'El pago completo no está registrado. Registrá el pago antes de generar el recibo.' }
    }
  }

  // 3. Fetch related data in parallel
  const contactIdToFetch  = reservation.contact_id
  const propertyIdToFetch = reservation.property_id
  const unitIdToFetch     = reservation.unit_id

  const [tenantRes, contactRes, propertyRes, unitRes] = await Promise.all([
    admin.from('tenants')  .select('name, public_name, receipt_footer_text').eq('id', ctx.tenantId).maybeSingle(),
    contactIdToFetch
      ? admin.from('contacts')  .select('name, phone, email').eq('id', contactIdToFetch).maybeSingle()
      : Promise.resolve({ data: null }),
    propertyIdToFetch
      ? admin.from('properties').select('title').eq('id', propertyIdToFetch).maybeSingle()
      : Promise.resolve({ data: null }),
    unitIdToFetch
      ? admin.from('units')     .select('name').eq('id', unitIdToFetch).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const tenant   = tenantRes.data
  const contact  = contactRes.data
  const property = propertyRes.data
  const unit     = unitRes.data

  // 4. Atomic receipt number via service_role RPC
  const { data: receiptNumber, error: rpcError } = await admin.rpc('next_receipt_number', {
    p_tenant_id: ctx.tenantId,
  })
  if (rpcError || !receiptNumber) {
    return { success: false, error: 'Error al generar número de recibo.' }
  }

  // 5. Build PDF buffer
  const currency = reservation.price_currency ?? reservation.currency ?? 'ARS'
  const now = new Date().toISOString()

  let pdfBuffer: Buffer
  try {
    pdfBuffer = await generateReceiptPdf({
      receiptNumber,
      receiptKind,
      emittedAt:              now,
      tenantName:             tenant?.name ?? 'Inmobiliaria',
      tenantPublicName:       tenant?.public_name,
      receiptFooterText:      tenant?.receipt_footer_text,
      contactName:            contact?.name ?? 'Cliente',
      contactPhone:           contact?.phone,
      contactEmail:           contact?.email,
      propertyTitle:          property?.title ?? null,
      unitName:               (unit as { name?: string } | null)?.name ?? null,
      startDate:              reservation.start_date,
      endDate:                reservation.end_date,
      nightsCount:            reservation.nights_count,
      guests:                 reservation.guests,
      currency,
      totalAmount:            reservation.total_amount,
      depositRequiredAmount:  reservation.deposit_required_amount,
      amountPaid:             reservation.amount_paid,
      depositPaidAt:          reservation.deposit_paid_at,
      paidAt:                 reservation.paid_at,
      paymentNotes:           reservation.payment_notes,
      receiptNotes:           notes?.trim() || undefined,
    })
  } catch (err) {
    console.error('[receipts] PDF generation failed:', err)
    return { success: false, error: 'Error al generar el PDF.' }
  }

  // 6. Upload to reservation-docs (private bucket)
  const storagePath = `${ctx.tenantId}/${reservationId}/receipts/${receiptNumber}.pdf`

  const { error: uploadError } = await admin.storage
    .from('reservation-docs')
    .upload(storagePath, pdfBuffer, {
      contentType:  'application/pdf',
      upsert:       false,
    })

  if (uploadError) {
    console.error('[receipts] storage upload failed:', uploadError.message)
    return { success: false, error: 'Error al subir el recibo al almacenamiento.' }
  }

  // 7. Create document row — pre-generate UUID so file_url is available on insert
  const docId   = crypto.randomUUID()
  const fileUrl = `/api/documents/${docId}`
  const kindLabel = receiptKind === 'deposit' ? 'Seña' : 'Pago completo'
  const docName = `Recibo ${receiptNumber} — ${kindLabel}`

  const { error: insertError } = await admin
    .from('documents')
    .insert({
      id:              docId,
      tenant_id:       ctx.tenantId,
      contact_id:      reservation.contact_id,
      reservation_id:  reservationId,
      property_id:     reservation.property_id,
      unit_id:         reservation.unit_id,
      document_type:   'receipt',
      source:          'generated',
      storage_bucket:  'reservation-docs',
      storage_path:    storagePath,
      file_url:        fileUrl,
      mime_type:       'application/pdf',
      file_size_bytes: pdfBuffer.byteLength,
      receipt_number:  receiptNumber,
      name:            docName,
      notes:           notes?.trim() || null,
    })

  if (insertError) {
    // Clean up the uploaded file so storage doesn't leak
    await admin.storage.from('reservation-docs').remove([storagePath])
    console.error('[receipts] document insert failed:', insertError.message)
    return { success: false, error: 'Error al registrar el recibo.' }
  }

  return {
    success: true,
    data: {
      documentId:    docId,
      receiptNumber,
      name:          docName,
      fileUrl,
    },
  }
}

// ─── List receipts for a reservation ─────────────────────────────────────────

export async function getReservationReceiptsAction(
  reservationId: string,
): Promise<ActionResult<ReceiptDoc[]>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('documents')
    .select('id, name, receipt_number, notes, created_at, file_url, mime_type')
    .eq('reservation_id', reservationId)
    .eq('tenant_id', ctx.tenantId)
    .eq('document_type', 'receipt')
    .order('created_at', { ascending: false })

  if (error) return { success: false, error: 'Error al cargar recibos.' }

  return { success: true, data: (data ?? []) as ReceiptDoc[] }
}

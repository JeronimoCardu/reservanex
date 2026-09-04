'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createClient } from '@orderflow/supabase/server'
import type { ActionResult } from '@/lib/action-result'

// ─── Types ────────────────────────────────────────────────────────────────────

export type MarkPaymentResult = {
  paymentStatus:                   string
  amountPaid:                      number | null
  paymentNotes:                    string | null
  depositPaidAt:                   string | null
  paidAt:                          string | null
  depositPaymentProofDocumentId:   string | null
  fullPaymentProofDocumentId:      string | null
}

// ─── Shared schema ────────────────────────────────────────────────────────────

const markPaymentSchema = z.object({
  reservationId: z.string().uuid(),
  amount:        z.coerce.number().min(0, 'El monto no puede ser negativo'),
  documentId:    z.string().uuid().optional(),
  notes:         z.string().max(2000).optional().nullable(),
})

// ─── Shared document validation ───────────────────────────────────────────────

async function validateProofDocument(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId:      string,
  reservationId: string,
  documentId:    string | undefined,
): Promise<string | null> {
  if (!documentId) return null

  const { data: doc } = await supabase
    .from('documents')
    .select('id, document_type, reservation_id')
    .eq('id', documentId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!doc) throw new Error('Comprobante no encontrado.')
  if (doc.document_type !== 'payment_proof') throw new Error('El documento no es un comprobante de pago.')
  if (doc.reservation_id !== reservationId) throw new Error('El comprobante no pertenece a esta reserva.')

  return documentId
}

// ─── Mark deposit as paid ─────────────────────────────────────────────────────
//
// Sets payment_status = 'deposit_paid', deposit_paid_at = now() (if not already
// set), amount_paid = amount, payment_notes, and optionally links a proof document.
// Does NOT confirm the reservation, generate receipts, or send WhatsApp.

export async function markReservationDepositPaidAction(
  input: unknown,
): Promise<ActionResult<MarkPaymentResult>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para registrar pagos.' }
  }

  const parsed = markPaymentSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { reservationId, amount, documentId, notes } = parsed.data
  const supabase = await createClient()

  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, payment_status, deposit_paid_at, paid_at, deposit_payment_proof_document_id, full_payment_proof_document_id')
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada.' }
  }

  // Bloquear downgrade: paid → deposit_paid no está permitido.
  if (reservation.payment_status === 'paid') {
    return {
      success: false,
      error: 'La reserva ya está marcada como pago completo. No se puede registrar seña desde este estado.',
    }
  }

  let validDocumentId: string | null = null
  try {
    validDocumentId = await validateProofDocument(supabase, ctx.tenantId, reservationId, documentId)
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Error al validar comprobante.' }
  }

  const now           = new Date().toISOString()
  const depositPaidAt = reservation.deposit_paid_at ?? now
  const trimmedNotes  = notes?.trim() || null

  const { error: updateError } = await supabase
    .from('reservations')
    .update({
      payment_status:                    'deposit_paid',
      amount_paid:                       amount,
      deposit_paid_at:                   depositPaidAt,
      payment_notes:                     trimmedNotes,
      deposit_payment_proof_document_id: validDocumentId,
      updated_at:                        now,
    })
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)

  if (updateError) {
    return { success: false, error: 'Error al registrar la seña.' }
  }

  return {
    success: true,
    data: {
      paymentStatus:                 'deposit_paid',
      amountPaid:                    amount,
      paymentNotes:                  trimmedNotes,
      depositPaidAt,
      paidAt:                        reservation.paid_at,
      depositPaymentProofDocumentId: validDocumentId,
      fullPaymentProofDocumentId:    reservation.full_payment_proof_document_id,
    },
  }
}

// ─── Mark as fully paid ───────────────────────────────────────────────────────
//
// Sets payment_status = 'paid', paid_at = now() (if not already set),
// amount_paid = amount, payment_notes, and optionally links a proof document.
// Does NOT confirm the reservation, generate receipts, or send WhatsApp.

export async function markReservationFullyPaidAction(
  input: unknown,
): Promise<ActionResult<MarkPaymentResult>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para registrar pagos.' }
  }

  const parsed = markPaymentSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { reservationId, amount, documentId, notes } = parsed.data
  const supabase = await createClient()

  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, payment_status, deposit_paid_at, paid_at, deposit_payment_proof_document_id, full_payment_proof_document_id')
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada.' }
  }

  let validDocumentId: string | null = null
  try {
    validDocumentId = await validateProofDocument(supabase, ctx.tenantId, reservationId, documentId)
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Error al validar comprobante.' }
  }

  const now          = new Date().toISOString()
  const paidAt       = reservation.paid_at ?? now
  const trimmedNotes = notes?.trim() || null

  const { error: updateError } = await supabase
    .from('reservations')
    .update({
      payment_status:                 'paid',
      amount_paid:                    amount,
      paid_at:                        paidAt,
      payment_notes:                  trimmedNotes,
      full_payment_proof_document_id: validDocumentId,
      updated_at:                     now,
    })
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)

  if (updateError) {
    return { success: false, error: 'Error al registrar el pago completo.' }
  }

  return {
    success: true,
    data: {
      paymentStatus:                 'paid',
      amountPaid:                    amount,
      paymentNotes:                  trimmedNotes,
      depositPaidAt:                 reservation.deposit_paid_at,
      paidAt,
      depositPaymentProofDocumentId: reservation.deposit_payment_proof_document_id,
      fullPaymentProofDocumentId:    validDocumentId,
    },
  }
}

// ─── Save payment (unified manual form) ──────────────────────────────────────
//
// Handles all payment statuses in a single action.
// Sets timestamps and proof document links based on the target status.
// Blocks paid → any other status (anti-downgrade).
// Does NOT generate receipts, confirm the reservation, or send WhatsApp.

const savePaymentSchema = z.object({
  reservationId: z.string().uuid(),
  paymentStatus: z.enum(['pending', 'deposit_paid', 'paid', 'refunded', 'not_required']),
  amountPaid:    z.coerce.number().min(0, 'El monto no puede ser negativo').optional(),
  documentId:    z.string().uuid().optional(),
  notes:         z.string().max(2000).optional().nullable(),
})

export async function saveReservationPaymentManualAction(
  input: unknown,
): Promise<ActionResult<MarkPaymentResult>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para registrar pagos.' }
  }

  const parsed = savePaymentSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { reservationId, paymentStatus, amountPaid, documentId, notes } = parsed.data
  const supabase = await createClient()

  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, payment_status, deposit_paid_at, paid_at, deposit_payment_proof_document_id, full_payment_proof_document_id')
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada.' }
  }

  // Bloquear downgrade desde 'paid'.
  if (reservation.payment_status === 'paid' && paymentStatus !== 'paid') {
    return {
      success: false,
      error: 'La reserva ya está marcada como pago completo. No se puede cambiar el estado de pago.',
    }
  }

  // Validate proof document only when relevant.
  let validDocumentId: string | null = null
  if (documentId && (paymentStatus === 'deposit_paid' || paymentStatus === 'paid')) {
    try {
      validDocumentId = await validateProofDocument(supabase, ctx.tenantId, reservationId, documentId)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Error al validar comprobante.' }
    }
  }

  const now          = new Date().toISOString()
  const trimmedNotes = notes?.trim() || null
  const finalAmount  = amountPaid ?? 0

  // Timestamps: preserve if already set for the target status.
  const depositPaidAt = paymentStatus === 'deposit_paid'
    ? (reservation.deposit_paid_at ?? now)
    : reservation.deposit_paid_at

  const paidAt = paymentStatus === 'paid'
    ? (reservation.paid_at ?? now)
    : reservation.paid_at

  // Proof links: update only for the matching status; preserve the other.
  const depositProofId = paymentStatus === 'deposit_paid'
    ? (validDocumentId ?? reservation.deposit_payment_proof_document_id)
    : reservation.deposit_payment_proof_document_id

  const fullProofId = paymentStatus === 'paid'
    ? (validDocumentId ?? reservation.full_payment_proof_document_id)
    : reservation.full_payment_proof_document_id

  const { error: updateError } = await supabase
    .from('reservations')
    .update({
      payment_status:                    paymentStatus,
      amount_paid:                       finalAmount,
      deposit_paid_at:                   depositPaidAt,
      paid_at:                           paidAt,
      payment_notes:                     trimmedNotes,
      deposit_payment_proof_document_id: depositProofId,
      full_payment_proof_document_id:    fullProofId,
      updated_at:                        now,
    })
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)

  if (updateError) {
    return { success: false, error: 'Error al guardar el pago.' }
  }

  revalidatePath('/dashboard/reservations')

  return {
    success: true,
    data: {
      paymentStatus,
      amountPaid:                    finalAmount,
      paymentNotes:                  trimmedNotes,
      depositPaidAt,
      paidAt,
      depositPaymentProofDocumentId: depositProofId,
      fullPaymentProofDocumentId:    fullProofId,
    },
  }
}

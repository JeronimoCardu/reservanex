'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import * as repo from '@/lib/repositories/reservations.repository'
import * as events from '@/lib/repositories/reservation-events.repository'
import type { ActionResult } from '@/lib/action-result'
import type { Json } from '@orderflow/types'
import type { NoteRow } from '@/lib/repositories/notes.repository'
import type { ReservationEventRow } from '@/lib/repositories/reservation-events.repository'

const RESERVATIONS_PATH = '/dashboard/reservations'
const DETAIL_PATH = (id: string) => `/dashboard/conversations/${id}`

// ─── Confirm ─────────────────────────────────────────────────────────────────

export async function confirmReservationAction(reservationId: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para confirmar reservas.' }
  }

  const { createClient } = await import('@orderflow/supabase/server')
  const supabase = await createClient()

  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, property_id, start_date, end_date, status')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', reservationId)
    .eq('status', 'pre_reserved')
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada, ya confirmada o sin permisos.' }
  }

  if (reservation.property_id) {
    const now = new Date().toISOString()

    const { data: confirmedConflicts } = await supabase
      .from('reservations')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('property_id', reservation.property_id)
      .neq('id', reservationId)
      .eq('status', 'confirmed')
      .is('deleted_at', null)
      .lt('start_date', reservation.end_date)
      .gt('end_date', reservation.start_date)
      .limit(1)

    if (confirmedConflicts && confirmedConflicts.length > 0) {
      return { success: false, error: 'No se puede confirmar: hay otra reserva confirmada para esas fechas.' }
    }

    const { data: pendingConflicts } = await supabase
      .from('reservations')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('property_id', reservation.property_id)
      .neq('id', reservationId)
      .eq('status', 'pre_reserved')
      .is('deleted_at', null)
      .lt('start_date', reservation.end_date)
      .gt('end_date', reservation.start_date)
      .gt('expires_at', now)
      .limit(1)

    if (pendingConflicts && pendingConflicts.length > 0) {
      return { success: false, error: 'No se puede confirmar: hay otra reserva pendiente para esas fechas.' }
    }

    const { data: blockConflicts } = await supabase
      .from('property_availability_blocks')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('property_id', reservation.property_id)
      .is('deleted_at', null)
      .lt('start_date', reservation.end_date)
      .gt('end_date', reservation.start_date)
      .limit(1)

    if (blockConflicts && blockConflicts.length > 0) {
      return { success: false, error: 'No se puede confirmar: esas fechas están bloqueadas manualmente.' }
    }
  }

  try {
    const { conversation_id } = await repo.confirmReservation(ctx.tenantId, reservationId, ctx.userId)
    await events.createReservationEvent(ctx.tenantId, reservationId, ctx.userId, 'confirmed', {})
    revalidatePath(RESERVATIONS_PATH)
    if (conversation_id) revalidatePath(DETAIL_PATH(conversation_id))
    return { success: true }
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return { success: false, error: 'Reserva no encontrada o sin permisos.' }
    }
    return { success: false, error: 'Error al confirmar la reserva. Intentá de nuevo.' }
  }
}

// ─── Complete ─────────────────────────────────────────────────────────────────

export async function completeReservationAction(reservationId: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para marcar reservas como completadas.' }
  }

  const { createClient } = await import('@orderflow/supabase/server')
  const supabase = await createClient()

  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, end_date, status')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', reservationId)
    .eq('status', 'confirmed')
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada o no está confirmada.' }
  }

  const today = new Date().toISOString().split('T')[0]!
  if (reservation.end_date > today) {
    return { success: false, error: 'La estadía aún no finalizó. Solo se puede completar cuando end_date ≤ hoy.' }
  }

  try {
    const { conversation_id } = await repo.completeReservation(ctx.tenantId, reservationId, ctx.userId)
    await events.createReservationEvent(ctx.tenantId, reservationId, ctx.userId, 'completed', {})
    revalidatePath(RESERVATIONS_PATH)
    if (conversation_id) revalidatePath(DETAIL_PATH(conversation_id))
    return { success: true }
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return { success: false, error: 'Reserva no encontrada o sin permisos.' }
    }
    return { success: false, error: 'Error al completar la reserva. Intentá de nuevo.' }
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

const cancelSchema = z.object({
  reason: z.string().max(1000).optional(),
})

export async function cancelReservationAction(
  reservationId: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para cancelar reservas.' }
  }

  const parsed = cancelSchema.safeParse(input ?? {})
  if (!parsed.success) {
    return { success: false, error: 'Datos inválidos.' }
  }

  try {
    const { conversation_id } = await repo.cancelReservation(
      ctx.tenantId,
      reservationId,
      ctx.userId,
      parsed.data.reason ?? null,
    )
    await events.createReservationEvent(ctx.tenantId, reservationId, ctx.userId, 'cancelled', {
      reason: parsed.data.reason ?? null,
    })
    revalidatePath(RESERVATIONS_PATH)
    if (conversation_id) revalidatePath(DETAIL_PATH(conversation_id))
    return { success: true }
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return { success: false, error: 'Reserva no encontrada, ya cancelada o sin permisos.' }
    }
    return { success: false, error: 'Error al cancelar la reserva. Intentá de nuevo.' }
  }
}

// ─── Reschedule ───────────────────────────────────────────────────────────────

const rescheduleSchema = z.object({
  start_date: z.string().min(1, 'Fecha de inicio requerida'),
  end_date:   z.string().min(1, 'Fecha de fin requerida'),
  guests:     z.coerce.number().int().min(1, 'Mínimo 1 persona'),
})

export async function rescheduleReservationAction(
  reservationId: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para reprogramar reservas.' }
  }

  const parsed = rescheduleSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { start_date, end_date, guests } = parsed.data

  if (new Date(end_date) <= new Date(start_date)) {
    return { success: false, error: 'La fecha de fin debe ser posterior a la de inicio.' }
  }

  const { createClient } = await import('@orderflow/supabase/server')
  const supabase = await createClient()

  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, property_id, status, price_currency, start_date, end_date, guests')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', reservationId)
    .in('status', ['pre_reserved', 'confirmed'])
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada o ya no es modificable.' }
  }

  if (!reservation.property_id) {
    return { success: false, error: 'Esta reserva no tiene propiedad asignada.' }
  }

  const { data: reschProp } = await supabase
    .from('properties')
    .select('operation_type')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', reservation.property_id)
    .is('deleted_at', null)
    .maybeSingle()
  if (reschProp?.operation_type !== 'temporary_rental') {
    return { success: false, error: 'Solo se pueden reprogramar reservas de alquiler temporario.' }
  }

  const now = new Date().toISOString()

  const { data: confirmedConflicts } = await supabase
    .from('reservations')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('property_id', reservation.property_id)
    .neq('id', reservationId)
    .eq('status', 'confirmed')
    .is('deleted_at', null)
    .lt('start_date', end_date)
    .gt('end_date', start_date)
    .limit(1)

  if (confirmedConflicts && confirmedConflicts.length > 0) {
    return { success: false, error: 'No se puede reprogramar: hay una reserva confirmada en esas fechas.' }
  }

  const { data: pendingConflicts } = await supabase
    .from('reservations')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('property_id', reservation.property_id)
    .neq('id', reservationId)
    .eq('status', 'pre_reserved')
    .is('deleted_at', null)
    .lt('start_date', end_date)
    .gt('end_date', start_date)
    .gt('expires_at', now)
    .limit(1)

  if (pendingConflicts && pendingConflicts.length > 0) {
    return { success: false, error: 'No se puede reprogramar: hay una reserva pendiente en esas fechas.' }
  }

  const { data: blockConflicts } = await supabase
    .from('property_availability_blocks')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('property_id', reservation.property_id)
    .is('deleted_at', null)
    .lt('start_date', end_date)
    .gt('end_date', start_date)
    .limit(1)

  if (blockConflicts && blockConflicts.length > 0) {
    return { success: false, error: 'No se puede reprogramar: esas fechas están bloqueadas.' }
  }

  const { data: property } = await supabase
    .from('properties')
    .select('pricing_mode, currency, base_price_per_night, cleaning_fee, temporary_deposit_amount, temporary_deposit_percent')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', reservation.property_id)
    .is('deleted_at', null)
    .maybeSingle()

  const startDate   = new Date(`${start_date}T00:00:00Z`)
  const endDate     = new Date(`${end_date}T00:00:00Z`)
  const nightsCount = Math.round((endDate.getTime() - startDate.getTime()) / 86400000)
  const currency    = property?.currency ?? reservation.price_currency ?? 'ARS'

  let nightly_price_snapshot:  number | null = null
  let subtotal_amount:         number | null = null
  let fees_amount                            = 0
  let total_amount:            number | null = null
  let deposit_required_amount: number | null = null
  const pricing_breakdown: Record<string, unknown> = {}
  const pricing_mode_snapshot = property?.pricing_mode ?? 'consult'

  if (property?.pricing_mode === 'fixed' && property.base_price_per_night) {
    nightly_price_snapshot  = property.base_price_per_night
    subtotal_amount         = nightly_price_snapshot * nightsCount
    fees_amount             = property.cleaning_fee ?? 0
    total_amount            = subtotal_amount + fees_amount

    if (property.temporary_deposit_amount) {
      deposit_required_amount = property.temporary_deposit_amount
    } else if (property.temporary_deposit_percent) {
      deposit_required_amount = Math.round(total_amount * property.temporary_deposit_percent / 100)
    }

    pricing_breakdown['nightly_price'] = nightly_price_snapshot
    pricing_breakdown['nights']        = nightsCount
    pricing_breakdown['subtotal']      = subtotal_amount
    pricing_breakdown['cleaning_fee']  = fees_amount
    pricing_breakdown['total']         = total_amount
    pricing_breakdown['deposit']       = deposit_required_amount
  }

  try {
    const { conversation_id } = await repo.rescheduleReservation(ctx.tenantId, reservationId, {
      start_date,
      end_date,
      guests,
      nights_count:            nightsCount,
      nightly_price_snapshot,
      subtotal_amount,
      fees_amount,
      total_amount,
      deposit_required_amount,
      pricing_mode_snapshot,
      pricing_breakdown:       pricing_breakdown as Json,
      price_currency:          currency,
    })
    await events.createReservationEvent(ctx.tenantId, reservationId, ctx.userId, 'rescheduled', {
      old_start_date: reservation.start_date,
      old_end_date:   reservation.end_date,
      old_guests:     reservation.guests,
      new_start_date: start_date,
      new_end_date:   end_date,
      new_guests:     guests,
    })
    revalidatePath(RESERVATIONS_PATH)
    if (conversation_id) revalidatePath(DETAIL_PATH(conversation_id))
    return { success: true }
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return { success: false, error: 'Reserva no encontrada o no modificable.' }
    }
    return { success: false, error: 'Error al reprogramar la reserva. Intentá de nuevo.' }
  }
}

// ─── Create (manual) ─────────────────────────────────────────────────────────

const createReservationSchema = z.object({
  conversation_id: z.string().uuid().nullable(),
  property_id:     z.string().uuid('Propiedad requerida'),
  unit_id:         z.string().uuid().nullable().optional(),
  start_date:      z.string().min(1, 'Fecha de inicio requerida'),
  end_date:        z.string().min(1, 'Fecha de fin requerida'),
  guests:          z.coerce.number().int().min(1, 'Mínimo 1 persona'),
  status:          z.enum(['inquiry', 'interested', 'pre_reserved', 'confirmed']).optional(),
  notes:           z.string().max(2000).nullable().optional(),
  contact_id:      z.string().uuid('Contacto requerido'),
})

export async function createReservationAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para crear reservas manualmente.' }
  }

  const parsed = createReservationSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const d = parsed.data

  if (new Date(d.end_date) <= new Date(d.start_date)) {
    return { success: false, error: 'La fecha de fin debe ser posterior a la de inicio.' }
  }

  const { createClient } = await import('@orderflow/supabase/server')
  const supabase = await createClient()

  const { data: property } = await supabase
    .from('properties')
    .select('id, operation_type, pricing_mode, currency, base_price_per_night, cleaning_fee, temporary_deposit_amount, temporary_deposit_percent')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', d.property_id)
    .is('deleted_at', null)
    .maybeSingle()
  if (!property) {
    return { success: false, error: 'La propiedad no existe en tu organización.' }
  }
  if (property.operation_type !== 'temporary_rental') {
    return { success: false, error: 'Solo se pueden crear reservas para propiedades de alquiler temporario.' }
  }

  if (d.unit_id) {
    const { count: unitCount } = await supabase
      .from('units')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('id', d.unit_id)
      .eq('property_id', d.property_id)
      .is('deleted_at', null)
    if (!unitCount) {
      return { success: false, error: 'La unidad no pertenece a esa propiedad.' }
    }
  }

  const { count: contactCount } = await supabase
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId)
    .eq('id', d.contact_id)
    .is('deleted_at', null)
  if (!contactCount) {
    return { success: false, error: 'El contacto no existe en tu organización.' }
  }

  const targetStatus = d.status ?? 'pre_reserved'
  if (targetStatus === 'pre_reserved' || targetStatus === 'confirmed') {
    const now = new Date().toISOString()

    const { data: confirmedConflicts } = await supabase
      .from('reservations')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('property_id', d.property_id)
      .eq('status', 'confirmed')
      .is('deleted_at', null)
      .lt('start_date', d.end_date)
      .gt('end_date', d.start_date)
      .limit(1)

    if (confirmedConflicts && confirmedConflicts.length > 0) {
      return { success: false, error: 'Hay una reserva confirmada en esas fechas.' }
    }

    const { data: pendingConflicts } = await supabase
      .from('reservations')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('property_id', d.property_id)
      .eq('status', 'pre_reserved')
      .is('deleted_at', null)
      .lt('start_date', d.end_date)
      .gt('end_date', d.start_date)
      .gt('expires_at', now)
      .limit(1)

    if (pendingConflicts && pendingConflicts.length > 0) {
      return { success: false, error: 'Hay una reserva pendiente (no expirada) en esas fechas.' }
    }

    const { data: blockConflicts } = await supabase
      .from('property_availability_blocks')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('property_id', d.property_id)
      .is('deleted_at', null)
      .lt('start_date', d.end_date)
      .gt('end_date', d.start_date)
      .limit(1)

    if (blockConflicts && blockConflicts.length > 0) {
      return { success: false, error: 'Esas fechas están bloqueadas manualmente.' }
    }
  }

  const startDate   = new Date(`${d.start_date}T00:00:00Z`)
  const endDate     = new Date(`${d.end_date}T00:00:00Z`)
  const nightsCount = Math.round((endDate.getTime() - startDate.getTime()) / 86400000)
  const currency    = property?.currency ?? 'ARS'

  let nightly_price_snapshot:  number | null = null
  let subtotal_amount:         number | null = null
  let fees_amount                            = 0
  let total_amount:            number | null = null
  let deposit_required_amount: number | null = null
  const pricing_breakdown: Record<string, unknown> = {}
  const pricing_mode_snapshot = property?.pricing_mode ?? 'consult'

  if (property?.pricing_mode === 'fixed' && property.base_price_per_night) {
    nightly_price_snapshot  = property.base_price_per_night
    subtotal_amount         = nightly_price_snapshot * nightsCount
    fees_amount             = property.cleaning_fee ?? 0
    total_amount            = subtotal_amount + fees_amount

    if (property.temporary_deposit_amount) {
      deposit_required_amount = property.temporary_deposit_amount
    } else if (property.temporary_deposit_percent) {
      deposit_required_amount = Math.round(total_amount * property.temporary_deposit_percent / 100)
    }

    pricing_breakdown['nightly_price'] = nightly_price_snapshot
    pricing_breakdown['nights']        = nightsCount
    pricing_breakdown['subtotal']      = subtotal_amount
    pricing_breakdown['cleaning_fee']  = fees_amount
    pricing_breakdown['total']         = total_amount
    pricing_breakdown['deposit']       = deposit_required_amount
  }

  const expires_at = targetStatus === 'pre_reserved'
    ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    : null

  try {
    const reservation = await repo.createReservation(ctx.tenantId, {
      contact_id:              d.contact_id,
      conversation_id:         d.conversation_id,
      property_id:             d.property_id,
      unit_id:                 d.unit_id ?? null,
      start_date:              d.start_date,
      end_date:                d.end_date,
      guests:                  d.guests,
      nights_count:            nightsCount,
      total_amount,
      subtotal_amount,
      fees_amount,
      nightly_price_snapshot,
      deposit_required_amount,
      pricing_mode_snapshot,
      pricing_breakdown:       pricing_breakdown as Json,
      currency,
      price_currency:          currency,
      status:                  targetStatus,
      source:                  'manual',
      notes:                   d.notes ?? null,
      expires_at,
    })

    await events.createReservationEvent(ctx.tenantId, reservation.id, ctx.userId, 'manual_created', {
      status: targetStatus,
    })

    revalidatePath(RESERVATIONS_PATH)
    if (d.conversation_id) revalidatePath(DETAIL_PATH(d.conversation_id))

    return { success: true, data: { id: reservation.id } }
  } catch {
    return { success: false, error: 'Error al crear la reserva. Intentá de nuevo.' }
  }
}

// ─── Update status (non-critical transitions: inquiry/interested only) ────────

const updateStatusSchema = z.object({
  status: z.enum(['inquiry', 'interested']),
})

export async function updateReservationStatusAction(
  reservationId: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para modificar reservas.' }
  }

  const parsed = updateStatusSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: 'Estado inválido. Usá confirmar/cancelar para esas operaciones.' }
  }

  try {
    const { conversation_id } = await repo.updateReservationStatus(
      ctx.tenantId,
      reservationId,
      parsed.data.status,
    )
    revalidatePath(RESERVATIONS_PATH)
    if (conversation_id) revalidatePath(DETAIL_PATH(conversation_id))
    return { success: true }
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return { success: false, error: 'Reserva no encontrada o sin permisos.' }
    }
    return { success: false, error: 'Error al actualizar el estado. Intentá de nuevo.' }
  }
}

// ─── Update payment ───────────────────────────────────────────────────────────

const paymentSchema = z.object({
  payment_status: z.enum(['pending', 'deposit_paid', 'paid', 'refunded', 'not_required']),
  amount_paid:    z.coerce.number().min(0, 'El monto no puede ser negativo'),
  payment_notes:  z.string().max(2000).optional().nullable(),
})

export async function updateReservationPaymentAction(
  reservationId: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para actualizar el estado de pago.' }
  }

  const parsed = paymentSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { createClient } = await import('@orderflow/supabase/server')
  const supabase = await createClient()

  const { data: current } = await supabase
    .from('reservations')
    .select('id, payment_status, deposit_paid_at, paid_at, total_amount, conversation_id')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', reservationId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!current) {
    return { success: false, error: 'Reserva no encontrada.' }
  }

  const { payment_status, amount_paid, payment_notes } = parsed.data

  // Bloquear downgrade desde 'paid': no se puede retroceder el estado de pago por este flujo.
  if (current.payment_status === 'paid' && payment_status !== 'paid') {
    return {
      success: false,
      error: 'La reserva ya está marcada como pago completo. No se puede cambiar el estado de pago desde aquí.',
    }
  }

  const now = new Date().toISOString()
  const deposit_paid_at = payment_status === 'deposit_paid' && !current.deposit_paid_at ? now : current.deposit_paid_at
  const paid_at         = payment_status === 'paid'         && !current.paid_at         ? now : current.paid_at

  const { error } = await supabase
    .from('reservations')
    .update({
      payment_status,
      amount_paid,
      payment_notes:   payment_notes ?? null,
      deposit_paid_at,
      paid_at,
      updated_at:      now,
    })
    .eq('tenant_id', ctx.tenantId)
    .eq('id', reservationId)
    .is('deleted_at', null)

  if (error) {
    return { success: false, error: 'Error al guardar el pago.' }
  }

  await events.createReservationEvent(ctx.tenantId, reservationId, ctx.userId, 'payment_updated', {
    payment_status,
    amount_paid,
    old_payment_status: current.payment_status,
  })

  revalidatePath(RESERVATIONS_PATH)

  return { success: true }
}

// ─── Data queries (called from client via server action) ──────────────────────

export async function getReservationNotesAction(
  reservationId: string,
): Promise<ActionResult<NoteRow[]>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  try {
    const { listReservationNotes } = await import('@/lib/repositories/notes.repository')
    const notes = await listReservationNotes(ctx.tenantId, reservationId)
    return { success: true, data: notes }
  } catch {
    return { success: false, error: 'Error al cargar notas.' }
  }
}

export async function getReservationEventsAction(
  reservationId: string,
): Promise<ActionResult<ReservationEventRow[]>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  try {
    const evts = await events.listReservationEvents(ctx.tenantId, reservationId)
    return { success: true, data: evts }
  } catch {
    return { success: false, error: 'Error al cargar historial.' }
  }
}

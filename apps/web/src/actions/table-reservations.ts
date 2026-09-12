'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@orderflow/supabase/server'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import type { ActionResult } from '@/lib/action-result'

// Fase 3E-C2 — ciclo de vida de una reserva de mesa.
//
// Ninguna de estas actions escribe la tabla: table_reservations no concede
// INSERT/UPDATE/DELETE a authenticated, ni por policy ni por grant. Todo pasa
// por RPC SECURITY DEFINER que revalidan actor, tenant, permiso, estado y
// transición con la fila lockeada.
//
// Los chequeos de acá son de UX. La autoridad es la RPC.

const TABLES_PATH   = '/dashboard/table-reservations'
const REQUESTS_PATH = '/dashboard/requests'
const MAX_REASON    = 500

function puedeGestionar(ctx: { role: string; canManageTableReservations: boolean }): boolean {
  return ctx.role === 'owner' || ctx.canManageTableReservations
}

/** Outcomes compartidos por las cuatro RPC. */
function mensajeComun(outcome: string, data: unknown): string | null {
  switch (outcome) {
    case 'unauthenticated':           return 'Tu sesión expiró. Volvé a entrar.'
    case 'platform_user_not_allowed': return 'No disponible en modo setup.'
    case 'not_a_tenant_member':       return 'Tu usuario no pertenece a esta organización.'
    case 'forbidden':                 return 'No tenés permiso para gestionar reservas de mesa.'
    case 'not_found':                 return 'Reserva no encontrada.'
    case 'invalid_party_size':        return 'La cantidad de personas tiene que estar entre 1 y 50.'
    case 'scheduled_time_in_past':    return 'Esa fecha y hora ya pasaron. Elegí un momento futuro.'
    case 'invalid_schedule': {
      const reason = (data as { reason?: string } | null)?.reason
      return reason === 'invalid_tenant_timezone' || reason === 'tenant_without_timezone'
        ? 'La organización no tiene una zona horaria válida configurada. Revisala en Configuración.'
        : 'La fecha y la hora no son válidas.'
    }
    default: return null
  }
}

/** Un estado terminal no vuelve atrás: el mensaje tiene que decir cuál es. */
function mensajeTerminal(status: string | undefined, accion: string): string {
  const como =
    status === 'completed' ? 'ya fue marcada como realizada' :
    status === 'cancelled' ? 'está cancelada' :
    status === 'no_show'   ? 'está marcada como ausencia' :
                             'ya no está confirmada'
  return `Esta reserva ${como}, así que no se puede ${accion}.`
}

// ─── Editar / reagendar ──────────────────────────────────────────────────────

export async function editTableReservationAction(
  reservationId: string,
  scheduledDate: string,
  scheduledTime: string,
  partySize?: number,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (!puedeGestionar(ctx)) return { success: false, error: 'No tenés permiso para gestionar reservas de mesa.' }

  if (!scheduledDate || !scheduledTime) {
    return { success: false, error: 'Elegí la fecha y la hora.' }
  }
  if (partySize !== undefined && (!Number.isInteger(partySize) || partySize < 1 || partySize > 50)) {
    return { success: false, error: 'La cantidad de personas tiene que estar entre 1 y 50.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('edit_table_reservation', {
    p_reservation_id: reservationId,
    p_scheduled_date: scheduledDate,
    p_scheduled_time: scheduledTime,
    ...(partySize === undefined ? {} : { p_party_size: partySize }),
  })

  if (error) {
    console.error('[table-reservations] edit falló', { reservationId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos editar la reserva. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string } | null)?.outcome ?? 'unknown'

  if (outcome === 'edited') {
    revalidatePath(TABLES_PATH)
    revalidatePath(REQUESTS_PATH)
    return { success: true }
  }

  if (outcome === 'not_editable') {
    revalidatePath(TABLES_PATH)
    return { success: false, error: mensajeTerminal((data as { status?: string } | null)?.status, 'editar') }
  }

  return { success: false, error: mensajeComun(outcome, data) ?? 'No pudimos editar la reserva.' }
}

// ─── Marcar como realizada ───────────────────────────────────────────────────

export async function completeTableReservationAction(reservationId: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (!puedeGestionar(ctx)) return { success: false, error: 'No tenés permiso para gestionar reservas de mesa.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('complete_table_reservation', { p_reservation_id: reservationId })

  if (error) {
    console.error('[table-reservations] complete falló', { reservationId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos actualizar la reserva. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string } | null)?.outcome ?? 'unknown'

  // Repetir la acción no es un error: el resultado es el que se quería.
  if (outcome === 'completed' || outcome === 'already_completed') {
    revalidatePath(TABLES_PATH)
    return { success: true }
  }

  if (outcome === 'invalid_transition') {
    revalidatePath(TABLES_PATH)
    return { success: false, error: mensajeTerminal((data as { status?: string } | null)?.status, 'marcar como realizada') }
  }

  return { success: false, error: mensajeComun(outcome, data) ?? 'No pudimos actualizar la reserva.' }
}

// ─── Cancelar ────────────────────────────────────────────────────────────────

export async function cancelTableReservationAction(
  reservationId: string,
  reason?: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (!puedeGestionar(ctx)) return { success: false, error: 'No tenés permiso para gestionar reservas de mesa.' }

  const motivo = (reason ?? '').trim()
  if (motivo.length > MAX_REASON) {
    return { success: false, error: `El motivo no puede superar los ${MAX_REASON} caracteres.` }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('cancel_table_reservation', {
    p_reservation_id: reservationId,
    ...(motivo === '' ? {} : { p_reason: motivo }),
  })

  if (error) {
    console.error('[table-reservations] cancel falló', { reservationId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos cancelar la reserva. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string } | null)?.outcome ?? 'unknown'

  if (outcome === 'cancelled' || outcome === 'already_cancelled') {
    revalidatePath(TABLES_PATH)
    return { success: true }
  }

  if (outcome === 'invalid_transition') {
    revalidatePath(TABLES_PATH)
    return { success: false, error: mensajeTerminal((data as { status?: string } | null)?.status, 'cancelar') }
  }

  if (outcome === 'reason_too_long' || outcome === 'reason_invalid') {
    return { success: false, error: 'El motivo no es válido.' }
  }

  return { success: false, error: mensajeComun(outcome, data) ?? 'No pudimos cancelar la reserva.' }
}

// ─── No-show ─────────────────────────────────────────────────────────────────

export async function markTableReservationNoShowAction(reservationId: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (!puedeGestionar(ctx)) return { success: false, error: 'No tenés permiso para gestionar reservas de mesa.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('mark_table_reservation_no_show', { p_reservation_id: reservationId })

  if (error) {
    console.error('[table-reservations] no_show falló', { reservationId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos actualizar la reserva. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string } | null)?.outcome ?? 'unknown'

  if (outcome === 'no_show' || outcome === 'already_no_show') {
    revalidatePath(TABLES_PATH)
    return { success: true }
  }

  if (outcome === 'invalid_transition') {
    revalidatePath(TABLES_PATH)
    return { success: false, error: mensajeTerminal((data as { status?: string } | null)?.status, 'marcar como ausencia') }
  }

  return { success: false, error: mensajeComun(outcome, data) ?? 'No pudimos actualizar la reserva.' }
}

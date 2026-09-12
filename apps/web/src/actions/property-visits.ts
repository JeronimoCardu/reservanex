'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@orderflow/supabase/server'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import type { ActionResult } from '@/lib/action-result'

// Fase 3E-B2 — ciclo de vida de una visita agendada.
//
// Ninguna de estas actions escribe la tabla: property_visits no concede
// INSERT/UPDATE/DELETE a authenticated, ni por policy ni por grant. Todo pasa
// por RPC SECURITY DEFINER que revalidan actor, tenant, permiso, estado y
// transición con la fila lockeada.
//
// Los chequeos de permiso de acá son de UX (mensaje temprano y claro). La
// autoridad es la RPC, que no confía en nada de este archivo.

const VISITS_PATH   = '/dashboard/visits'
const REQUESTS_PATH = '/dashboard/requests'
const MAX_REASON    = 500

function puedeGestionar(ctx: { role: string; canManageVisits: boolean }): boolean {
  return ctx.role === 'owner' || ctx.canManageVisits
}

/** Traduce los outcomes que comparten las tres RPC. */
function mensajeComun(outcome: string, data: unknown): string | null {
  switch (outcome) {
    case 'unauthenticated':
      return 'Tu sesión expiró. Volvé a entrar.'
    case 'platform_user_not_allowed':
      return 'No disponible en modo setup.'
    case 'not_a_tenant_member':
      return 'Tu usuario no pertenece a esta organización.'
    case 'forbidden':
      return 'No tenés permiso para gestionar visitas.'
    case 'not_found':
      return 'Visita no encontrada.'
    case 'invalid_schedule': {
      const reason = (data as { reason?: string } | null)?.reason
      return reason === 'invalid_tenant_timezone' || reason === 'tenant_without_timezone'
        ? 'La organización no tiene una zona horaria válida configurada. Revisala en Configuración.'
        : 'La fecha y la hora no son válidas.'
    }
    case 'scheduled_time_in_past':
      return 'Esa fecha y hora ya pasaron. Elegí un momento futuro.'
    default:
      return null
  }
}

// ─── Reagendar ───────────────────────────────────────────────────────────────

export async function rescheduleVisitAction(
  visitId: string,
  scheduledDate: string,
  scheduledTime: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (!puedeGestionar(ctx)) return { success: false, error: 'No tenés permiso para gestionar visitas.' }

  if (!scheduledDate || !scheduledTime) {
    return { success: false, error: 'Elegí la fecha y la hora nuevas.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('reschedule_property_visit', {
    p_visit_id:       visitId,
    p_scheduled_date: scheduledDate,
    p_scheduled_time: scheduledTime,
  })

  if (error) {
    console.error('[property-visits] reschedule falló', { visitId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos reagendar la visita. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string } | null)?.outcome ?? 'unknown'

  if (outcome === 'rescheduled') {
    revalidatePath(VISITS_PATH)
    revalidatePath(REQUESTS_PATH)
    return { success: true }
  }

  if (outcome === 'not_reschedulable') {
    const estado = (data as { status?: string } | null)?.status
    revalidatePath(VISITS_PATH)
    return {
      success: false,
      error: estado === 'completed'
        ? 'Esta visita ya fue marcada como realizada, así que no se puede reagendar.'
        : 'Esta visita está cancelada, así que no se puede reagendar.',
    }
  }

  return { success: false, error: mensajeComun(outcome, data) ?? 'No pudimos reagendar la visita.' }
}

// ─── Marcar como realizada ───────────────────────────────────────────────────

export async function completeVisitAction(visitId: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (!puedeGestionar(ctx)) return { success: false, error: 'No tenés permiso para gestionar visitas.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('complete_property_visit', { p_visit_id: visitId })

  if (error) {
    console.error('[property-visits] complete falló', { visitId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos actualizar la visita. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string } | null)?.outcome ?? 'unknown'

  // Repetir la acción no es un error del usuario: el resultado es el que quería.
  if (outcome === 'completed' || outcome === 'already_completed') {
    revalidatePath(VISITS_PATH)
    return { success: true }
  }

  if (outcome === 'invalid_transition') {
    revalidatePath(VISITS_PATH)
    return { success: false, error: 'Esta visita está cancelada, así que no se puede marcar como realizada.' }
  }

  return { success: false, error: mensajeComun(outcome, data) ?? 'No pudimos actualizar la visita.' }
}

// ─── Cancelar ────────────────────────────────────────────────────────────────

export async function cancelVisitAction(
  visitId: string,
  reason?: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (!puedeGestionar(ctx)) return { success: false, error: 'No tenés permiso para gestionar visitas.' }

  const motivo = (reason ?? '').trim()
  if (motivo.length > MAX_REASON) {
    return { success: false, error: `El motivo no puede superar los ${MAX_REASON} caracteres.` }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('cancel_property_visit', {
    p_visit_id: visitId,
    ...(motivo === '' ? {} : { p_reason: motivo }),
  })

  if (error) {
    console.error('[property-visits] cancel falló', { visitId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos cancelar la visita. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string } | null)?.outcome ?? 'unknown'

  if (outcome === 'cancelled' || outcome === 'already_cancelled') {
    revalidatePath(VISITS_PATH)
    return { success: true }
  }

  if (outcome === 'invalid_transition') {
    revalidatePath(VISITS_PATH)
    return { success: false, error: 'Esta visita ya fue marcada como realizada, así que no se puede cancelar.' }
  }

  if (outcome === 'reason_too_long' || outcome === 'reason_invalid') {
    return { success: false, error: 'El motivo no es válido.' }
  }

  return { success: false, error: mensajeComun(outcome, data) ?? 'No pudimos cancelar la visita.' }
}

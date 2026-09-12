'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@orderflow/supabase/server'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import type { ActionResult } from '@/lib/action-result'

const REQUESTS_PATH = '/dashboard/requests'

// Fase 3D — aprobar o rechazar una solicitud.
//
// Esta action NO escribe la tabla. Llama a decide_operation_request(), que es
// la única vía: desde la Fase 3C authenticated no tiene UPDATE sobre
// operation_requests, justamente para que decided_by/decided_at no se puedan
// fabricar desde el cliente.
//
// Los checks de acá son de UX (mensaje claro, temprano). La autorización REAL
// la hace la RPC, que revalida usuario, tenant, rol y estado con la fila
// lockeada — no confía en nada de este archivo.

const MAX_NOTES = 500

export async function decideOperationRequestAction(
  operationId: string,
  action: 'confirmed' | 'rejected',
  notes?: string,
  // Fase 3E-B2 — solo para agendar una visita. La RPC rechaza estos parámetros
  // (invalid_parameters) si el kind no es visit_request o si no se está
  // confirmando, así que no pueden filtrarse a otro tipo de solicitud.
  schedule?: { date: string; time: string },
): Promise<ActionResult<{ status: string; reservationId?: string | null; visitId?: string | null }>> {
  const ctx = await requireTenantContext()

  // Impersonación: mismo criterio que las otras 10 actions del CRM
  // (contacts, conversations, reservations, …). Soporte y lectura, no actuar
  // en nombre del tenant. La RPC lo bloquea igual, por si alguien la llamara
  // sin pasar por acá.
  if (ctx.accessMode === 'setup_operator') {
    return { success: false, error: 'No disponible en modo setup.' }
  }

  if (action !== 'confirmed' && action !== 'rejected') {
    return { success: false, error: 'Acción inválida.' }
  }

  const trimmed = (notes ?? '').trim()
  if (trimmed.length > MAX_NOTES) {
    return { success: false, error: `El motivo no puede superar los ${MAX_NOTES} caracteres.` }
  }

  const supabase = await createClient()

  // Fase 3E-B1 — el permiso depende del KIND de la solicitud, así que hay que
  // saber cuál es antes de poder dar un mensaje temprano. Se lee con la sesión
  // del usuario (las RLS lo acotan a su tenant), y es solo para UX: si esta
  // lectura falla se sigue igual y la RPC —que revalida por kind con la fila
  // lockeada— decide. Nunca al revés.
  const { data: op } = await supabase
    .from('operation_requests')
    .select('kind')
    .eq('id', operationId)
    .maybeSingle()

  if (op) {
    // Mismo mapa por kind que aplica la RPC (Fase 3E-B2 §19).
    const permitido =
      ctx.role === 'owner' ? true :
      op.kind === 'inquiry'       ? ctx.canManageInquiries :
      op.kind === 'visit_request' ? ctx.canManageVisits :
                                    ctx.canConfirmReservations

    if (!permitido) {
      return {
        success: false,
        error: op.kind === 'inquiry'       ? 'No tenés permiso para gestionar consultas.'
             : op.kind === 'visit_request' ? 'No tenés permiso para gestionar visitas.'
             :                               'No tenés permiso para decidir solicitudes de reserva.',
      }
    }

    // Agendar exige fecha y hora: sin ellas la RPC devolvería
    // visit_schedule_required, pero avisar antes es más claro.
    if (op.kind === 'visit_request' && action === 'confirmed' && !schedule) {
      return { success: false, error: 'Para agendar la visita hay que elegir fecha y hora.' }
    }
  }

  const { data, error } = await supabase.rpc('decide_operation_request', {
    p_operation_id: operationId,
    p_action:       action,
    p_notes:        trimmed === '' ? undefined : trimmed,
    ...(schedule ? { p_scheduled_date: schedule.date, p_scheduled_time: schedule.time } : {}),
  })

  if (error) {
    console.error('[operation-requests] la RPC falló', { operationId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos registrar la decisión. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string; status?: string } | null)?.outcome ?? 'unknown'

  // Cada outcome de negocio tiene su mensaje. No se parsea texto de error:
  // la RPC devuelve un código y acá se traduce.
  switch (outcome) {
    case 'confirmed': {
      revalidatePath(REQUESTS_PATH)
      // Fase 3E-A: en temporary_rental esto además creó la pre-reserva.
      revalidatePath('/dashboard/reservations')
      // Fase 3E-B2: en visit_request creó la visita agendada.
      revalidatePath('/dashboard/visits')
      const d = data as { reservation_id?: string; visit_id?: string } | null
      return {
        success: true,
        data: { status: 'confirmed', reservationId: d?.reservation_id ?? null, visitId: d?.visit_id ?? null },
      }
    }

    case 'rejected':
      revalidatePath(REQUESTS_PATH)
      return { success: true, data: { status: 'rejected' } }

    case 'already_decided':
      // No es un error del usuario: alguien más decidió primero. Se revalida
      // para que la pantalla muestre la decisión que efectivamente quedó.
      revalidatePath(REQUESTS_PATH)
      return {
        success: false,
        error: 'Esta solicitud ya fue decidida por otra persona. Actualizá para ver el estado.',
      }

    // ── Fase 3E-A — outcomes de la materialización ────────────────────────
    // Ninguno decide la solicitud: queda pending para resolverla o rechazarla.
    case 'availability_conflict': {
      revalidatePath(REQUESTS_PATH)
      const fuente = (data as { conflict_source?: string } | null)?.conflict_source
      const detalle =
        fuente === 'confirmed'    ? ' Ya hay una reserva confirmada para esas fechas.' :
        fuente === 'pre_reserved' ? ' Ya hay una pre-reserva vigente para esas fechas.' :
        fuente === 'block'        ? ' Esas fechas están bloqueadas en la propiedad.' : ''
      return {
        success: false,
        error: `Las fechas solicitadas ya no están disponibles.${detalle} La solicitud sigue pendiente.`,
      }
    }

    case 'missing_reservation_context': {
      const razon = (data as { reason?: string } | null)?.reason
      return {
        success: false,
        error: razon === 'property_not_found'
          ? 'La propiedad asociada ya no existe. Asociá la solicitud a una propiedad válida antes de aprobarla.'
          : 'Esta solicitud no tiene una propiedad asociada, así que no se puede crear la reserva. Asociala primero o rechazala.',
      }
    }

    // ── Fase 3E-A.2 — la solicitud no cumple las reglas de la propiedad ────
    // Mismas reglas que aplica la IA. No se decide nada: la solicitud queda
    // pending para que el asesor la rechace, ajuste la propiedad o hable con
    // el cliente. No se rechaza automáticamente.
    case 'ineligible': {
      revalidatePath(REQUESTS_PATH)
      const d = data as {
        reason?: string
        minimum_stay_nights?: number
        requested_nights?: number
        capacity?: number
        requested_guests?: number
        commercial_status?: string
        operation_type?: string
      } | null

      let detalle: string
      switch (d?.reason) {
        case 'minimum_stay_not_met':
          detalle = `Esta propiedad requiere una estadía mínima de ${d.minimum_stay_nights} ` +
                    `noche${d.minimum_stay_nights === 1 ? '' : 's'} y la solicitud es de ${d.requested_nights}.`
          break
        case 'capacity_exceeded':
          detalle = `La cantidad de huéspedes (${d.requested_guests}) supera la capacidad de la ` +
                    `propiedad (${d.capacity}).`
          break
        case 'property_not_available': {
          const labels: Record<string, string> = {
            rented: 'alquilada', paused: 'pausada', sold: 'vendida',
          }
          const label = labels[d.commercial_status ?? ''] ?? d.commercial_status ?? 'no disponible'
          detalle = `La propiedad está ${label}, así que no acepta reservas.`
          break
        }
        case 'not_temporary_rental':
          detalle = d.operation_type === 'sale'
            ? 'La propiedad es de venta, no de alquiler temporal.'
            : 'La propiedad es de alquiler tradicional, no de alquiler temporal.'
          break
        default:
          detalle = 'La solicitud no cumple las reglas de la propiedad.'
      }

      return {
        success: false,
        error: `${detalle} No se creó ninguna reserva y la solicitud sigue pendiente.`,
      }
    }

    // ── Cierre 3E-A.2 — el check-in de la solicitud ya pasó ────────────────
    // Regla propia de este flujo: aprobar no puede crear una pre-reserva que
    // arranque en el pasado. La creación manual sí puede registrar reservas
    // retroactivas — son cosas distintas a propósito.
    //
    // Como el resto, no decide nada: la solicitud queda pending y Rechazar
    // sigue disponible.
    case 'past_start_date': {
      revalidatePath(REQUESTS_PATH)
      return {
        success: false,
        error: 'El check-in de esta solicitud ya pasó. No se creó ninguna reserva y la solicitud sigue pendiente.',
      }
    }

    // ── Fase 3E-B2 — outcomes de agendar una visita ────────────────────────
    // Ninguno decide la solicitud: queda pending para agendarla bien o
    // descartarla.
    case 'missing_visit_context': {
      const razon = (data as { reason?: string } | null)?.reason
      return {
        success: false,
        error: razon === 'property_not_found'
          ? 'La propiedad asociada ya no existe. No se agendó ninguna visita.'
          : 'Esta solicitud no tiene una propiedad asociada, así que no se puede agendar la visita.',
      }
    }

    case 'visit_schedule_required':
      return { success: false, error: 'Para agendar la visita hay que elegir fecha y hora.' }

    case 'scheduled_time_in_past':
      return {
        success: false,
        error: 'Esa fecha y hora ya pasaron. Elegí un momento futuro. La solicitud sigue pendiente.',
      }

    case 'invalid_schedule': {
      const razon = (data as { reason?: string } | null)?.reason
      return {
        success: false,
        error: razon === 'invalid_tenant_timezone' || razon === 'tenant_without_timezone'
          ? 'La organización no tiene una zona horaria válida configurada. Revisala en Configuración antes de agendar.'
          : 'La fecha y la hora no son válidas.',
      }
    }

    case 'invalid_parameters':
      return { success: false, error: 'Los datos enviados no corresponden a este tipo de solicitud.' }

    case 'invalid_dates':
      return { success: false, error: 'Las fechas de la solicitud no son válidas. No se creó ninguna reserva.' }

    case 'not_found':
      return { success: false, error: 'Solicitud no encontrada.' }

    // La RPC deniega por kind (Fase 3E-B1) y dice qué permiso falta. Se usa ese
    // dato en vez de repetir el mapa acá.
    case 'forbidden': {
      const falta = (data as { required_permission?: string } | null)?.required_permission
      return {
        success: false,
        error: falta === 'can_manage_inquiries' ? 'No tenés permiso para gestionar consultas.'
             : falta === 'can_manage_visits'    ? 'No tenés permiso para gestionar visitas.'
             :                                    'No tenés permiso para decidir solicitudes de reserva.',
      }
    }

    case 'platform_user_not_allowed':
      return { success: false, error: 'No disponible en modo setup.' }

    case 'notes_too_long':
      return { success: false, error: `El motivo no puede superar los ${MAX_NOTES} caracteres.` }

    case 'notes_invalid':
      return { success: false, error: 'El motivo no puede contener etiquetas HTML.' }

    case 'unauthenticated':
    case 'not_a_tenant_member':
      return { success: false, error: 'Tu sesión no es válida. Volvé a iniciar sesión.' }

    default:
      console.error('[operation-requests] outcome inesperado', { operationId, outcome })
      return { success: false, error: 'No pudimos registrar la decisión.' }
  }
}

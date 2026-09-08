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
): Promise<ActionResult<{ status: string }>> {
  const ctx = await requireTenantContext()

  // Impersonación: mismo criterio que las otras 10 actions del CRM
  // (contacts, conversations, reservations, …). Soporte y lectura, no actuar
  // en nombre del tenant. La RPC lo bloquea igual, por si alguien la llamara
  // sin pasar por acá.
  if (ctx.accessMode === 'setup_operator') {
    return { success: false, error: 'No disponible en modo setup.' }
  }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para decidir solicitudes.' }
  }

  if (action !== 'confirmed' && action !== 'rejected') {
    return { success: false, error: 'Acción inválida.' }
  }

  const trimmed = (notes ?? '').trim()
  if (trimmed.length > MAX_NOTES) {
    return { success: false, error: `El motivo no puede superar los ${MAX_NOTES} caracteres.` }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('decide_operation_request', {
    p_operation_id: operationId,
    p_action:       action,
    p_notes:        trimmed === '' ? undefined : trimmed,
  })

  if (error) {
    console.error('[operation-requests] la RPC falló', { operationId, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos registrar la decisión. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string; status?: string } | null)?.outcome ?? 'unknown'

  // Cada outcome de negocio tiene su mensaje. No se parsea texto de error:
  // la RPC devuelve un código y acá se traduce.
  switch (outcome) {
    case 'confirmed':
      revalidatePath(REQUESTS_PATH)
      return { success: true, data: { status: 'confirmed' } }

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

    case 'not_found':
      return { success: false, error: 'Solicitud no encontrada.' }

    case 'forbidden':
      return { success: false, error: 'No tenés permiso para decidir solicitudes.' }

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

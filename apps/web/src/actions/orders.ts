'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@orderflow/supabase/server'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import type { ActionResult } from '@/lib/action-result'
import { orderStatusLabel } from '@/lib/orders/presentation'
import type { OrderStatus } from '@/lib/repositories/orders.repository'

// Fase 3E-C3C — ciclo de vida del pedido.
//
// Esta action NO escribe la tabla: orders no concede INSERT/UPDATE/DELETE a
// authenticated, ni por policy ni por grant. Todo pasa por
// transition_order_status, que es SECURITY DEFINER y revalida actor, tenant,
// permiso, estado y transición con la fila lockeada.
//
// Los chequeos de acá son de UX — cortan antes de un round-trip inútil. La
// autoridad es la RPC.

const ORDERS_PATH   = '/dashboard/orders'
const MAX_REASON    = 500

function puedeGestionar(ctx: { role: string; canManageOrders: boolean }): boolean {
  return ctx.role === 'owner' || ctx.canManageOrders
}

function mensajeComun(outcome: string): string | null {
  switch (outcome) {
    case 'unauthenticated':           return 'Tu sesión expiró. Volvé a entrar.'
    case 'platform_user_not_allowed': return 'No disponible en modo setup.'
    case 'not_a_tenant_member':       return 'Tu usuario no pertenece a esta organización.'
    case 'forbidden':                 return 'No tenés permiso para gestionar pedidos.'
    case 'not_found':                 return 'Pedido no encontrado.'
    case 'reason_too_long':           return `El motivo no puede superar los ${MAX_REASON} caracteres.`
    case 'reason_invalid':            return 'El motivo no es válido.'
    default:                          return null
  }
}

/**
 * Avanza o cancela un pedido.
 *
 * `reason` solo aplica a 'cancelled' y es OPCIONAL (§16): un pedido se puede
 * cancelar sin explicar por qué. Si llega para otro destino, la RPC lo rechaza.
 */
export async function transitionOrderAction(
  orderId: string,
  target:  OrderStatus,
  reason?: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (!puedeGestionar(ctx)) return { success: false, error: 'No tenés permiso para gestionar pedidos.' }

  const motivo = (reason ?? '').trim()
  if (motivo.length > MAX_REASON) {
    return { success: false, error: `El motivo no puede superar los ${MAX_REASON} caracteres.` }
  }
  if (motivo !== '' && target !== 'cancelled') {
    return { success: false, error: 'El motivo solo aplica al cancelar un pedido.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('transition_order_status', {
    p_order_id: orderId,
    p_status:   target,
    ...(motivo === '' ? {} : { p_reason: motivo }),
  })

  if (error) {
    console.error('[orders] transición falló', { orderId, target, code: error.code, error: error.message })
    return { success: false, error: 'No pudimos actualizar el pedido. Probá de nuevo.' }
  }

  const outcome = (data as { outcome?: string } | null)?.outcome ?? 'unknown'

  if (outcome === target || outcome === 'already_in_status') {
    revalidatePath(ORDERS_PATH)
    return { success: true }
  }

  if (outcome === 'invalid_transition') {
    // El estado del servidor no es el que la UI creía. Se revalida para que la
    // pantalla se ponga al día en vez de insistir con un botón imposible.
    revalidatePath(ORDERS_PATH)
    const actual = (data as { status?: string } | null)?.status
    return {
      success: false,
      error: actual
        ? `El pedido está "${orderStatusLabel(actual)}" y no se puede pasar a "${orderStatusLabel(target)}".`
        : 'Ese cambio de estado no es válido.',
    }
  }

  if (outcome === 'invalid_status' || outcome === 'invalid_parameters') {
    return { success: false, error: 'Ese cambio de estado no es válido.' }
  }

  return { success: false, error: mensajeComun(outcome) ?? 'No pudimos actualizar el pedido.' }
}

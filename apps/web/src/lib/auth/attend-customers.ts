import type { ActionResult } from '@/lib/action-result'

// ════════════════════════════════════════════════════════════════════════════
// Permisos V2 — "Atender clientes".
//
// Un solo permiso para el trabajo de atender: cerrar una atención humana,
// anotar una tarea y corregir los datos de un contacto. Es lo que hace una
// recepcionista cuando atiende, y partirlo en tres switches no habría hecho
// más seguro al sistema, sólo más difícil de configurar.
//
// Por dentro sigue siendo can_assign_conversations, la columna que ya existía
// y que había quedado sin efecto al retirarse la bandeja de conversaciones.
// Renombrar la columna implicaría reescribir policies y código para no ganar
// nada funcional; el label público sí cambió.
//
// LO QUE ESTE PERMISO NO GOBIERNA, a propósito:
//
//   · VER la bandeja de Atención humana. Mirar quién espera es el trabajo, no
//     un privilegio. El alcance de lectura lo siguen decidiendo las RLS.
//   · LEER contactos. Sin el teléfono no se despacha un pedido ni se confirma
//     una reserva.
//
// El guard vive acá y no repetido en cada action para que la respuesta sea
// idéntica en todas y para que agregar una mutación nueva sea un import, no
// una decisión.
// ════════════════════════════════════════════════════════════════════════════

export interface AttendCustomersContext {
  role:                   string
  canAssignConversations: boolean
}

/** El owner siempre puede; la recepcionista, sólo con el permiso. */
export function canAttendCustomers(ctx: AttendCustomersContext): boolean {
  return ctx.role === 'owner' || ctx.canAssignConversations === true
}

export const ATTEND_CUSTOMERS_DENIED =
  'No tenés permiso para atender clientes. Pedíselo al propietario de la cuenta.'

/**
 * `null` si puede seguir; el `ActionResult` de rechazo si no.
 *
 * Se devuelve en vez de lanzar para que las actions mantengan su contrato
 * actual —siempre resuelven un ActionResult— y el usuario vea un mensaje y no
 * una pantalla de error.
 */
export function requireAttendCustomers<T = undefined>(
  ctx: AttendCustomersContext,
): ActionResult<T> | null {
  return canAttendCustomers(ctx) ? null : { success: false, error: ATTEND_CUSTOMERS_DENIED }
}

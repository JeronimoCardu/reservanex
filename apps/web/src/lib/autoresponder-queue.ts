// ════════════════════════════════════════════════════════════════════════════
// MVP P0-A — una fila de AutoResponder que el camino síncrono no llegó a
// procesar termina 'failed' con un motivo cerrado, nunca 'pending' para
// siempre.
//
// AutoResponder sólo puede responder dentro del request HTTP del webhook: el
// poller genérico del worker ya no reclama estas filas (y aunque lo hiciera, su
// respuesta no tendría a quién entregarse). Si la llamada al worker falla, el
// webhook contesta vacío y deja la fila diagnosticable: "este mensaje no
// respondió porque X".
//
// La escritura exige status = 'pending': si el worker sí la reclamó (está
// 'processing', o ya terminó), su propio camino la cierra y esto no la toca.
// last_error nunca lleva la URL del worker, el secreto ni el contenido.
// ════════════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'

export type SyncFailureReason =
  | 'sync_not_configured'      // WORKER_INTERNAL_URL / WORKER_INTERNAL_SECRET ausentes
  | 'sync_worker_unreachable'  // error de red (worker caído, DNS, TLS)
  | 'sync_worker_timeout'      // el worker no contestó dentro del presupuesto + margen
  | 'sync_worker_http_error'   // el worker contestó con un status no-2xx
  | 'sync_worker_bad_response' // 2xx con un cuerpo que no es el contrato
  | 'sync_claim_failed'        // el worker no pudo reclamar la fila (error_not_found)

/** last_error de una falla síncrona: el motivo cerrado, más un detalle acotado opcional (p. ej. "HTTP 502"). */
export function syncFailureMessage(reason: SyncFailureReason, detail?: string): string {
  return detail ? `${reason}: ${detail.slice(0, 100)}` : reason
}

/** Cierra la fila si sigue 'pending'. Nunca tira: un error se loguea y el webhook sigue. */
export async function failPendingAutoResponderRow(
  client: SupabaseClient<Database>,
  queueItemId: string,
  reason: SyncFailureReason,
  detail?: string,
): Promise<void> {
  try {
    const { error } = await client
      .from('message_queue')
      .update({ status: 'failed', last_error: syncFailureMessage(reason, detail) })
      .eq('id', queueItemId)
      .eq('status', 'pending')
    if (error) {
      console.error('[webhook:autoresponder] could not mark queue row failed', { queueItemId, reason, code: error.code })
    }
  } catch (err) {
    console.error('[webhook:autoresponder] could not mark queue row failed', {
      queueItemId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

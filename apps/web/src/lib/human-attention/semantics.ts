// ════════════════════════════════════════════════════════════════════════════
// Atención humana V2 — la semántica del ciclo, en un solo lugar.
//
// Dos preguntas distintas que antes se confundían:
//
//   ai_mode                  → "¿la IA puede responder ahora?"
//   human_attention_pending  → "¿una PERSONA ya atendió este pedido?"
//
// La segunda la define la base (columna generada, migración 20260922000001):
//
//   open ∧ requested_at ≠ null ∧ (resolved_at = null ∨ resolved_at < requested_at)
//
// Acá se replica como función pura por dos motivos: los tests unitarios la
// fijan sin base, y el cron necesita evaluar "¿sigue elegible?" sobre la fila
// que acaba de leer. Si alguna vez divergieran, el validator físico lo
// detecta: compara esta función contra la columna real.
// ════════════════════════════════════════════════════════════════════════════

export interface HumanAttentionState {
  status:                        string
  human_attention_requested_at:  string | null
  human_attention_resolved_at:   string | null
  human_attention_email_sent_at: string | null
}

export function isHumanAttentionPending(row: HumanAttentionState): boolean {
  if (row.status !== 'open') return false
  if (!row.human_attention_requested_at) return false
  if (!row.human_attention_resolved_at) return true
  return new Date(row.human_attention_resolved_at).getTime()
       < new Date(row.human_attention_requested_at).getTime()
}

/** Cuánto puede llevar pendiente un ciclo antes de avisarle al owner. */
export const HUMAN_ATTENTION_REMINDER_DELAY_MS = 2 * 60 * 60 * 1000

/**
 * El ciclo vigente lleva ≥ 2 h pendiente y todavía no recibió su email.
 *
 * "Todavía no" es temporal, no booleano: un email enviado para un ciclo
 * ANTERIOR (sent_at < requested_at) no cuenta. Así un segundo pedido de humano
 * mañana vuelve a ser elegible sin que nadie tenga que limpiar nada.
 *
 * No mira ai_mode a propósito: si la IA volvió sola porque venció
 * human_until, el cliente sigue sin haber sido atendido por una persona.
 */
export function isHumanAttentionReminderDue(row: HumanAttentionState, nowMs: number): boolean {
  if (!isHumanAttentionPending(row)) return false
  const requestedMs = new Date(row.human_attention_requested_at!).getTime()
  if (!Number.isFinite(requestedMs)) return false
  if (nowMs - requestedMs < HUMAN_ATTENTION_REMINDER_DELAY_MS) return false
  if (!row.human_attention_email_sent_at) return true
  return new Date(row.human_attention_email_sent_at).getTime() < requestedMs
}

// ── Motivo ──────────────────────────────────────────────────────────────────
//
// ai_handoff_reason es del gate de IA y el worker lo anula al reactivarla por
// expiración. Por eso el motivo se muestra como "lo que sabemos", con un
// default honesto cuando ya no está: la atención sigue pendiente aunque el
// motivo se haya perdido.

export const HUMAN_ATTENTION_REASON_LABELS: Record<string, string> = {
  human_requested:   'Pidió hablar con una persona',
  auto_reply_limit:  'El asistente llegó al límite de respuestas',
  manual_takeover:   'Tomado manualmente desde ReservaNex',
  negotiation:       'Negociación derivada a una persona',
  reservation_ready: 'Reserva lista para confirmar',
  error:             'El asistente no pudo continuar',
}

export const HUMAN_ATTENTION_DEFAULT_REASON = 'Derivado por el asistente'

export function humanAttentionReasonLabel(reason: string | null | undefined): string {
  if (!reason) return HUMAN_ATTENTION_DEFAULT_REASON
  return HUMAN_ATTENTION_REASON_LABELS[reason] ?? HUMAN_ATTENTION_DEFAULT_REASON
}

// ── Canal ───────────────────────────────────────────────────────────────────

export function channelLabel(channel: string | null | undefined): string {
  return channel === 'manual' ? 'Manual' : 'WhatsApp'
}

// ── Tenants que reciben el recordatorio ─────────────────────────────────────
//
// suspended / cancelled / churned no reciben emails: no están operando. Un
// tenant en trial está probando exactamente esto.
export const REMINDER_TENANT_STATUSES = ['trial', 'active'] as const

export function tenantReceivesReminders(status: string | null | undefined): boolean {
  return status === 'trial' || status === 'active'
}

// ── "Marcar como atendido" ──────────────────────────────────────────────────
//
// La ÚNICA escritura que cierra un ciclo. Es la misma que reactivar la IA,
// extendida: una persona declara que se hizo cargo y el asistente retoma.
//
//   - human_attention_resolved_at/by: cierra el ciclo (ni el worker ni el
//     trigger lo tocan).
//   - human_until = null: antes quedaba stale; con un valor vencido, una toma
//     manual posterior se revertía sola en el próximo inbound (human_expired).
//   - ai_context_reset_at = now: lo que pasó mientras atendía una persona
//     (incluidos inbound sin respuesta registrada, porque ReservaNex no ve lo
//     que se contesta desde WhatsApp Business) no vuelve a entrar al contexto.
//
// human_attention_requested_at NO se toca: es el historial del último ciclo y
// un ciclo nuevo lo sobreescribe con now() (> resolved_at ⇒ pendiente otra vez).
// Los mensajes no se tocan. Vive acá, puro, para que el repositorio y el
// validator físico escriban EXACTAMENTE lo mismo.
export function humanAttentionAttendedPatch(userId: string, nowIso: string) {
  return {
    ai_mode:                     'autonomous' as const,
    ai_auto_replies_count:       0,
    ai_handoff_reason:           null,
    ai_handoff_at:               null,
    ai_reactivated_at:           nowIso,
    ai_reactivated_by:           userId,
    needs_human_attention:       false,
    human_until:                 null,
    ai_context_reset_at:         nowIso,
    human_attention_resolved_at: nowIso,
    human_attention_resolved_by: userId,
  }
}

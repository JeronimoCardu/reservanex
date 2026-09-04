// Pure, DB-independent derivation of the CRM-facing outbound tracking status
// (Fase 8 "outbound ACK"). Reduces messaging_outbox's real columns (status,
// dispatched_at, device_ack_at) into ONE honest display state — never
// persisted, always recomputed at render time, same rationale as
// autoresponder-device-health.ts's deriveDeviceStatus.
//
// HONESTY CONTRACT — read before changing any copy that uses this module:
//   device_ack_at means "MacroDroid ran the outbound macro through to the
//   point AFTER the WhatsApp Send action, and successfully POSTed back to
//   /api/webhooks/autoresponder/outbound-ack." It does NOT mean "WhatsApp
//   confirmed delivery to the recipient" — there is no delivery/read
//   receipt anywhere in this architecture, and none is being simulated
//   here. NEVER use the words "Entregado"/"Leído"/"Recibido" for any state
//   this module produces.

// A dispatch with no ACK within this window is shown as "unconfirmed" —
// not "failed": WhatsApp may well have sent physically (see this module's
// doc comment) and only the callback itself failed. 60s comfortably covers
// the real macro's Screen On → Wait 1s → WhatsApp Send → HTTP POST
// sequence (see the Fase 4 report's physical timing notes) without being
// so long that a genuinely-stuck dispatch sits unlabeled for minutes.
export const OUTBOUND_UNCONFIRMED_THRESHOLD_MS = 60_000

// The moment this protocol went live in the real linked project (migration
// 20260901000001_outbound_device_ack.sql was pushed 2026-08-31). Every
// messaging_outbox row dispatched before this timestamp has
// device_ack_at = NULL not because the device failed to confirm, but
// because the column — and the macro's callback step — did not exist yet.
// Those rows must NEVER be shown as "unconfirmed" (that would falsely imply
// we asked and got no answer); they stop at "dispatched" and never
// escalate. See §14 of the Fase 8 report.
//
// Deliberately NOT the migration filename's date prefix (2026-09-01) — that
// prefix is this project's sequential naming convention, not the real
// wall-clock push time, and using it verbatim here would put the cutover
// IN THE FUTURE relative to the real push (2026-08-31), silently disabling
// "unconfirmed" for every dispatch until the calendar caught up. Pinned to
// the actual push date instead.
export const ACK_PROTOCOL_INTRODUCED_AT = '2026-08-31T00:00:00Z'

export type OutboundTrackingInfo = {
  status:       string // messaging_outbox.status: 'pending' | 'processing' | 'dispatched' | 'failed'
  dispatchedAt: string | null
  deviceAckAt:  string | null
}

export type OutboundDisplayStatus =
  | 'queued'               // not dispatched to MacroDroid yet
  | 'dispatched_to_device' // MacroDroid's trigger service accepted it; no device ACK yet (or pre-protocol)
  | 'device_executed'      // device_ack_at is set — MacroDroid ran past WhatsApp Send
  | 'unconfirmed'          // dispatched, no ACK, past the threshold, after the protocol existed
  | 'failed'               // messaging_outbox.status = 'failed'

// Returns null for anything with no outbox row at all (inbound messages,
// Meta-provider sends, or a message whose enqueue itself failed before any
// row was created) — callers must treat null as "no tracking applies here",
// never as a state to render.
export function deriveOutboundDisplayStatus(
  outbox: OutboundTrackingInfo | null,
  now: Date = new Date(),
): OutboundDisplayStatus | null {
  if (!outbox) return null

  if (outbox.deviceAckAt) return 'device_executed'
  if (outbox.status === 'failed') return 'failed'
  if (outbox.status === 'pending' || outbox.status === 'processing') return 'queued'

  // status === 'dispatched', no ACK yet.
  if (!outbox.dispatchedAt) return 'dispatched_to_device' // defensive — shouldn't happen

  const dispatchedTime = new Date(outbox.dispatchedAt).getTime()
  const isPreProtocol   = dispatchedTime < new Date(ACK_PROTOCOL_INTRODUCED_AT).getTime()
  if (isPreProtocol) return 'dispatched_to_device'

  const elapsedMs = now.getTime() - dispatchedTime
  return elapsedMs > OUTBOUND_UNCONFIRMED_THRESHOLD_MS ? 'unconfirmed' : 'dispatched_to_device'
}

// Short, honest copy — no jargon, no false delivery/read claims. Used
// verbatim by MessageBubble; keep in sync with any UI copy changes so there
// is exactly one place these strings are decided.
export const OUTBOUND_DISPLAY_LABEL: Record<OutboundDisplayStatus, string> = {
  queued:               'En cola',
  dispatched_to_device: 'Enviado al dispositivo',
  device_executed:      'Ejecutado en dispositivo',
  unconfirmed:          'Envío no confirmado',
  failed:               'No enviado',
}

// Fase 1B (AutoResponder sin MacroDroid, definitivo) — pure decision logic
// for whether an AutoResponder AI reply may be delivered at all. Extracted
// as a standalone, DB-free function (same "pure decision logic, unit-tested,
// documentation of intent" pattern already established by
// dispatcher-claim.ts's pickNextClaimable/computeBusyAccountIds) because
// this is now the single point that enforces the hard rule from the Fase 1B
// spec: MacroDroid/messaging_outbox can NEVER be a fallback, retry, or
// emergency transport for provider=autoresponder — full stop, under any
// condition, including a timeout, an error, or the process continuing in
// the background after the HTTP response already gave up.
//
// The only delivery mechanism for provider=autoresponder is a LIVE
// synchronous HTTP call still within its deadline (MessageContext.syncReply,
// set by internal-server.ts). If that is not available — no live sync
// context at all (the async poller, resumeAfterMediaReady,
// handleMediaNeverUploaded — none of which are reachable anymore for
// AutoResponder, but this function does not assume that; it decides
// correctly regardless of the caller), or the deadline has already
// passed — the reply must be DROPPED: never enqueued anywhere, never
// persisted as delivered (see processor.ts's deliverAIReply, which also
// skips writeMemory() in this case to avoid a "ghost" AI message the
// customer never received contaminating future conversation context).

export interface AutoResponderSyncReplyState {
  deadlineAtMs: number
}

export type AutoResponderDeliveryDecision =
  | { deliver: true }
  | { deliver: false; reason: 'no_sync_context' | 'deadline_exceeded' }

export function decideAutoResponderDelivery(
  syncReply: AutoResponderSyncReplyState | undefined,
  nowMs:     number,
): AutoResponderDeliveryDecision {
  if (!syncReply) return { deliver: false, reason: 'no_sync_context' }
  if (nowMs >= syncReply.deadlineAtMs) return { deliver: false, reason: 'deadline_exceeded' }
  return { deliver: true }
}

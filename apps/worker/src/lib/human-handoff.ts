// Fase 2B — the AI → HUMAN → AI handoff window.
//
// Human replies happen in WhatsApp / WhatsApp Web; ReservaNex never sees
// them (see §15 of the Fase 2B spec — no presence, no ticks, no outbound
// detection). Our entire contract is: while HUMAN is in force, a customer
// inbound is persisted, extends the window, and is answered with
// {"replies": []} — no LLM call, no tokens, no AI message.
//
// Everything here is pure except where noted, so the decision logic is
// unit-testable without a DB, an LLM, or a clock — same pattern as
// providers/autoresponder/delivery-decision.ts.

// The one controlled handoff text. Deliberately NOT left to the LLM: a
// model-authored farewell varies run to run, and this sentence is the
// contractual last thing the customer hears before silence. Centralised so
// every handoff path (keyword pre-check, escalate_to_human tool, max-turns,
// auto-reply limit) says exactly the same thing.
export const HUMAN_HANDOFF_MESSAGE =
  'Un asesor te contactará para brindarte una mejor atención.'

// Production default: 1 hour. Overridable ONLY via env, for tests and local
// physical validation (e.g. 10000 to avoid waiting an hour) — this is not a
// tenant-visible setting in this phase.
export const DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS = 3_600_000

// Clamped to a sane band: below 1s the window would expire between two
// messages of the same burst and hand the conversation back to the AI
// mid-handoff; above 24h a forgotten override would strand conversations in
// silence for days. An unparseable/out-of-range value falls back to the
// default rather than failing the request — a misconfigured env must never
// take the inbound path down.
export const MIN_HUMAN_HANDOFF_TIMEOUT_MS = 1_000
export const MAX_HUMAN_HANDOFF_TIMEOUT_MS = 24 * 60 * 60 * 1000

export function parseHumanHandoffTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS
  if (parsed < MIN_HUMAN_HANDOFF_TIMEOUT_MS) return DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS
  if (parsed > MAX_HUMAN_HANDOFF_TIMEOUT_MS) return DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS
  return parsed
}

// Read lazily (not at module load) so a test or script can set the env var
// after import, exactly like lib/supabase.ts's createClient().
export function getHumanHandoffTimeoutMs(): number {
  return parseHumanHandoffTimeoutMs(process.env.HUMAN_HANDOFF_TIMEOUT_MS)
}

export function computeHumanUntilIso(nowMs: number, timeoutMs: number): string {
  return new Date(nowMs + timeoutMs).toISOString()
}

// How a handoff behaves over time. Explicit on purpose — never inferred from
// the reply text, and never acquired implicitly just because a code path
// happens to share executeEscalateToHuman().
//
//   'temporary' → opens the sliding HUMAN window (human_until). The AI comes
//                 back on its own once the customer goes quiet for the
//                 timeout. This is the Fase 2B AutoResponder behaviour.
//   'permanent' → ai_mode stays non-autonomous with human_until NULL, so it
//                 never auto-reverts; only an explicit reactivation (the
//                 CRM action) brings the AI back. This is the pre-Fase-2B
//                 behaviour and the DEFAULT, so no caller can pick up the
//                 sliding window by accident.
export type HandoffMode = 'temporary' | 'permanent'

// The sliding window is an AutoResponder feature: it exists because human
// replies happen in WhatsApp / WhatsApp Web, invisible to ReservaNex, so the
// only way back to the AI is a timeout. Meta keeps its own semantics — its
// handoffs stay permanent until someone reactivates the AI, exactly as
// before Fase 2B (§20: do not adapt Meta to the new temporal behaviour just
// because the escalation helper is shared).
export function handoffModeForProvider(provider: 'meta' | 'autoresponder'): HandoffMode {
  return provider === 'autoresponder' ? 'temporary' : 'permanent'
}

// The state the inbound path needs from a conversation row to decide.
export interface HumanModeState {
  ai_mode:     string
  human_until: string | null
}

export type HumanModeDecision =
  // HUMAN is in force: persist, slide the window, stay silent.
  | { mode: 'human_active'; humanUntilMs: number }
  // The AI's handoff window lapsed: reactivate the AI for THIS inbound and
  // reset the conversation-history boundary.
  | { mode: 'human_expired' }
  // Normal AI operation — includes a conversation left manual from the CRM
  // (human_until IS NULL), which must NOT auto-revert.
  | { mode: 'ai' }
  // Manual/assisted with no expiry — set by a human, stays silent forever
  // until someone reactivates the AI explicitly from the CRM.
  | { mode: 'manual_no_expiry' }

// Pure. `nowMs` is injected so tests never depend on the wall clock.
export function decideHumanMode(state: HumanModeState, nowMs: number): HumanModeDecision {
  if (state.ai_mode === 'autonomous') return { mode: 'ai' }

  // Not autonomous → some flavour of human attention.
  if (state.human_until === null) return { mode: 'manual_no_expiry' }

  const untilMs = new Date(state.human_until).getTime()
  if (!Number.isFinite(untilMs)) {
    // Unparseable timestamp: treat as a live handoff rather than handing the
    // conversation back to the AI. Fail-safe per §8 — silence is recoverable,
    // an AI answering over a human is not.
    return { mode: 'human_active', humanUntilMs: nowMs }
  }

  if (untilMs > nowMs) return { mode: 'human_active', humanUntilMs: untilMs }
  return { mode: 'human_expired' }
}

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'

// Env vars are read lazily inside createClient() so that module-level loading
// (which happens before dotenv runs due to CJS import hoisting) never throws.
export function createClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

  if (!url || !key) {
    throw new Error(
      '[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Check that the root .env is loaded.'
    )
  }

  return createSupabaseClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

type QueueRow = Database['public']['Tables']['message_queue']['Row']

// Fase 7 Parte D — SAFE_PROCESSING_THRESHOLD_MS, replacing the previous
// unconditional "any 'processing' row → reset" behavior. Full audit (see
// Fase 7 report Parte D) found two real problems with the old design:
//
//   1. It ran with NO age check at all — a row that started processing 1ms
//      ago would be reset just as readily as one stuck for an hour, so
//      calling this on ANY trigger other than "this exact process just
//      started, before it has claimed anything itself" was unsafe. This
//      session repeatedly demonstrated multiple worker instances running
//      concurrently (a persistent dev-environment instance + short-lived
//      testing instances) — under that reality, one worker's startup
//      recovery could reset a row a DIFFERENT, still-legitimately-running
//      worker instance was mid-processing, and claimQueueItem()'s
//      SELECT-then-UPDATE claim (not a single atomic RPC, unlike
//      messaging_outbox/media_events) does not fully close the resulting
//      race — the reset row becomes claimable again while the original run
//      is still in flight, risking genuine concurrent double-processing.
//
//   2. Resetting to 'pending' (for attempts<3) specifically reintroduces
//      that same row into the claimable pool for a RETRY — amplifying the
//      risk in (1) instead of just recording an honest terminal state.
//
// Fix: only touch rows whose processing_started_at is older than a
// conservative threshold (computed below), and ALWAYS terminalize to
// 'failed' — never back to 'pending'. This trades "some crashed items lose
// their automatic retry" for "never risk two concurrent runs of the same
// item" — the same "no retry ambiguo" principle already applied to
// messaging_outbox/media_events (see dispatcher.ts, media-dispatcher.ts).
// A 'failed' row can still be recognized as a false positive (still running
// elsewhere) safely: if that run finishes normally, completeQueueItem()
// just overwrites status='completed' — a harmless status flicker, not
// corruption (no unique constraint is bypassed by this race either way).
//
// SAFE_PROCESSING_THRESHOLD_MS justification — worst-case realistic
// duration of a single processMessage() call, from context/responder.ts and
// lib/llm.ts's real timeouts:
//   - LLM tool loop: up to maxTurns (clamped 2-8, default 5) × callLLM's own
//     30s AbortSignal timeout = up to 240s in the worst case.
//   - Meta media (image/document/audio, synchronous only for Meta — see
//     processor.ts; AutoResponder's own audio always defers via
//     media_events and never blocks this path): Graph API URL fetch (15s)
//     + bytes download (30s) = 45s.
//   - Audio transcription (Meta path only — Groq, whatsapp/transcribe.ts):
//     60s.
//   Worst realistic total ≈ 240 + 45 + 60 = 345s (~5.75 min). 10 minutes
//   gives just under 2x margin over that theoretical worst case — generous
//   enough that a genuinely still-running call is essentially never
//   mistaken for stuck, while still bounding how long a truly abandoned row
//   (worker crash) sits in a stale 'processing' state before becoming
//   diagnosable. Not tuned against real production load yet — same
//   "initial conservative value" caveat as ACCOUNT_DISPATCH_COOLDOWN_MS/
//   STUCK_THRESHOLD_MS/DEVICE_DISPATCH_LEASE_SECONDS elsewhere in this
//   codebase.
export const SAFE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000

// Called both at worker startup AND periodically (poller.ts) — deliberately
// the SAME function, SAME threshold, SAME "always fail" behavior in both
// places (Fase 7 report Parte D §G — no separate semantics for the two call
// sites).
export async function recoverProcessingItems(): Promise<void> {
  const supabase = createClient()
  const staleBefore = new Date(Date.now() - SAFE_PROCESSING_THRESHOLD_MS).toISOString()

  const { data: recovered } = await supabase
    .from('message_queue')
    .update({ status: 'failed', last_error: 'stuck_processing_exceeded_safe_threshold' })
    .eq('status', 'processing')
    .lt('processing_started_at', staleBefore)
    .select('id')

  if (recovered && recovered.length > 0) {
    console.warn(
      `[worker] marked ${recovered.length} stuck 'processing' item(s) as failed ` +
      '(processing_started_at older than the safe threshold — not retried automatically)',
    )
  }
}

export async function claimQueueItem(): Promise<QueueRow | null> {
  const supabase = createClient()

  // Find oldest pending item within retry budget
  const { data: items, error: selectError } = await supabase
    .from('message_queue')
    .select('id')
    .eq('status', 'pending')
    .lt('attempts', 3)
    .order('created_at', { ascending: true })
    .limit(1)

  if (selectError) {
    // Previously swallowed silently — poll() would just see "nothing to
    // claim" on a genuine query failure (RLS, connection, etc.) with no
    // signal at all. Never logs raw error details beyond the message/code
    // Supabase itself returns (no row content, no secrets).
    console.error('[poller] claimQueueItem select error', { code: selectError.code, message: selectError.message })
    return null
  }
  if (!items || items.length === 0) return null

  const id = items[0].id

  // Optimistic claim: only succeeds if the row is still 'pending'
  // (guards against two poll cycles racing in the same process, or two
  // concurrent worker processes racing on the same row — the latter is a
  // real possibility this claim step does not fully close, since it is a
  // SELECT-then-UPDATE rather than the single atomic RPC used by
  // messaging_outbox/media_events; a lost race here is expected and
  // harmless — the row stays 'pending' and is retried on the next tick).
  const { data, error: updateError } = await supabase
    .from('message_queue')
    .update({
      status: 'processing',
      processing_started_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .single()

  if (updateError) {
    // .single() errors when the UPDATE affects 0 rows (another poller
    // already claimed it first) — that specific case is a normal, expected
    // race outcome, not a real error, so it stays quiet. Anything else
    // (PGRST116 is the "0/2+ rows" code; any other code is a genuine
    // failure) gets logged so a real claim error is never silent.
    if (updateError.code !== 'PGRST116') {
      console.error('[poller] claimQueueItem update error', { code: updateError.code, message: updateError.message })
    }
    return null
  }

  return data
}

// Fase 1 (AutoResponder sin MacroDroid) — claims ONE SPECIFIC row by id,
// used by the synchronous internal endpoint (internal-server.ts) right
// after the webhook enqueues it, so the AI pipeline can run inline within
// the same HTTP request instead of waiting for the next 3s poll tick.
// Same optimistic "UPDATE ... WHERE status='pending' ... RETURNING" claim as
// claimQueueItem() above, just scoped by id instead of "oldest pending" —
// this is what keeps it race-safe against the regular poller: whichever of
// the two UPDATEs commits first wins, the other affects 0 rows (PGRST116)
// and returns null, exactly like two poll ticks racing on the same item.
export async function claimQueueItemById(id: string): Promise<QueueRow | null> {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('message_queue')
    .update({
      status: 'processing',
      processing_started_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .single()

  if (error) {
    if (error.code !== 'PGRST116') {
      console.error('[internal-server] claimQueueItemById update error', { code: error.code, message: error.message })
    }
    return null
  }

  return data
}

export async function completeQueueItem(id: string): Promise<void> {
  const supabase = createClient()
  await supabase
    .from('message_queue')
    .update({ status: 'completed', processed_at: new Date().toISOString() })
    .eq('id', id)
}

export async function failQueueItem(id: string, error: string): Promise<void> {
  const supabase = createClient()

  // Read current attempts to increment
  const { data: row } = await supabase
    .from('message_queue')
    .select('attempts')
    .eq('id', id)
    .single()

  const attempts = (row?.attempts ?? 0) + 1

  // If under retry budget → back to pending so it will be retried
  // If exhausted → mark as failed permanently
  const status = attempts >= 3 ? 'failed' : 'pending'

  await supabase
    .from('message_queue')
    .update({ status, attempts, last_error: error.slice(0, 500) })
    .eq('id', id)
}

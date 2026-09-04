// Polls media_events and fires the MacroDroid "go fetch this media" trigger,
// serialized per account/device via the claim_next_media_event Postgres RPC
// (migration 20260826000002) — same pg_try_advisory_xact_lock technique as
// dispatcher.ts's claim_next_outbox_item. Independent poll loop, started
// alongside poller.ts and dispatcher.ts from index.ts; a failure here must
// never affect inbound processing or outbound text dispatch.
import type { Database } from '@orderflow/types'
import { createClient } from './lib/supabase'
import { dispatchMediaTriggerToMacroDroid } from './providers/autoresponder/outbound'
import { resumeAfterMediaReady, handleMediaNeverUploaded } from './processor'
import { DEVICE_DISPATCH_LEASE_SECONDS } from './lib/device-lease'

type MediaEventRow = Database['public']['Tables']['media_events']['Row']
type AppSupabase   = ReturnType<typeof createClient>

const POLL_INTERVAL_MS = 3_000

// Fase 6B.5 fix — see recoverStuckMediaEvents's doc comment: this must run
// periodically, not just once at process startup.
const RECOVERY_INTERVAL_MS = 60_000

// Upper bound on how many events one tick will drain — same rationale as
// dispatcher.ts's MAX_DISPATCHES_PER_TICK, not a throughput target.
const MAX_DISPATCHES_PER_TICK = 10

// A worker crash/restart (or a device that genuinely never uploads — dead
// battery, app killed, no matching file found) can leave an event stuck
// indefinitely in a non-terminal state. Generous on purpose: unlike a single
// bounded HTTP call (outbox's dispatch), an upload here depends on an
// independent Android-side action (locate file, read, POST bytes) of
// unknown duration for larger files/slower connections — 2 minutes (the
// value reused from dispatcher.ts) risked marking a legitimately in-progress
// upload as failed. Never resurrected to a retryable state either way — same
// "no retry ambiguo" principle as messaging_outbox.
const STUCK_THRESHOLD_MS = 5 * 60 * 1000

let isDispatching = false

// Fase 6B.5 — ROOT CAUSE FIX for a real starvation bug found in physical
// E2E testing: this function used to run only ONCE, at worker startup (see
// startMediaDispatcher below). claim_next_media_event()'s own busy-check
// treats ANY 'pending_android' row with dispatched_at set as "this account
// is busy" (correctly — it means a trigger already fired and might still
// be physically executing). But if that upload never actually arrives
// (MacroDroid-side failure, outside this codebase's control — see the
// Fase 6B.4 report), the row stays in that busy-signaling state FOREVER
// unless something demotes it to a terminal status. Before this fix, only
// a worker restart could ever trigger that demotion — in a long-running
// production worker (no restarts for hours/days), ONE stuck upload would
// permanently starve every subsequent media event for that same account,
// with no time bound. Now called on its own RECOVERY_INTERVAL_MS timer
// (independent of the 3s dispatch tick, to avoid adding a query to the hot
// path — see startMediaDispatcher), so a stuck event is bounded to at most
// STUCK_THRESHOLD_MS + RECOVERY_INTERVAL_MS before being marked 'failed'
// and releasing the account, regardless of worker uptime. STUCK_THRESHOLD_MS
// itself, the "no auto-retry" policy, and the terminal-failure semantics
// are all UNCHANGED — only the recovery pass's cadence changed.
//
// Fase 6B.6 correction — semantic bug found by physical re-test: the
// original predicate used `updated_at < staleBefore` for ALL THREE
// non-terminal statuses uniformly, INCLUDING 'pending_android'. For
// 'pending_android' that is wrong: updated_at is ambiguous there — it's
// EITHER the insert timestamp (never dispatched: dispatched_at IS NULL) OR
// the claim timestamp (dispatched: dispatched_at IS NOT NULL), and those
// mean completely different things. A 'pending_android' + dispatched_at IS
// NULL event has NEVER been sent to MacroDroid — ReservaNex hasn't done
// anything ambiguous yet, it's simply still waiting its turn in the FIFO
// queue (exactly what the starvation bug in the 6B.5 fix could cause: an
// event waits behind another account's stuck item for a long time). Aging
// such an event out by mere elapsed time is a straight-up bug — it must
// stay eligible for claim_next_media_event() no matter how long it has
// been waiting. Only a REAL ambiguous outcome — a trigger that WAS sent
// (dispatched_at IS NOT NULL) whose upload never arrived — is a legitimate
// "stuck" case. So the policy, by status, is now:
//
//   pending_android + dispatched_at IS NULL     → NEVER recovered (no
//                                                  ambiguity: nothing was
//                                                  ever sent to MacroDroid)
//   pending_android + dispatched_at IS NOT NULL → stuck once dispatched_at
//                                                  itself is older than
//                                                  STUCK_THRESHOLD_MS (the
//                                                  trigger fired; the
//                                                  upload never followed)
//   uploading / processing                      → stuck once updated_at is
//                                                  older than the
//                                                  threshold — both are set
//                                                  by an atomic claim
//                                                  UPDATE that stamps
//                                                  updated_at at the exact
//                                                  moment of that
//                                                  transition (route.ts's
//                                                  pending_android→uploading
//                                                  claim, processor.ts's
//                                                  uploaded→processing
//                                                  claim), so updated_at
//                                                  unambiguously means "last
//                                                  forward progress" there —
//                                                  unlike pending_android,
//                                                  where it can also just
//                                                  mean "row was inserted".
//   uploaded                                    → intentionally NOT covered
//                                                  here. Audio events sit in
//                                                  'uploaded' only briefly —
//                                                  processUploadedAudioEvents()
//                                                  drains them every 3s
//                                                  tick, so a 5-minute
//                                                  staleness check adds no
//                                                  value there and was never
//                                                  part of this function's
//                                                  scope (confirmed: the old
//                                                  predicate never included
//                                                  it either — not a change).
export async function recoverStuckMediaEvents(supabase: AppSupabase): Promise<void> {
  const staleBefore = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString()

  // SELECT first (not a blind UPDATE) so we know which of the stuck rows are
  // AUDIO — those need handleMediaNeverUploaded (Fase 6B.1) so the customer
  // gets SOME reply instead of pure silence; image/document already sent
  // their AI reply immediately when the placeholder first arrived, so they
  // have no equivalent gap to close (see processor.ts's doc comment on
  // handleMediaNeverUploaded for the full rationale).
  //
  // Two separate queries (not one predicate) because 'pending_android'
  // staleness is judged on dispatched_at while 'uploading'/'processing'
  // staleness is judged on updated_at — see the policy above.
  const { data: stuckDispatched } = await supabase
    .from('media_events')
    .select('id, media_type, message_id, conversation_id')
    .eq('status', 'pending_android')
    .not('dispatched_at', 'is', null)
    .lt('dispatched_at', staleBefore)

  const { data: stuckInFlight } = await supabase
    .from('media_events')
    .select('id, media_type, message_id, conversation_id')
    .in('status', ['uploading', 'processing'])
    .lt('updated_at', staleBefore)

  const stuck = [...(stuckDispatched ?? []), ...(stuckInFlight ?? [])]

  if (stuck.length === 0) return

  const { data: updated } = await supabase
    .from('media_events')
    .update({
      status:     'failed',
      error:      'stuck_after_worker_restart_or_no_upload',
      updated_at: new Date().toISOString(),
    })
    .in('id', stuck.map((e) => e.id))
    .select('id')

  if (updated && updated.length > 0) {
    console.warn(
      `[media-dispatcher] marked ${updated.length} stuck media event(s) as failed ` +
      '(no upload received / crashed mid-processing — not retried automatically)',
    )
  }

  for (const event of stuck) {
    if (event.media_type !== 'audio') continue
    await handleMediaNeverUploaded(event.message_id, event.conversation_id).catch((err: unknown) => {
      console.error('[media-dispatcher] handleMediaNeverUploaded failed (non-fatal)', {
        eventId: event.id, error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

async function claimNextMediaEvent(supabase: AppSupabase): Promise<MediaEventRow | null> {
  // Atomic in Postgres — see migration 20260826000002_claim_next_media_event.sql
  // and 20260826000003_device_dispatch_lease.sql (Fase 6B.2 cross-queue lease).
  const { data, error } = await supabase.rpc('claim_next_media_event', {
    p_lease_seconds: DEVICE_DISPATCH_LEASE_SECONDS,
  })

  if (error) {
    console.error('[media-dispatcher] claim_next_media_event RPC error', { error: error.message })
    return null
  }

  return data?.[0] ?? null
}

async function dispatchOne(supabase: AppSupabase, event: MediaEventRow): Promise<void> {
  const { data: account } = await supabase
    .from('whatsapp_accounts')
    .select('macrodroid_webhook_url, active')
    .eq('id', event.account_id)
    .maybeSingle()

  // Never log the URL itself — only that it is present/absent.
  if (!account?.active || !account.macrodroid_webhook_url) {
    console.error('[media-dispatcher] account inactive or missing macrodroid_webhook_url', {
      eventId: event.id, accountId: event.account_id,
    })
    await supabase
      .from('media_events')
      .update({ status: 'failed', error: 'account_misconfigured', updated_at: new Date().toISOString() })
      .eq('id', event.id)
    // Fase 6B.2 correction: deliberately not released early — see the
    // comment below the dispatch call for the full rationale. Expires on
    // its own after DEVICE_DISPATCH_LEASE_SECONDS.
    return
  }

  const mediaType = event.media_type as 'audio' | 'image' | 'document'
  const result = await dispatchMediaTriggerToMacroDroid(
    account.macrodroid_webhook_url,
    event.id,
    mediaType,
    event.expected_filename,
  )
  // Fase 6B.2 correction: do NOT release the device lease here just because
  // the fetch() resolved. A "200 OK" from MacroDroid only means the trigger
  // was ACKNOWLEDGED — it says nothing about whether the physical macro
  // (Wait → locate file → read → POST bytes) has actually finished running
  // on the Android. Releasing on fetch-resolution would let the OTHER
  // queue (outbound text) fire a second trigger at the same device while
  // this macro is still physically executing — same reasoning as
  // dispatcher.ts's equivalent comment, and it applies identically to a
  // failed/timed-out fetch (ambiguous outcome ≠ Android is free). The
  // lease is left to expire naturally at device_dispatch_reserved_until
  // (set by the claim RPC) — conservative by design for this stage.

  if (result.status === 'dispatched') {
    // Stays 'pending_android' — dispatched_at (already set by the claim
    // RPC) is what distinguishes "triggered, waiting for Android" from "not
    // yet triggered". The event only leaves this state once the actual
    // upload arrives at POST /api/webhooks/autoresponder/media.
    console.log('[media-dispatcher] trigger dispatched', {
      eventId: event.id, accountId: event.account_id, conversationId: event.conversation_id, mediaType,
    })
  } else {
    await supabase
      .from('media_events')
      .update({ status: 'failed', error: result.error ?? 'unknown', updated_at: new Date().toISOString() })
      .eq('id', event.id)
    console.error('[media-dispatcher] trigger failed', {
      eventId: event.id, accountId: event.account_id, conversationId: event.conversation_id, error: result.error,
    })
  }
}

// Audio events that finished uploading need transcription + a resumed AI
// pipeline (see processor.ts's resumeAfterMediaReady) — image/document never
// reach 'uploaded' via this path (the upload endpoint marks them 'ready'
// directly, since their AI reply already went out synchronously when the
// placeholder first arrived). Drained in the same tick as dispatch, capped
// the same way, to avoid a 4th independent poll loop.
async function processUploadedAudioEvents(supabase: AppSupabase): Promise<void> {
  const { data: events } = await supabase
    .from('media_events')
    .select('id')
    .eq('status', 'uploaded')
    .eq('media_type', 'audio')
    .order('created_at', { ascending: true })
    .limit(MAX_DISPATCHES_PER_TICK)

  for (const event of events ?? []) {
    await resumeAfterMediaReady(event.id)
  }
}

// Exported so integration scripts can drive the dispatcher deterministically,
// one cycle at a time — same pattern as dispatcher.ts's runDispatchTick.
export async function runMediaDispatchTick(): Promise<void> {
  if (isDispatching) return
  isDispatching = true

  try {
    const supabase = createClient()
    for (let i = 0; i < MAX_DISPATCHES_PER_TICK; i++) {
      const event = await claimNextMediaEvent(supabase)
      if (!event) break
      await dispatchOne(supabase, event)
    }
    await processUploadedAudioEvents(supabase)
  } catch (err) {
    console.error('[media-dispatcher] tick error', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    isDispatching = false
  }
}

export async function startMediaDispatcher(): Promise<void> {
  console.log(`[media-dispatcher] polling every ${POLL_INTERVAL_MS / 1000}s`)
  await recoverStuckMediaEvents(createClient())
  runMediaDispatchTick()
  setInterval(runMediaDispatchTick, POLL_INTERVAL_MS)
  // Fase 6B.5 — periodic recovery, decoupled from the 3s dispatch tick (see
  // recoverStuckMediaEvents's doc comment for why the old startup-only call
  // was insufficient).
  setInterval(() => {
    recoverStuckMediaEvents(createClient()).catch((err: unknown) => {
      console.error('[media-dispatcher] periodic recoverStuckMediaEvents failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, RECOVERY_INTERVAL_MS)
}

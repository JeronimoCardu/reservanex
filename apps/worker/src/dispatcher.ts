// Polls messaging_outbox and dispatches pending items via MacroDroid,
// serialized per account/device via the claim_next_outbox_item Postgres RPC
// (see migration 20260825000003 for why this must be atomic in Postgres,
// not decided in JS — dispatcher-claim.ts's pure functions are kept as
// offline-tested documentation of the policy the RPC enforces, but are no
// longer the actual enforcement mechanism).
// Independent from poller.ts (inbound message_queue) — this file is never
// imported by it and does not touch it.
import type { Database } from '@orderflow/types'
import { createClient } from './lib/supabase'
import { dispatchToMacroDroid } from './providers/autoresponder/outbound'
import { DEVICE_DISPATCH_LEASE_SECONDS } from './lib/device-lease'

type OutboxRow   = Database['public']['Tables']['messaging_outbox']['Row']
type AppSupabase = ReturnType<typeof createClient>

const POLL_INTERVAL_MS = 3_000

// Conservative cooldown after a dispatch before the NEXT message on the SAME
// Android is allowed to fire. WhatsApp Send is physical UI automation
// (screen on, app switch, type, send) — not instantaneous — so a short gap
// after each dispatch reduces the risk of overlapping automation on one
// device. 8s is an initial conservative value, not yet tuned against real
// device throughput (see Fase 4 report §8) — safe to lower later once we
// observe how long a real WhatsApp Send actually takes end to end. Different
// accounts/Androids are NEVER subject to each other's cooldown — see
// dispatcher-claim.ts's computeBusyAccountIds/pickNextClaimable.
const ACCOUNT_DISPATCH_COOLDOWN_MS = 8_000

// Upper bound on how many items one tick will drain (one per free account,
// looping until no claimable item remains) — a simple safety cap, not a
// throughput target.
const MAX_DISPATCHES_PER_TICK = 10

// A worker crash/restart while an item was mid-dispatch leaves it stuck in
// 'processing' with an AMBIGUOUS outcome — we cannot know whether MacroDroid
// already received the trigger. Per Fase 4 report §7 ("no retry automático
// agresivo"), this must NEVER be silently resurrected to 'pending' for
// another dispatch attempt — same "always fail, never retry" policy the
// inbound message_queue's recoverProcessingItems() also settled on after
// its Fase 7 Parte D audit (it used to reset to 'pending' for
// attempts<3, but that risked genuine concurrent double-processing under
// multiple worker instances — see lib/supabase.ts's doc comment). It is
// marked 'failed' instead, preserving the row for manual review/retry (see
// messaging_outbox.error).
const STUCK_PROCESSING_THRESHOLD_MS = 2 * 60 * 1000

let isDispatching = false

async function recoverStuckOutboxItems(supabase: AppSupabase): Promise<void> {
  const staleBefore = new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_MS).toISOString()

  const { data } = await supabase
    .from('messaging_outbox')
    .update({
      status:     'failed',
      error:      'stuck_after_worker_restart',
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .lt('updated_at', staleBefore)
    .select('id')

  if (data && data.length > 0) {
    console.warn(
      `[dispatcher] marked ${data.length} stuck 'processing' item(s) as failed ` +
      '(ambiguous outcome after a worker restart — not retried automatically)',
    )
  }
}

async function claimNextOutboxItem(supabase: AppSupabase): Promise<OutboxRow | null> {
  // Atomic in Postgres — see migration 20260825000003_claim_next_outbox_item.sql.
  // The "is this account already busy" check and the claim itself happen
  // inside one pg_try_advisory_xact_lock(account_id)-guarded section, so two
  // concurrent worker processes calling this RPC at the same time can never
  // both claim a pending item for the same account.
  const { data, error } = await supabase.rpc('claim_next_outbox_item', {
    p_cooldown_seconds: Math.round(ACCOUNT_DISPATCH_COOLDOWN_MS / 1000),
    p_lease_seconds:    DEVICE_DISPATCH_LEASE_SECONDS,
  })

  if (error) {
    console.error('[dispatcher] claim_next_outbox_item RPC error', { error: error.message })
    return null
  }

  return data?.[0] ?? null
}

// Single, reliable place every post-claim failure funnels through — see
// dispatchOne's two call sites. Previously the "account misconfigured"
// branch logged its own bespoke line and the dispatch-failed branch logged
// a separate one; a real physical E2E run showed this split made it easy to
// miss the failure entirely when only skimming worker output for one
// specific string. outbound.ts itself never logs anything (it only returns
// a structured, pre-sanitized result) — this is the one place the final
// failure summary is emitted, so there is exactly one line to grep for.
async function markOutboxFailed(
  supabase:     AppSupabase,
  item:         OutboxRow,
  error:        string,
  networkCode?: string,
): Promise<void> {
  await supabase
    .from('messaging_outbox')
    .update({ status: 'failed', error, updated_at: new Date().toISOString() })
    .eq('id', item.id)

  console.error('[dispatcher] failed', {
    outboxId:  item.id,
    accountId: item.account_id,
    error,
    ...(networkCode ? { networkCode } : {}),
  })
}

async function dispatchOne(supabase: AppSupabase, item: OutboxRow): Promise<void> {
  const { data: account } = await supabase
    .from('whatsapp_accounts')
    .select('macrodroid_webhook_url, active')
    .eq('id', item.account_id)
    .maybeSingle()

  // Never log the URL itself — only that it is present/absent.
  if (!account?.active || !account.macrodroid_webhook_url) {
    await markOutboxFailed(supabase, item, 'account_misconfigured')
    // Fase 6B.2 correction: the claim RPC already reserved the shared
    // device lease before we discovered this account can't actually be
    // dispatched to — deliberately NOT released early here either (see the
    // comment below the dispatchToMacroDroid call for the full rationale).
    // It simply expires on its own after DEVICE_DISPATCH_LEASE_SECONDS.
    return
  }

  const result = await dispatchToMacroDroid(account.macrodroid_webhook_url, item.destination_phone, item.text, item.id)
  // Fase 6B.2 correction: do NOT release the device lease here just because
  // the fetch() resolved. A "200 OK" from MacroDroid only means the trigger
  // was ACKNOWLEDGED — it says nothing about whether the physical macro
  // (Screen On → Wait → WhatsApp Send) has actually finished running on the
  // Android. Releasing on fetch-resolution would let the OTHER queue
  // (media) fire a second trigger at the same device while this macro is
  // still physically executing. Same reasoning applies to a failed/
  // timed-out fetch: an ambiguous outcome does NOT mean the Android is
  // free either. The lease is left to expire naturally at
  // device_dispatch_reserved_until (set by the claim RPC, ~
  // DEVICE_DISPATCH_LEASE_SECONDS from the claim) — a deliberately
  // conservative, correctness-over-throughput choice for this stage.
  // Fase 8 "outbound ACK" added a physical POST-back from the macro
  // (device_ack_at, via /api/webhooks/autoresponder/outbound-ack) that DOES
  // signal "actually done" — but it is deliberately NOT wired into the
  // lease here: releasing early on ACK, or retrying on a missing one, was
  // explicitly out of scope (no automatic retry policy changes — see that
  // route's/outbound-status.ts's doc comments). The ACK exists purely to
  // inform the CRM's displayed status, never to change dispatch timing.

  if (result.status === 'dispatched') {
    await supabase
      .from('messaging_outbox')
      .update({ status: 'dispatched', dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', item.id)
    // Fase 7 Parte A — the trigger SERVICE accepted the order (HTTP OK from
    // trigger.macrodroid.com), which is meaningfully weaker evidence than an
    // authenticated request FROM the Android — it proves the relay is up,
    // not that the device received or executed anything. That's exactly why
    // this updates last_outbound_dispatch_at only, never
    // last_device_seen_at (see the migration's doc comment).
    await supabase
      .from('whatsapp_accounts')
      .update({ last_outbound_dispatch_at: new Date().toISOString() })
      .eq('id', item.account_id)
    // Never log destination_phone or text — only structural/diagnostic fields.
    console.log('[dispatcher] dispatched', {
      outboxId: item.id, accountId: item.account_id, conversationId: item.conversation_id, source: item.source,
    })
  } else {
    await markOutboxFailed(supabase, item, result.error ?? 'unknown', result.networkCode)
  }
}

// Exported (not just used by startDispatcher's setInterval) so integration
// scripts can drive the dispatcher deterministically, one cycle at a time,
// without waiting on a real timer — see validate-autoresponder.ts.
export async function runDispatchTick(): Promise<void> {
  if (isDispatching) return
  isDispatching = true

  try {
    const supabase = createClient()
    for (let i = 0; i < MAX_DISPATCHES_PER_TICK; i++) {
      const item = await claimNextOutboxItem(supabase)
      if (!item) break
      await dispatchOne(supabase, item)
    }
  } catch (err) {
    console.error('[dispatcher] tick error', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    isDispatching = false
  }
}

export async function startDispatcher(): Promise<void> {
  console.log(
    `[dispatcher] polling every ${POLL_INTERVAL_MS / 1000}s, ` +
    `cooldown ${ACCOUNT_DISPATCH_COOLDOWN_MS / 1000}s per account`,
  )
  await recoverStuckOutboxItems(createClient())
  runDispatchTick()
  setInterval(runDispatchTick, POLL_INTERVAL_MS)
}

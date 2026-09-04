import type { Database } from '@orderflow/types'
import { claimQueueItem, completeQueueItem, failQueueItem, recoverProcessingItems } from './lib/supabase'
import { processMessage } from './processor'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

const POLL_INTERVAL_MS = 3_000

// Fase 7 Parte D — recoverProcessingItems() must run periodically, not just
// once at startup, for the same reason media-dispatcher.ts's
// recoverStuckMediaEvents() was fixed to do so in Fase 6B.5: a long-running
// worker that never restarts would otherwise never terminalize a
// genuinely-crashed 'processing' row. Independent timer (like
// media-dispatcher.ts's RECOVERY_INTERVAL_MS), not tied to the 3s poll
// tick, to keep the hot path free of an extra query most cycles won't need.
const RECOVERY_INTERVAL_MS = 60_000

// Single-process guard: prevents overlapping executions within the same Node.js
// process. Must be set to true BEFORE the first await so no subsequent
// setInterval tick can slip through while claimQueueItem is in-flight.
let isProcessing = false

// Exported (not just used by startPoller's setInterval) so integration
// scripts can drive the poller deterministically, one cycle at a time —
// same pattern as dispatcher.ts's runDispatchTick / media-dispatcher.ts's
// runMediaDispatchTick.
export async function runPollerTick(): Promise<void> {
  return poll()
}

async function poll(): Promise<void> {
  if (isProcessing) return

  // Acquire the guard before any async operation. Without this, two ticks could
  // both pass the check above and race to claim the same queue item.
  isProcessing = true

  let item: QueueRow | null = null

  try {
    item = await claimQueueItem()
    if (!item) return  // nothing pending — finally resets isProcessing

    await processMessage(item)
    await completeQueueItem(item.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (item) {
      console.error('[poller] error on item', item.id, '—', message)
      try {
        await failQueueItem(item.id, message)
      } catch (failErr) {
        // failQueueItem can throw if the DB is unreachable; log and continue
        // so the polling loop stays alive rather than crashing the process.
        const failMsg = failErr instanceof Error ? failErr.message : String(failErr)
        console.error('[poller] could not mark item as failed:', failMsg)
      }
    } else {
      // claimQueueItem itself threw (e.g. DB connection error during poll)
      console.error('[poller] error during claim —', message)
    }
  } finally {
    isProcessing = false
  }
}

export async function startPoller(): Promise<void> {
  console.log(`[poller] polling every ${POLL_INTERVAL_MS / 1000}s`)
  // Recover items stuck in 'processing' past the safe threshold — same
  // function/threshold/behavior as the periodic call below (Fase 7 Parte D).
  await recoverProcessingItems()
  // Run once immediately so the first message isn't delayed 3s
  poll()
  setInterval(poll, POLL_INTERVAL_MS)
  setInterval(() => {
    recoverProcessingItems().catch((err: unknown) => {
      console.error('[poller] periodic recoverProcessingItems failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, RECOVERY_INTERVAL_MS)
}

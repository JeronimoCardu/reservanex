// Pure decision logic for serializing outbound dispatch per Android/account.
// A physical Android running WhatsApp Send UI automation cannot process two
// sends at once — these functions decide which single outbox item (if any)
// is safe to claim next, without ever touching the DB themselves.
//
// Fase 4.1: this JS-side compute-then-decide sequence is NOT what enforces
// serialization anymore — running it from two concurrent worker processes
// against the same DB is racy under READ COMMITTED (see migration
// 20260825000003_claim_next_outbox_item.sql for the exact scenario). The
// real enforcement is now the claim_next_outbox_item Postgres RPC
// (pg_try_advisory_xact_lock per account_id), called from dispatcher.ts.
// These functions are kept as an executable, unit-tested specification of
// the intended policy (FIFO, cooldown, cross-account independence) that the
// RPC must match — not as the mechanism itself.

export interface OutboxCandidate {
  id:         string
  account_id: string
  created_at: string
}

// Picks the oldest pending outbox item whose account is not currently busy.
// `candidates` must already be sorted oldest-first (the caller's query does
// this) — this function does not sort.
//
// This is what makes different Androids progress independently: an item for
// an idle account is picked even when an OLDER item for a different, busy
// account exists ahead of it in the list — that older item is simply skipped
// for this claim attempt, not blocking anyone else.
export function pickNextClaimable(
  candidates:     OutboxCandidate[],
  busyAccountIds: ReadonlySet<string>,
): OutboxCandidate | null {
  return candidates.find((c) => !busyAccountIds.has(c.account_id)) ?? null
}

export interface OutboxStatusRow {
  account_id:    string
  status:        string
  dispatched_at: string | null
}

// An account is "busy" if it has an item currently `processing`, or if its
// most recent dispatch happened within the cooldown window — a conservative
// guard against overlapping WhatsApp Send UI automation on the same Android
// (see ACCOUNT_DISPATCH_COOLDOWN_MS in dispatcher.ts for the chosen value).
export function computeBusyAccountIds(
  rows:       OutboxStatusRow[],
  nowMs:      number,
  cooldownMs: number,
): Set<string> {
  const busy = new Set<string>()
  for (const row of rows) {
    if (row.status === 'processing') {
      busy.add(row.account_id)
      continue
    }
    if (row.status === 'dispatched' && row.dispatched_at) {
      const dispatchedMs = new Date(row.dispatched_at).getTime()
      if (nowMs - dispatchedMs < cooldownMs) {
        busy.add(row.account_id)
      }
    }
  }
  return busy
}

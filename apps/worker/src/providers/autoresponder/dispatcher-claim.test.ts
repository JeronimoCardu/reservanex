import { describe, expect, it } from 'vitest'
import { pickNextClaimable, computeBusyAccountIds, type OutboxCandidate, type OutboxStatusRow } from './dispatcher-claim'

describe('pickNextClaimable', () => {
  it('picks the oldest candidate when no account is busy', () => {
    const candidates: OutboxCandidate[] = [
      { id: '1', account_id: 'A', created_at: '2026-01-01T00:00:00Z' },
      { id: '2', account_id: 'A', created_at: '2026-01-01T00:00:01Z' },
    ]
    expect(pickNextClaimable(candidates, new Set())).toEqual(candidates[0])
  })

  it('two messages for the SAME account never run in parallel — the second is skipped while the account is busy', () => {
    const candidates: OutboxCandidate[] = [
      { id: '1', account_id: 'A', created_at: '2026-01-01T00:00:00Z' },
      { id: '2', account_id: 'A', created_at: '2026-01-01T00:00:01Z' },
    ]
    // account A already has an item in flight
    const result = pickNextClaimable(candidates, new Set(['A']))
    expect(result).toBeNull()
  })

  it('a different Android (different account) can progress independently while another is busy', () => {
    const candidates: OutboxCandidate[] = [
      { id: '1', account_id: 'A', created_at: '2026-01-01T00:00:00Z' }, // oldest, but A is busy
      { id: '2', account_id: 'B', created_at: '2026-01-01T00:00:01Z' }, // newer, B is free
    ]
    const result = pickNextClaimable(candidates, new Set(['A']))
    expect(result).toEqual(candidates[1])
  })

  it('returns null when every candidate account is busy', () => {
    const candidates: OutboxCandidate[] = [
      { id: '1', account_id: 'A', created_at: '2026-01-01T00:00:00Z' },
      { id: '2', account_id: 'B', created_at: '2026-01-01T00:00:01Z' },
    ]
    expect(pickNextClaimable(candidates, new Set(['A', 'B']))).toBeNull()
  })

  it('returns null for an empty candidate list', () => {
    expect(pickNextClaimable([], new Set())).toBeNull()
  })
})

describe('computeBusyAccountIds', () => {
  it('marks an account busy while it has a processing item', () => {
    const rows: OutboxStatusRow[] = [{ account_id: 'A', status: 'processing', dispatched_at: null }]
    const busy = computeBusyAccountIds(rows, Date.now(), 8000)
    expect(busy.has('A')).toBe(true)
  })

  it('marks an account busy within the cooldown window after a dispatch', () => {
    const now  = new Date('2026-01-01T00:00:10.000Z').getTime()
    const rows: OutboxStatusRow[] = [{ account_id: 'A', status: 'dispatched', dispatched_at: '2026-01-01T00:00:05.000Z' }]
    // 5s elapsed, cooldown is 8s → still busy
    const busy = computeBusyAccountIds(rows, now, 8000)
    expect(busy.has('A')).toBe(true)
  })

  it('no longer marks an account busy once the cooldown has elapsed', () => {
    const now  = new Date('2026-01-01T00:00:20.000Z').getTime()
    const rows: OutboxStatusRow[] = [{ account_id: 'A', status: 'dispatched', dispatched_at: '2026-01-01T00:00:05.000Z' }]
    // 15s elapsed, cooldown is 8s → free again
    const busy = computeBusyAccountIds(rows, now, 8000)
    expect(busy.has('A')).toBe(false)
  })

  it('a failed item does not keep an account busy', () => {
    const rows: OutboxStatusRow[] = [{ account_id: 'A', status: 'failed', dispatched_at: null }]
    const busy = computeBusyAccountIds(rows, Date.now(), 8000)
    expect(busy.has('A')).toBe(false)
  })

  it('tracks multiple independent accounts correctly', () => {
    const now  = Date.now()
    const rows: OutboxStatusRow[] = [
      { account_id: 'A', status: 'processing', dispatched_at: null },
      { account_id: 'B', status: 'failed', dispatched_at: null },
    ]
    const busy = computeBusyAccountIds(rows, now, 8000)
    expect(busy.has('A')).toBe(true)
    expect(busy.has('B')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { decideAutoResponderDelivery } from './delivery-decision'

describe('decideAutoResponderDelivery — Fase 1B (nunca outbox/MacroDroid)', () => {
  it('no live sync context at all (async poller, resumeAfterMediaReady, etc.) → never deliver', () => {
    const result = decideAutoResponderDelivery(undefined, Date.now())
    expect(result).toEqual({ deliver: false, reason: 'no_sync_context' })
  })

  it('within the deadline → deliver', () => {
    const now = 1_000_000
    const result = decideAutoResponderDelivery({ deadlineAtMs: now + 5_000 }, now)
    expect(result).toEqual({ deliver: true })
  })

  it('exactly at the deadline → NOT delivered (>= is the boundary, matches processor.ts)', () => {
    const now = 1_000_000
    const result = decideAutoResponderDelivery({ deadlineAtMs: now }, now)
    expect(result).toEqual({ deliver: false, reason: 'deadline_exceeded' })
  })

  it('past the deadline (e.g. DeepSeek finished after the HTTP response already gave up) → never deliver', () => {
    const now = 1_000_000
    const result = decideAutoResponderDelivery({ deadlineAtMs: now - 1 }, now)
    expect(result).toEqual({ deliver: false, reason: 'deadline_exceeded' })
  })

  it('there is no third outcome — deliver is always exactly true or an explicit drop reason', () => {
    const cases = [
      decideAutoResponderDelivery(undefined, 0),
      decideAutoResponderDelivery({ deadlineAtMs: 100 }, 50),
      decideAutoResponderDelivery({ deadlineAtMs: 100 }, 150),
    ]
    for (const c of cases) {
      if (c.deliver) {
        expect(Object.keys(c)).toEqual(['deliver'])
      } else {
        expect(['no_sync_context', 'deadline_exceeded']).toContain(c.reason)
      }
    }
  })
})

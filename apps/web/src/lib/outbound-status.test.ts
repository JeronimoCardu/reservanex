import { describe, expect, it } from 'vitest'
import {
  deriveOutboundDisplayStatus,
  OUTBOUND_UNCONFIRMED_THRESHOLD_MS,
  ACK_PROTOCOL_INTRODUCED_AT,
} from './outbound-status'

const NOW = new Date('2026-09-05T12:00:00Z') // well after ACK_PROTOCOL_INTRODUCED_AT

function secondsAgo(s: number): string {
  return new Date(NOW.getTime() - s * 1000).toISOString()
}

describe('deriveOutboundDisplayStatus', () => {
  it('11. no outbox row at all (inbound message, Meta provider, or enqueue never created one) → null, never a state', () => {
    expect(deriveOutboundDisplayStatus(null, NOW)).toBeNull()
  })

  it('11. pending/queued → "queued"', () => {
    expect(deriveOutboundDisplayStatus({ status: 'pending', dispatchedAt: null, deviceAckAt: null }, NOW)).toBe('queued')
    expect(deriveOutboundDisplayStatus({ status: 'processing', dispatchedAt: null, deviceAckAt: null }, NOW)).toBe('queued')
  })

  it('12. dispatched recently, no ACK → "dispatched_to_device"', () => {
    const result = deriveOutboundDisplayStatus(
      { status: 'dispatched', dispatchedAt: secondsAgo(10), deviceAckAt: null },
      NOW,
    )
    expect(result).toBe('dispatched_to_device')
  })

  it('right at the threshold boundary is still dispatched_to_device (strictly greater-than triggers unconfirmed)', () => {
    const result = deriveOutboundDisplayStatus(
      { status: 'dispatched', dispatchedAt: secondsAgo(OUTBOUND_UNCONFIRMED_THRESHOLD_MS / 1000), deviceAckAt: null },
      NOW,
    )
    expect(result).toBe('dispatched_to_device')
  })

  it('13. dispatched long ago (past the 60s threshold), no ACK, after the protocol existed → "unconfirmed"', () => {
    const result = deriveOutboundDisplayStatus(
      { status: 'dispatched', dispatchedAt: secondsAgo(OUTBOUND_UNCONFIRMED_THRESHOLD_MS / 1000 + 1), deviceAckAt: null },
      NOW,
    )
    expect(result).toBe('unconfirmed')
  })

  it('14. device_ack_at set → "device_executed", regardless of how much time has passed', () => {
    const result = deriveOutboundDisplayStatus(
      { status: 'dispatched', dispatchedAt: secondsAgo(600), deviceAckAt: secondsAgo(590) },
      NOW,
    )
    expect(result).toBe('device_executed')
  })

  it('device_executed takes priority even if the outbox row somehow still says a non-dispatched status', () => {
    const result = deriveOutboundDisplayStatus(
      { status: 'failed', dispatchedAt: secondsAgo(600), deviceAckAt: secondsAgo(590) },
      NOW,
    )
    expect(result).toBe('device_executed')
  })

  it('messaging_outbox.status = failed, no ACK → "failed"', () => {
    const result = deriveOutboundDisplayStatus(
      { status: 'failed', dispatchedAt: null, deviceAckAt: null },
      NOW,
    )
    expect(result).toBe('failed')
  })

  it('18. a message dispatched BEFORE the ACK protocol existed never shows "unconfirmed", even if very old and never ACKed', () => {
    const preProtocolDispatch = new Date(new Date(ACK_PROTOCOL_INTRODUCED_AT).getTime() - 3600_000).toISOString()
    const result = deriveOutboundDisplayStatus(
      { status: 'dispatched', dispatchedAt: preProtocolDispatch, deviceAckAt: null },
      NOW,
    )
    expect(result).toBe('dispatched_to_device')
    expect(result).not.toBe('unconfirmed')
  })

  it('a message dispatched exactly at/after the protocol cutover IS eligible for "unconfirmed"', () => {
    const justAfterCutover = new Date(new Date(ACK_PROTOCOL_INTRODUCED_AT).getTime() + 1000).toISOString()
    const longAfterNow = new Date(new Date(justAfterCutover).getTime() + OUTBOUND_UNCONFIRMED_THRESHOLD_MS + 5000)
    const result = deriveOutboundDisplayStatus(
      { status: 'dispatched', dispatchedAt: justAfterCutover, deviceAckAt: null },
      longAfterNow,
    )
    expect(result).toBe('unconfirmed')
  })
})

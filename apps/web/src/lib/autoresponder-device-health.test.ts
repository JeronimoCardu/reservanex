import { describe, expect, it } from 'vitest'
import {
  deriveDeviceStatus,
  DEVICE_ONLINE_THRESHOLD_MS,
  DEVICE_STALE_THRESHOLD_MS,
} from './autoresponder-device-health'

const NOW = new Date('2026-08-27T12:00:00Z')

function minutesAgo(mins: number): string {
  return new Date(NOW.getTime() - mins * 60 * 1000).toISOString()
}

describe('deriveDeviceStatus', () => {
  it('15. an inactive/disabled account is "disabled" regardless of last_device_seen_at', () => {
    expect(deriveDeviceStatus({ configStatus: 'disabled', lastDeviceSeenAt: minutesAgo(0), now: NOW })).toBe('disabled')
  })

  it('an incomplete or not-yet-configured account is "not_configured"', () => {
    expect(deriveDeviceStatus({ configStatus: 'incomplete', lastDeviceSeenAt: null, now: NOW })).toBe('not_configured')
    expect(deriveDeviceStatus({ configStatus: 'not_configured', lastDeviceSeenAt: null, now: NOW })).toBe('not_configured')
  })

  it('16. configured + active but never seen → never_seen', () => {
    expect(deriveDeviceStatus({ configStatus: 'ready', lastDeviceSeenAt: null, now: NOW })).toBe('never_seen')
  })

  it('17. within the online threshold (<=5 min) → online', () => {
    expect(deriveDeviceStatus({ configStatus: 'ready', lastDeviceSeenAt: minutesAgo(0), now: NOW })).toBe('online')
    expect(deriveDeviceStatus({ configStatus: 'ready', lastDeviceSeenAt: minutesAgo(5), now: NOW })).toBe('online')
  })

  it('18. beyond online but within stale (>5min, <=15min) → stale', () => {
    expect(deriveDeviceStatus({ configStatus: 'ready', lastDeviceSeenAt: minutesAgo(5.5), now: NOW })).toBe('stale')
    expect(deriveDeviceStatus({ configStatus: 'ready', lastDeviceSeenAt: minutesAgo(15), now: NOW })).toBe('stale')
  })

  it('19. beyond stale (>15 min) → offline', () => {
    expect(deriveDeviceStatus({ configStatus: 'ready', lastDeviceSeenAt: minutesAgo(15.5), now: NOW })).toBe('offline')
    expect(deriveDeviceStatus({ configStatus: 'ready', lastDeviceSeenAt: minutesAgo(60), now: NOW })).toBe('offline')
  })

  it('thresholds are centralized constants, not magic numbers scattered in the logic', () => {
    expect(DEVICE_ONLINE_THRESHOLD_MS).toBe(5 * 60 * 1000)
    expect(DEVICE_STALE_THRESHOLD_MS).toBe(15 * 60 * 1000)
  })

  it('disabled takes priority over stale/offline timestamps', () => {
    expect(deriveDeviceStatus({ configStatus: 'disabled', lastDeviceSeenAt: minutesAgo(999), now: NOW })).toBe('disabled')
  })
})

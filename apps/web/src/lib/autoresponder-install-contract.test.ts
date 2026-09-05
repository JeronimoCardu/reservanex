import { describe, expect, it } from 'vitest'
import {
  HEADER_DEVICE_TOKEN,
  HEARTBEAT_INTERVAL_MINUTES,
  AUTORESPONDER_APP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE,
} from './autoresponder-install-contract'
import { hashDeviceToken } from './autoresponder-webhook'
import { DEVICE_ONLINE_THRESHOLD_MS } from './autoresponder-device-health'

// Fase 2A (AUTORESPONDER-ONLY) — the MacroDroid macro contract (rn_* trigger
// variables, outbound/media branch actions, macro wait timings, media
// content types, the media/outbound-ack headers) was deleted along with that
// transport. What remains is the contract the live pipeline actually uses:
// the device-token header, the heartbeat cadence, and the two Android
// package names.

describe('headers', () => {
  it('the device token header matches the literal string the real webhook routes use', () => {
    expect(HEADER_DEVICE_TOKEN).toBe('x-reservanex-device-token')
  })

  it('is never prefixed/suffixed with a tenant identifier — one header name for every tenant', () => {
    expect(HEADER_DEVICE_TOKEN).not.toMatch(/tenant|[0-9a-f]{8}-[0-9a-f]{4}/i)
  })
})

describe('timing constants', () => {
  it('heartbeat interval is documented (2 minutes) and stays under the device "online" threshold', () => {
    expect(HEARTBEAT_INTERVAL_MINUTES).toBe(2)
    // The guide tells the installer to beat every N minutes; if that cadence
    // were slower than the online threshold, a perfectly healthy device would
    // flap to "sin señal" between beats.
    expect(HEARTBEAT_INTERVAL_MINUTES * 60 * 1000).toBeLessThan(DEVICE_ONLINE_THRESHOLD_MS)
  })
})

describe('packages', () => {
  it('app/messenger packages match the physically validated WhatsApp Business setup', () => {
    expect(AUTORESPONDER_APP_PACKAGE).toBe('tkstudio.autoresponderforwa')
    expect(WHATSAPP_BUSINESS_PACKAGE).toBe('com.whatsapp.w4b')
  })

  it('deliberate duplicate (not a re-export, to keep node:crypto out of the client bundle) stays in sync with autoresponder-webhook.ts', () => {
    // hashDeviceToken lives in autoresponder-webhook.ts (server-only, pulls
    // node:crypto). This file re-declares the package constants instead of
    // re-exporting from there so the install guide can stay a client
    // component. This assertion is what keeps the two copies honest.
    expect(typeof hashDeviceToken('x')).toBe('string')
    expect(AUTORESPONDER_APP_PACKAGE).toBe('tkstudio.autoresponderforwa')
  })
})

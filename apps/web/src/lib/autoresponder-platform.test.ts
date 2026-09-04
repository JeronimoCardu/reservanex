import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  generateDeviceToken,
  normalizeAndValidatePhone,
  validateMacroDroidWebhookUrl,
  deriveAutoResponderStatus,
  sanitizeAutoResponderRow,
} from './autoresponder-platform'
import { hashDeviceToken } from './autoresponder-webhook'

describe('generateDeviceToken', () => {
  it('1. produces a token with at least 256 bits of entropy (32 raw bytes, 64 hex chars)', () => {
    const token = generateDeviceToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never repeats across calls (sanity check, not a formal entropy proof)', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateDeviceToken()))
    expect(tokens.size).toBe(50)
  })
})

describe('token hashing (2/3. stored only as hash, raw never persisted by this layer)', () => {
  it('2. hashDeviceToken produces the documented SHA-256 hex digest', () => {
    const raw = generateDeviceToken()
    expect(hashDeviceToken(raw)).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'))
  })

  it('3. the hash never equals the raw token, and the raw token cannot be recovered from it', () => {
    const raw  = generateDeviceToken()
    const hash = hashDeviceToken(raw)
    expect(hash).not.toBe(raw)
    // Different input, virtually certain to produce a different hash —
    // demonstrates the hash is a one-way function of its specific input,
    // not a constant or an echo of the raw value.
    expect(hashDeviceToken(generateDeviceToken())).not.toBe(hash)
  })
})

describe('sanitizeAutoResponderRow (5/7/8 shape sent to the browser)', () => {
  const baseRow = {
    id:                         'acc-1',
    tenant_id:                  'tenant-1',
    phone_number:               '5491112345678',
    device_name:                'Samsung Test',
    active:                     true,
    has_device_token:           true,
    has_macrodroid_url:         true,
    created_at:                 '2026-01-01T00:00:00Z',
    updated_at:                 '2026-01-02T00:00:00Z',
    last_device_seen_at:        null,
    last_inbound_at:            null,
    last_outbound_dispatch_at:  null,
    last_media_upload_at:       null,
    last_outbound_device_ack_at: null,
  }

  it('7. never includes a hash or webhook URL field — the return type has no such fields at all', () => {
    const sanitized = sanitizeAutoResponderRow(baseRow)
    const keys = Object.keys(sanitized)
    expect(keys).not.toContain('inbound_token_hash')
    expect(keys).not.toContain('macrodroid_webhook_url')
    expect(keys.sort()).toEqual([
      'active', 'created_at', 'device_name', 'has_device_token', 'has_macrodroid_url',
      'id', 'last_device_seen_at', 'last_inbound_at', 'last_media_upload_at', 'last_outbound_device_ack_at', 'last_outbound_dispatch_at',
      'phone_number', 'status', 'tenant_id', 'updated_at',
    ])
  })

  it('computes has_device_token / has_macrodroid_url as plain booleans', () => {
    const sanitized = sanitizeAutoResponderRow(baseRow)
    expect(sanitized.has_device_token).toBe(true)
    expect(sanitized.has_macrodroid_url).toBe(true)
  })
})

describe('deriveAutoResponderStatus (17. estado derivado)', () => {
  const complete = { phone_number: '5491112345678', active: true, has_device_token: true, has_macrodroid_url: true }

  it('null row → not_configured', () => {
    expect(deriveAutoResponderStatus(null)).toBe('not_configured')
  })

  it('missing device token → incomplete', () => {
    expect(deriveAutoResponderStatus({ ...complete, has_device_token: false })).toBe('incomplete')
  })

  it('missing macrodroid url → incomplete', () => {
    expect(deriveAutoResponderStatus({ ...complete, has_macrodroid_url: false })).toBe('incomplete')
  })

  it('invalid phone → incomplete', () => {
    expect(deriveAutoResponderStatus({ ...complete, phone_number: 'not-a-phone' })).toBe('incomplete')
  })

  it('complete but inactive → disabled', () => {
    expect(deriveAutoResponderStatus({ ...complete, active: false })).toBe('disabled')
  })

  it('complete and active → ready', () => {
    expect(deriveAutoResponderStatus(complete)).toBe('ready')
  })
})

describe('normalizeAndValidatePhone (13. normalización de teléfono)', () => {
  it('normalizes a human-formatted AR number to canonical 549 + 10 digits', () => {
    const result = normalizeAndValidatePhone('+54 9 11 1234-5678')
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.phone).toBe('5491112345678')
  })

  it('rejects an empty phone', () => {
    const result = normalizeAndValidatePhone('   ')
    expect(result.valid).toBe(false)
  })

  it('rejects a value that never resolves to a valid AR mobile number', () => {
    const result = normalizeAndValidatePhone('not a phone at all')
    expect(result.valid).toBe(false)
  })
})

describe('validateMacroDroidWebhookUrl', () => {
  it('accepts a well-formed https URL on the allowed trigger.macrodroid.com host', () => {
    expect(validateMacroDroidWebhookUrl('https://trigger.macrodroid.com/abc-123/reservanex').valid).toBe(true)
  })

  it('Fase 10 SSRF hardening: rejects any host other than trigger.macrodroid.com — this product only supports MacroDroid\'s own cloud trigger service, so an open host is unnecessary SSRF surface', () => {
    expect(validateMacroDroidWebhookUrl('https://example.org/some/other/webhook').valid).toBe(false)
    expect(validateMacroDroidWebhookUrl('https://169.254.169.254/latest/meta-data/').valid).toBe(false)
    expect(validateMacroDroidWebhookUrl('https://internal.local/webhook').valid).toBe(false)
    expect(validateMacroDroidWebhookUrl('https://trigger.macrodroid.com.evil.com/abc').valid).toBe(false)
  })

  it('Fase 10 Paso 2: rejects the query-string trick (the real host is evil.com; trigger.macrodroid.com only appears in the query string, which the parser never treats as hostname)', () => {
    expect(validateMacroDroidWebhookUrl('https://evil.com/?x=trigger.macrodroid.com').valid).toBe(false)
  })

  it('Fase 10 Paso 2: rejects the userinfo trick (trigger.macrodroid.com@evil.com — everything before @ is a username, the real host is evil.com)', () => {
    expect(validateMacroDroidWebhookUrl('https://trigger.macrodroid.com@evil.com/').valid).toBe(false)
  })

  it('rejects http (non-TLS)', () => {
    const result = validateMacroDroidWebhookUrl('http://trigger.macrodroid.com/abc-123/reservanex')
    expect(result.valid).toBe(false)
  })

  it('rejects a syntactically invalid URL', () => {
    expect(validateMacroDroidWebhookUrl('not a url').valid).toBe(false)
  })

  it('rejects an empty URL', () => {
    expect(validateMacroDroidWebhookUrl('   ').valid).toBe(false)
  })

  it('12. never echoes the input into its error message in a way that could leak it via logs/toasts beyond the field itself', () => {
    const secretLookingUrl = 'https://trigger.macrodroid.com/super-secret-device-id/reservanex'
    const result = validateMacroDroidWebhookUrl(secretLookingUrl)
    // A valid URL returns the URL itself (expected — the caller needs it to
    // persist it). The invariant under test is narrower: an INVALID URL's
    // error message must be a fixed, generic string, never an echo of the
    // input — so malformed secrets never end up formatted into user-facing
    // error text/toasts.
    const invalid = validateMacroDroidWebhookUrl('not a url, but pretend-secret-abc123')
    if (!invalid.valid) {
      expect(invalid.error).not.toContain('pretend-secret-abc123')
    }
    expect(result.valid).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  AUTORESPONDER_APP_PACKAGE as WEBHOOK_APP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE as WEBHOOK_BUSINESS_PACKAGE,
} from './autoresponder-webhook'
import {
  HEADER_DEVICE_TOKEN,
  HEADER_EVENT_ID,
  HEADER_MEDIA_TYPE,
  HEADER_FILENAME,
  HEADER_OUTBOX_ID,
  RN_VAR_ACTION,
  RN_VAR_PHONE,
  RN_VAR_MESSAGE,
  RN_VAR_EVENT_ID,
  RN_VAR_MEDIA_TYPE,
  RN_VAR_FILENAME,
  RN_VAR_OUTBOX_ID,
  RN_ACTION_OUTBOUND,
  RN_ACTION_MEDIA,
  OUTBOUND_WAIT_BEFORE_SEND_SECONDS,
  OUTBOUND_WAIT_AFTER_SEND_SECONDS,
  MEDIA_WAIT_BEFORE_EXTRACT_SECONDS,
  HEARTBEAT_INTERVAL_MINUTES,
  MEDIA_CONTENT_TYPE,
  AUTORESPONDER_APP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE,
} from './autoresponder-install-contract'

describe('headers (17)', () => {
  it('every header name matches the literal string each real webhook route uses', () => {
    expect(HEADER_DEVICE_TOKEN).toBe('x-reservanex-device-token')
    expect(HEADER_EVENT_ID).toBe('x-reservanex-event-id')
    expect(HEADER_MEDIA_TYPE).toBe('x-reservanex-media-type')
    expect(HEADER_FILENAME).toBe('x-reservanex-filename')
    expect(HEADER_OUTBOX_ID).toBe('x-reservanex-outbox-id')
  })

  it('no header name is ever prefixed/suffixed with a tenant identifier', () => {
    for (const h of [HEADER_DEVICE_TOKEN, HEADER_EVENT_ID, HEADER_MEDIA_TYPE, HEADER_FILENAME, HEADER_OUTBOX_ID]) {
      expect(h).toMatch(/^x-reservanex-/)
    }
  })
})

describe('rn_* variables (18)', () => {
  it('the whitelist is complete — 7 variables, exact names', () => {
    expect([RN_VAR_ACTION, RN_VAR_PHONE, RN_VAR_MESSAGE, RN_VAR_EVENT_ID, RN_VAR_MEDIA_TYPE, RN_VAR_FILENAME, RN_VAR_OUTBOX_ID]).toEqual([
      'rn_action', 'rn_phone', 'rn_message', 'rn_event_id', 'rn_media_type', 'rn_filename', 'rn_outbox_id',
    ])
  })

  it('the two branch discriminator values are distinct', () => {
    expect(RN_ACTION_OUTBOUND).toBe('outbound')
    expect(RN_ACTION_MEDIA).toBe('media')
    expect(RN_ACTION_OUTBOUND).not.toBe(RN_ACTION_MEDIA)
  })
})

describe('macro timing constants (19, 20)', () => {
  it('19. Wait-before-send is documented as a named constant (3 seconds — raised from the original 1s after the Fase 9 physical E2E)', () => {
    expect(OUTBOUND_WAIT_BEFORE_SEND_SECONDS).toBe(3)
  })

  it('19b. Wait-before-send is NEVER 1 second — that value was proven insufficient for unattended background/screen-off/post-reboot operation (Fase 9 physical E2E: message left as an unsent draft)', () => {
    expect(OUTBOUND_WAIT_BEFORE_SEND_SECONDS).not.toBe(1)
  })

  it('20. Wait-after-send (before ACK) is documented as a named constant (3 seconds) — physically validated, not optional', () => {
    expect(OUTBOUND_WAIT_AFTER_SEND_SECONDS).toBe(3)
  })

  it('media wait-before-extract is documented (2 seconds)', () => {
    expect(MEDIA_WAIT_BEFORE_EXTRACT_SECONDS).toBe(2)
  })

  it('heartbeat interval is documented (2 minutes) and stays under the device "online" threshold', () => {
    expect(HEARTBEAT_INTERVAL_MINUTES).toBe(2)
  })
})

// Explicit, single-place assertion of the full outbound macro sequence —
// Screen On → Wait 3s → WhatsApp Send → Wait 3s → outbound-ack — so a
// future edit to either wait constant in isolation cannot silently drift
// the documented/rendered contract without this test also changing.
describe('full outbound contract sequence (Fase 9 physical E2E — foreground, background, screen-off, post-reboot)', () => {
  it('both waits around WhatsApp Send are 3 seconds — the guide UI and docs must render exactly this sequence', () => {
    const sequence = [
      'Screen On',
      `Wait ${OUTBOUND_WAIT_BEFORE_SEND_SECONDS} seconds`,
      'WhatsApp Send',
      `Wait ${OUTBOUND_WAIT_AFTER_SEND_SECONDS} seconds`,
      'outbound-ack',
    ]
    expect(sequence).toEqual([
      'Screen On',
      'Wait 3 seconds',
      'WhatsApp Send',
      'Wait 3 seconds',
      'outbound-ack',
    ])
  })

  it('pre-send and post-send waits are equal (both 3s) under the current validated contract', () => {
    expect(OUTBOUND_WAIT_BEFORE_SEND_SECONDS).toBe(OUTBOUND_WAIT_AFTER_SEND_SECONDS)
  })
})

describe('media content types and packages', () => {
  it('matches autoresponder-media.ts\'s MIME_ALLOWLIST primary values exactly', () => {
    expect(MEDIA_CONTENT_TYPE).toEqual({
      audio:    'audio/ogg',
      image:    'image/jpeg',
      document: 'application/pdf',
    })
  })

  it('app/messenger packages match the physically validated WhatsApp Business setup', () => {
    expect(AUTORESPONDER_APP_PACKAGE).toBe('tkstudio.autoresponderforwa')
    expect(WHATSAPP_BUSINESS_PACKAGE).toBe('com.whatsapp.w4b')
  })

  it('deliberate duplicate (not a re-export, to keep node:crypto out of the client bundle — see this file\'s doc comment) stays in sync with autoresponder-webhook.ts', () => {
    expect(AUTORESPONDER_APP_PACKAGE).toBe(WEBHOOK_APP_PACKAGE)
    expect(WHATSAPP_BUSINESS_PACKAGE).toBe(WEBHOOK_BUSINESS_PACKAGE)
  })
})

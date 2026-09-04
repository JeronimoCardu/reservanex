import { describe, expect, it } from 'vitest'
import {
  isAutoResponderPayload,
  isValidAutoResponderPackages,
  isGroupMessage,
  resolveAutoResponderSender,
  extractAutoResponderMessage,
  AUTORESPONDER_APP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE,
  type AutoResponderPayload,
} from './inbound'

// Real payload shape, physically confirmed against the Android (contacto NO guardado).
function makePayload(overrides: Partial<AutoResponderPayload['query']> = {}): AutoResponderPayload {
  return {
    appPackageName:       AUTORESPONDER_APP_PACKAGE,
    messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
    query: {
      sender:           '+54 9 2325 47-1890',
      message:           'TEST-NO-GUARDADO-123',
      isGroup:           false,
      groupParticipant: '',
      ruleId:            1,
      isTestMessage:     false,
      ...overrides,
    },
  }
}

describe('isAutoResponderPayload', () => {
  it('recognizes the AutoResponder shape (top-level query object)', () => {
    expect(isAutoResponderPayload(makePayload())).toBe(true)
  })

  it('rejects the Meta Cloud API shape', () => {
    const metaPayload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [] } }] }] }
    expect(isAutoResponderPayload(metaPayload)).toBe(false)
  })

  it('rejects null/non-object input', () => {
    expect(isAutoResponderPayload(null)).toBe(false)
    expect(isAutoResponderPayload('not an object')).toBe(false)
    expect(isAutoResponderPayload({})).toBe(false)
  })
})

describe('isValidAutoResponderPackages', () => {
  it('accepts the exact confirmed package names', () => {
    expect(isValidAutoResponderPackages(makePayload())).toBe(true)
  })

  it('rejects a different appPackageName', () => {
    const payload = makePayload()
    payload.appPackageName = 'com.some.other.app'
    expect(isValidAutoResponderPackages(payload)).toBe(false)
  })

  it('rejects a different messengerPackageName (e.g. regular WhatsApp, not Business)', () => {
    const payload = makePayload()
    payload.messengerPackageName = 'com.whatsapp'
    expect(isValidAutoResponderPackages(payload)).toBe(false)
  })
})

describe('isGroupMessage', () => {
  it('detects group messages', () => {
    expect(isGroupMessage(makePayload({ isGroup: true }))).toBe(true)
  })

  it('detects non-group messages', () => {
    expect(isGroupMessage(makePayload({ isGroup: false }))).toBe(false)
  })
})

describe('resolveAutoResponderSender', () => {
  it('normalizes a non-saved-contact sender (raw phone with spaces/hyphen) — physically confirmed format', () => {
    const result = resolveAutoResponderSender('+54 9 2325 47-1890')
    expect(result).toEqual({ resolved: true, phone: '5492325471890' })
  })

  it('does NOT resolve a saved-contact name as a phone (never resolve by name)', () => {
    const result = resolveAutoResponderSender('Jeronimo Cardu')
    expect(result.resolved).toBe(false)
    if (!result.resolved) expect(result.reason).toBe('sender_not_a_phone')
  })

  it('does not resolve an empty sender', () => {
    const result = resolveAutoResponderSender('   ')
    expect(result).toEqual({ resolved: false, reason: 'empty_sender' })
  })

  it('does not resolve a malformed/partial string', () => {
    const result = resolveAutoResponderSender('???')
    expect(result.resolved).toBe(false)
  })

  it('resolves a bare national number the same way normalizePhoneForWhatsApp would', () => {
    const result = resolveAutoResponderSender('2325471890')
    expect(result).toEqual({ resolved: true, phone: '5492325471890' })
  })
})

describe('extractAutoResponderMessage', () => {
  it('extracts sender/message and uses the provided internal event id — never invents a provider message id', () => {
    const payload = makePayload({ sender: '+54 9 2325 47-1890', message: 'Hola, buscaba info' })
    const result  = extractAutoResponderMessage(payload, 'internal-uuid-123')

    expect(result).toEqual({
      from:                 '+54 9 2325 47-1890',
      whatsappMessageId:    'internal-uuid-123',
      messageText:          'Hola, buscaba info',
      messageType:          'text',
      mediaExtract:          null,
      mediaDurationSeconds: null,
      mediaFilename:        null,
      mediaPages:           null,
    })
  })

  it('classifies a voice-message placeholder as audio, with the placeholder text hidden from DeepSeek', () => {
    const payload = makePayload({ sender: '+54 9 2325 47-1890', message: '🎤 Voice message (0:03)' })
    const result  = extractAutoResponderMessage(payload, 'internal-uuid-audio')

    expect(result.messageType).toBe('audio')
    expect(result.mediaDurationSeconds).toBe(3)
    expect(result.messageText).not.toContain('🎤')
  })

  it('classifies a photo placeholder as image', () => {
    const payload = makePayload({ sender: '+54 9 2325 47-1890', message: '📷 Photo' })
    const result  = extractAutoResponderMessage(payload, 'internal-uuid-image')

    expect(result.messageType).toBe('image')
  })

  it('classifies a document placeholder as document, preserving the exact filename', () => {
    const payload = makePayload({ sender: '+54 9 2325 47-1890', message: '📄 JeronimoCarduCV_2026.pdf (2 pages)' })
    const result  = extractAutoResponderMessage(payload, 'internal-uuid-doc')

    expect(result.messageType).toBe('document')
    expect(result.mediaFilename).toBe('JeronimoCarduCV_2026.pdf')
    expect(result.mediaPages).toBe(2)
  })
})

// Mirrors packages/validators/src/phone.test.ts. This file exists separately
// (not shared) because normalizePhoneForWhatsApp itself is intentionally
// duplicated here — the worker does not depend on @orderflow/validators (see
// the comment at the top of ./phone.ts). Keeping both test files in sync
// catches drift between the two copies.
import { describe, expect, it } from 'vitest'
import { normalizePhoneForWhatsApp, isValidARWhatsAppPhone } from './phone'

describe('normalizePhoneForWhatsApp (worker copy)', () => {
  it('leaves an already-canonical 549 number unchanged', () => {
    expect(normalizePhoneForWhatsApp('5492325471890')).toBe('5492325471890')
  })

  it('inserts the missing mobile 9 when the number starts with 54', () => {
    expect(normalizePhoneForWhatsApp('542325471890')).toBe('5492325471890')
  })

  it('strips formatting characters (+, spaces) before normalizing', () => {
    expect(normalizePhoneForWhatsApp('+54 9 2325 471890')).toBe('5492325471890')
  })

  it('removes the trunk prefix (0) and the old 15 mobile prefix', () => {
    expect(normalizePhoneForWhatsApp('02325 15 471890')).toBe('5492325471890')
  })

  it('adds 549 to a bare national number with spaces', () => {
    expect(normalizePhoneForWhatsApp('2325 471890')).toBe('5492325471890')
  })

  it('adds 549 to a bare national number with no spaces', () => {
    expect(normalizePhoneForWhatsApp('2325471890')).toBe('5492325471890')
  })

  it('returns the input unchanged when it contains letters (not a phone)', () => {
    expect(normalizePhoneForWhatsApp('not-a-phone')).toBe('not-a-phone')
  })

  it('returns the input unchanged for empty string', () => {
    expect(normalizePhoneForWhatsApp('')).toBe('')
  })
})

describe('isValidARWhatsAppPhone (worker copy)', () => {
  it('accepts a canonical 549 + 10 digit number', () => {
    expect(isValidARWhatsAppPhone('5492325471890')).toBe(true)
  })

  it('rejects a number missing the mobile 9', () => {
    expect(isValidARWhatsAppPhone('542325471890')).toBe(false)
  })

  it('rejects a non-numeric string (e.g. a saved contact name)', () => {
    expect(isValidARWhatsAppPhone('Jeronimo Cardu')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { isValidARWhatsAppPhone, normalizeEmail, normalizePhoneForWhatsApp } from './phone'

describe('normalizePhoneForWhatsApp', () => {
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

  it('returns the input unchanged when there are no digits at all', () => {
    expect(normalizePhoneForWhatsApp('---')).toBe('---')
  })
})

describe('isValidARWhatsAppPhone', () => {
  it('accepts a canonical 549 + 10 digit number', () => {
    expect(isValidARWhatsAppPhone('5492325471890')).toBe(true)
  })

  it('rejects a number missing the mobile 9', () => {
    expect(isValidARWhatsAppPhone('542325471890')).toBe(false)
  })

  it('rejects a number with too few digits', () => {
    expect(isValidARWhatsAppPhone('54923254718')).toBe(false)
  })

  it('rejects a non-numeric string', () => {
    expect(isValidARWhatsAppPhone('abc')).toBe(false)
  })
})

describe('normalizeEmail', () => {
  it('trims and lowercases a valid email', () => {
    expect(normalizeEmail('  Juan@Example.COM  ')).toBe('juan@example.com')
  })

  it('returns undefined for null', () => {
    expect(normalizeEmail(null)).toBeUndefined()
  })

  it('returns undefined for undefined', () => {
    expect(normalizeEmail(undefined)).toBeUndefined()
  })

  it('returns undefined for an empty/whitespace-only string', () => {
    expect(normalizeEmail('   ')).toBeUndefined()
  })
})

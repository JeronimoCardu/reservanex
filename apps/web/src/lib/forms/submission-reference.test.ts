import { describe, expect, it } from 'vitest'
import {
  SUBMISSION_REFERENCE_REGEX,
  generateSubmissionReference,
  normalizeSubmissionReference,
} from './submission-reference'
import { isSubmissionExpired, SUBMISSION_TTL_MS } from './submissions.repository'

describe('generateSubmissionReference', () => {
  it('always produces the documented format', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateSubmissionReference()).toMatch(SUBMISSION_REFERENCE_REGEX)
    }
  })

  // Alguien va a leer esto de una pantalla y dictarlo por teléfono. O/0 e I/1
  // son indistinguibles en la mayoría de las tipografías.
  it('never emits an ambiguous character', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateSubmissionReference().slice(4)).not.toMatch(/[O0I1]/)
    }
  })

  // No prueba la unicidad (eso lo garantiza el UNIQUE de la DB), sino que el
  // generador no esté degenerado: si devolviera una constante, o tuviera un
  // sesgo grosero, esto lo detecta.
  it('does not repeat itself over a large sample', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(generateSubmissionReference())
    expect(seen.size).toBeGreaterThan(4990)
  })

  it('uses the whole alphabet, not a subset', () => {
    const used = new Set<string>()
    for (let i = 0; i < 5000; i++) {
      for (const ch of generateSubmissionReference().slice(4)) used.add(ch)
    }
    expect(used.size).toBe(32)
  })
})

describe('normalizeSubmissionReference', () => {
  it('accepts a canonical code unchanged', () => {
    expect(normalizeSubmissionReference('SUB-ABC234')).toBe('SUB-ABC234')
  })

  it('forgives the things a person actually types', () => {
    expect(normalizeSubmissionReference('sub-abc234')).toBe('SUB-ABC234')
    expect(normalizeSubmissionReference('  SUB-ABC234  ')).toBe('SUB-ABC234')
    expect(normalizeSubmissionReference('SUB ABC234')).toBe('SUB-ABC234')
    expect(normalizeSubmissionReference('ABC234')).toBe('SUB-ABC234')
    expect(normalizeSubmissionReference('abc234')).toBe('SUB-ABC234')
  })

  it('rejects anything that is not a code', () => {
    expect(normalizeSubmissionReference('SUB-ABC23')).toBeNull()     // corto
    expect(normalizeSubmissionReference('SUB-ABC2345')).toBeNull()   // largo
    expect(normalizeSubmissionReference('SUB-ABC23O')).toBeNull()    // char excluido
    expect(normalizeSubmissionReference('SUB-ABC231')).toBeNull()
    expect(normalizeSubmissionReference('hola')).toBeNull()
    expect(normalizeSubmissionReference('')).toBeNull()
  })

  // Round-trip: todo lo que genera el generador sobrevive la normalización.
  it('round-trips every generated code, even lowercased', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateSubmissionReference()
      expect(normalizeSubmissionReference(code)).toBe(code)
      expect(normalizeSubmissionReference(code.toLowerCase())).toBe(code)
    }
  })
})

// §18 — expiración lazy, con reloj inyectado (nada de esperar 24 horas).
describe('isSubmissionExpired', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z')

  it('treats a fresh submission as alive', () => {
    const expires = new Date(now + SUBMISSION_TTL_MS).toISOString()
    expect(isSubmissionExpired({ expires_at: expires }, now)).toBe(false)
  })

  it('treats a submission past its window as expired', () => {
    const expires = new Date(now - 1).toISOString()
    expect(isSubmissionExpired({ expires_at: expires }, now)).toBe(true)
  })

  it('treats the exact expiry instant as expired, not alive', () => {
    const expires = new Date(now).toISOString()
    expect(isSubmissionExpired({ expires_at: expires }, now)).toBe(true)
  })

  it('uses a 24-hour window', () => {
    expect(SUBMISSION_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})

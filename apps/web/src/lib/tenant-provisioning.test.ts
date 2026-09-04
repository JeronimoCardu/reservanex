import { describe, expect, it } from 'vitest'
import {
  isSafePublicSlug,
  defaultsForCountry,
  DEFAULT_COUNTRY_CODE,
  DEFAULT_WORKSPACE_NAME,
  SUPPORTED_COUNTRIES,
} from './tenant-provisioning'

describe('isSafePublicSlug', () => {
  it('accepts a normal lowercase-kebab slug', () => {
    expect(isSafePublicSlug('inmobiliaria-san-giles')).toBe(true)
  })

  it('rejects slugs shorter than 3 chars', () => {
    expect(isSafePublicSlug('ab')).toBe(false)
  })

  it('rejects uppercase, spaces, and leading/trailing hyphens', () => {
    expect(isSafePublicSlug('San-Giles')).toBe(false)
    expect(isSafePublicSlug('san giles')).toBe(false)
    expect(isSafePublicSlug('-san-giles')).toBe(false)
    expect(isSafePublicSlug('san-giles-')).toBe(false)
  })

  it('rejects reserved words that would collide with app routes', () => {
    for (const reserved of ['dashboard', 'login', 'auth', 'api', 'admin', 'site', 'platform', 'settings', 'properties', 'property']) {
      expect(isSafePublicSlug(reserved)).toBe(false)
    }
  })
})

describe('defaultsForCountry', () => {
  it('returns the matching currency/timezone for a supported country', () => {
    expect(defaultsForCountry('MX')).toEqual({ currency: 'MXN', timezone: 'America/Mexico_City' })
  })

  it('falls back to the default country for an unknown code', () => {
    const fallback = defaultsForCountry(DEFAULT_COUNTRY_CODE)
    expect(defaultsForCountry('XX')).toEqual(fallback)
  })

  it('every supported country resolves to itself, not silently to the fallback', () => {
    for (const c of SUPPORTED_COUNTRIES) {
      expect(defaultsForCountry(c.code)).toEqual({ currency: c.currency, timezone: c.timezone })
    }
  })
})

describe('module constants', () => {
  it('default workspace name is "General"', () => {
    expect(DEFAULT_WORKSPACE_NAME).toBe('General')
  })

  it('default country is Argentina', () => {
    expect(DEFAULT_COUNTRY_CODE).toBe('AR')
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { getSiteUrl, getAuthRedirectTo } from './site-url'

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_SITE_URL

function setSiteUrl(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_SITE_URL
  else process.env.NEXT_PUBLIC_SITE_URL = value
}

beforeEach(() => setSiteUrl(undefined))
afterEach(() => setSiteUrl(ORIGINAL_ENV))

describe('getSiteUrl', () => {
  it('throws a clear, actionable error when NEXT_PUBLIC_SITE_URL is unset — never silently falls back to an empty string or localhost', () => {
    expect(() => getSiteUrl()).toThrow(/NEXT_PUBLIC_SITE_URL/)
  })

  it('returns the development URL as configured', () => {
    setSiteUrl('http://localhost:3001')
    expect(getSiteUrl()).toBe('http://localhost:3001')
  })

  it('returns the production URL as configured', () => {
    setSiteUrl('https://reservanex.com')
    expect(getSiteUrl()).toBe('https://reservanex.com')
  })

  it('strips a trailing slash', () => {
    setSiteUrl('https://reservanex.com/')
    expect(getSiteUrl()).toBe('https://reservanex.com')
  })
})

describe('getAuthRedirectTo', () => {
  it('points at /auth/confirm (the token_hash verification route), not /api/auth/callback (unused PKCE route)', () => {
    setSiteUrl('http://localhost:3001')
    expect(getAuthRedirectTo()).toBe('http://localhost:3001/auth/confirm')
  })

  it('resolves correctly for production', () => {
    setSiteUrl('https://reservanex.com')
    expect(getAuthRedirectTo()).toBe('https://reservanex.com/auth/confirm')
  })

  it('propagates the same throw as getSiteUrl when unset', () => {
    expect(() => getAuthRedirectTo()).toThrow(/NEXT_PUBLIC_SITE_URL/)
  })
})

import { describe, expect, it, afterEach } from 'vitest'
import { getAutoResponderPublicBaseUrl, getAutoResponderEndpoints } from './autoresponder-public-url'

const ORIGINAL = process.env.AUTORESPONDER_PUBLIC_BASE_URL

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AUTORESPONDER_PUBLIC_BASE_URL
  else process.env.AUTORESPONDER_PUBLIC_BASE_URL = ORIGINAL
})

describe('getAutoResponderPublicBaseUrl', () => {
  it('1. returns the configured value when a valid HTTPS URL is set', () => {
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://abc123.ngrok-free.app'
    expect(getAutoResponderPublicBaseUrl()).toBe('https://abc123.ngrok-free.app')
  })

  it('2. missing → throws a clear, actionable error', () => {
    delete process.env.AUTORESPONDER_PUBLIC_BASE_URL
    expect(() => getAutoResponderPublicBaseUrl()).toThrow(/AUTORESPONDER_PUBLIC_BASE_URL/)
  })

  it('3. trailing slash(es) are normalized away', () => {
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://reservanex.com/'
    expect(getAutoResponderPublicBaseUrl()).toBe('https://reservanex.com')
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://reservanex.com///'
    expect(getAutoResponderPublicBaseUrl()).toBe('https://reservanex.com')
  })

  it('4. a non-HTTPS protocol is rejected', () => {
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'http://abc123.ngrok-free.app'
    expect(() => getAutoResponderPublicBaseUrl()).toThrow(/HTTPS/)
  })

  it('4b. a syntactically invalid URL is rejected with a clear error', () => {
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'not a url'
    expect(() => getAutoResponderPublicBaseUrl()).toThrow(/válida/)
  })

  it('5. localhost/127.0.0.1 is never accepted — the Android cannot reach the dev machine', () => {
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://localhost:3001'
    expect(() => getAutoResponderPublicBaseUrl()).toThrow(/localhost/)
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://127.0.0.1:3001'
    expect(() => getAutoResponderPublicBaseUrl()).toThrow(/localhost/)
  })
})

describe('getAutoResponderEndpoints', () => {
  it('16. builds the exact 4 endpoint URLs off the configured base', () => {
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://reservanex.com'
    expect(getAutoResponderEndpoints()).toEqual({
      inbound:     'https://reservanex.com/api/webhooks/autoresponder',
      heartbeat:   'https://reservanex.com/api/webhooks/autoresponder/heartbeat',
    })
  })

  it('propagates the same clear error when the base URL is unset', () => {
    delete process.env.AUTORESPONDER_PUBLIC_BASE_URL
    expect(() => getAutoResponderEndpoints()).toThrow(/AUTORESPONDER_PUBLIC_BASE_URL/)
  })
})

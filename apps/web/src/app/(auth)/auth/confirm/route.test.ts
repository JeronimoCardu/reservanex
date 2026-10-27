import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))

import { createClient } from '@orderflow/supabase/server'
import { GET } from './route'

// What the route gets in production behind Hostinger's proxy
// (PROD-HOSTINGER-D2): request.url carries the standalone server's bind
// address, and the public host only travels in the proxy headers.
const CONFIRM_URL = 'http://0.0.0.0:3000/auth/confirm'
const PROXY_HEADERS = {
  host:                'reservanex.com',
  'x-forwarded-host':  'reservanex.com',
  'x-forwarded-proto': 'https',
  'x-forwarded-port':  '443',
  'x-forwarded-for':   '203.0.113.7',
}

function buildRequest(params: Record<string, string>, base = CONFIRM_URL): NextRequest {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url, { headers: PROXY_HEADERS })
}

// Mirrors the heartbeat route test's approach of mocking the whole Supabase
// client module rather than next/headers internals.
function mockVerifyOtp(error: { code?: string; message: string; status?: number } | null) {
  const verifyOtp = vi.fn().mockResolvedValue({ error })
  vi.mocked(createClient).mockResolvedValue({ auth: { verifyOtp } } as never)
  return verifyOtp
}

// The Location must be a path on this site, exactly: never an absolute URL,
// never the bind address, never a host read from the request.
function expectLocalRedirect(res: Response, path: string) {
  const location = res.headers.get('location')
  expect(res.status).toBe(307)
  expect(location).toBe(path)
  expect(location).toMatch(/^\/(?![/\\])/)
  expect(location).not.toContain('0.0.0.0')
  expect(location).not.toContain('reservanex.com')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /auth/confirm (Fase 8 — invite flow fix)', () => {
  it('missing token_hash → redirects to the error page without calling Supabase', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ type: 'invite' }))
    expectLocalRedirect(res, '/auth/confirm-email?error=invalid_link')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('missing type → redirects to the error page without calling Supabase', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'abc123' }))
    expectLocalRedirect(res, '/auth/confirm-email?error=invalid_link')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('a type outside the allowed set → redirects to the error page without calling Supabase', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'abc123', type: 'oauth' }))
    expectLocalRedirect(res, '/auth/confirm-email?error=invalid_link')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('a valid invite token verifies with the exact params and lands on /auth/accept-invite (set password)', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'real-hash', type: 'invite' }))
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'real-hash', type: 'invite' })
    expectLocalRedirect(res, '/auth/accept-invite')
  })

  it('a valid recovery token lands on /auth/reset-password', async () => {
    mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'real-hash', type: 'recovery' }))
    expectLocalRedirect(res, '/auth/reset-password')
  })

  // type=email is the email change confirmation (see the route's mapping).
  it.each(['magiclink', 'signup', 'email'])('a valid %s token lands on /dashboard', async (type) => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'real-hash', type }))
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'real-hash', type })
    expectLocalRedirect(res, '/dashboard')
  })

  it('an expired token fails cleanly — redirected to the error page, not a crash', async () => {
    mockVerifyOtp({ code: 'otp_expired', message: 'Token has expired', status: 403 })
    const res = await GET(buildRequest({ token_hash: 'stale-hash', type: 'invite' }))
    expectLocalRedirect(res, '/auth/confirm-email?error=invalid_link') // a redirect, not a 500
  })

  it('a reused (already-consumed) token fails the same clean way — no special-cased behavior that could leak which failure occurred', async () => {
    mockVerifyOtp({ code: 'otp_expired', message: 'Token has already been used', status: 403 })
    const res = await GET(buildRequest({ token_hash: 'used-hash', type: 'invite' }))
    expectLocalRedirect(res, '/auth/confirm-email?error=invalid_link')
  })

  it('never echoes the token_hash or any Supabase error detail back into the redirect URL', async () => {
    mockVerifyOtp({ code: 'otp_expired', message: 'Token has expired', status: 403 })
    const res = await GET(buildRequest({ token_hash: 'super-secret-hash-value', type: 'invite' }))
    const location = res.headers.get('location') ?? ''
    expect(location).not.toContain('super-secret-hash-value')
    expect(location).not.toContain('otp_expired')
  })
})

describe('GET /auth/confirm behind a proxy (PROD-HOSTINGER-D3)', () => {
  it('no params at all — the production probe that got https://0.0.0.0:3000 — stays on this site', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({}))
    expectLocalRedirect(res, '/auth/confirm-email?error=invalid_link')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('the Location does not depend on the origin request.url carries', async () => {
    mockVerifyOtp(null)
    const bases = [
      'http://0.0.0.0:3000/auth/confirm',
      'https://0.0.0.0:3000/auth/confirm',
      'http://localhost:3001/auth/confirm',
      'https://example.hostingersite.com/auth/confirm',
      'https://example.vercel.app/auth/confirm',
    ]
    for (const base of bases) {
      expectLocalRedirect(await GET(buildRequest({}, base)), '/auth/confirm-email?error=invalid_link')
      expectLocalRedirect(await GET(buildRequest({ token_hash: 'real-hash', type: 'invite' }, base)), '/auth/accept-invite')
    }
  })
})

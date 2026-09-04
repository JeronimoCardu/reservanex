import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))

import { createClient } from '@orderflow/supabase/server'
import { GET } from './route'

const CONFIRM_URL = 'http://127.0.0.1/auth/confirm'

function buildRequest(params: Record<string, string>): NextRequest {
  const url = new URL(CONFIRM_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url)
}

// Mirrors the heartbeat route test's approach of mocking the whole Supabase
// client module rather than next/headers internals.
function mockVerifyOtp(error: { code?: string; message: string; status?: number } | null) {
  const verifyOtp = vi.fn().mockResolvedValue({ error })
  vi.mocked(createClient).mockResolvedValue({ auth: { verifyOtp } } as never)
  return verifyOtp
}

function redirectPath(res: Response): string {
  const location = res.headers.get('location') ?? ''
  return new URL(location).pathname + new URL(location).search
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /auth/confirm (Fase 8 — invite flow fix)', () => {
  it('missing token_hash → redirects to the error page without calling Supabase', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ type: 'invite' }))
    expect(redirectPath(res)).toBe('/auth/confirm-email?error=invalid_link')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('missing type → redirects to the error page without calling Supabase', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'abc123' }))
    expect(redirectPath(res)).toBe('/auth/confirm-email?error=invalid_link')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('a type outside the allowed set → redirects to the error page without calling Supabase', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'abc123', type: 'oauth' }))
    expect(redirectPath(res)).toBe('/auth/confirm-email?error=invalid_link')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('a valid invite token verifies with the exact params and lands on /auth/accept-invite (set password)', async () => {
    const verifyOtp = mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'real-hash', type: 'invite' }))
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'real-hash', type: 'invite' })
    expect(redirectPath(res)).toBe('/auth/accept-invite')
  })

  it('a valid recovery token lands on /auth/reset-password', async () => {
    mockVerifyOtp(null)
    const res = await GET(buildRequest({ token_hash: 'real-hash', type: 'recovery' }))
    expect(redirectPath(res)).toBe('/auth/reset-password')
  })

  it('a valid magiclink/signup/email token lands on /dashboard', async () => {
    mockVerifyOtp(null)
    for (const type of ['magiclink', 'signup', 'email']) {
      const res = await GET(buildRequest({ token_hash: 'real-hash', type }))
      expect(redirectPath(res)).toBe('/dashboard')
    }
  })

  it('an expired token fails cleanly — redirected to the error page, not a crash', async () => {
    mockVerifyOtp({ code: 'otp_expired', message: 'Token has expired', status: 403 })
    const res = await GET(buildRequest({ token_hash: 'stale-hash', type: 'invite' }))
    expect(res.status).toBe(307) // redirect, not a 500
    expect(redirectPath(res)).toBe('/auth/confirm-email?error=invalid_link')
  })

  it('a reused (already-consumed) token fails the same clean way — no special-cased behavior that could leak which failure occurred', async () => {
    mockVerifyOtp({ code: 'otp_expired', message: 'Token has already been used', status: 403 })
    const res = await GET(buildRequest({ token_hash: 'used-hash', type: 'invite' }))
    expect(redirectPath(res)).toBe('/auth/confirm-email?error=invalid_link')
  })

  it('never echoes the token_hash or any Supabase error detail back into the redirect URL', async () => {
    mockVerifyOtp({ code: 'otp_expired', message: 'Token has expired', status: 403 })
    const res = await GET(buildRequest({ token_hash: 'super-secret-hash-value', type: 'invite' }))
    const location = res.headers.get('location') ?? ''
    expect(location).not.toContain('super-secret-hash-value')
    expect(location).not.toContain('otp_expired')
  })
})

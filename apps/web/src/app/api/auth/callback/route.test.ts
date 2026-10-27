import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))

import { createClient } from '@orderflow/supabase/server'
import { GET } from './route'

// Same setup as /auth/confirm's test: request.url as Hostinger's proxy
// delivers it, with the public host only in the proxy headers.
const CALLBACK_URL = 'http://0.0.0.0:3000/api/auth/callback'
const PROXY_HEADERS = {
  host:                'reservanex.com',
  'x-forwarded-host':  'reservanex.com',
  'x-forwarded-proto': 'https',
  'x-forwarded-port':  '443',
  'x-forwarded-for':   '203.0.113.7',
}

function buildRequest(params: Record<string, string>): NextRequest {
  const url = new URL(CALLBACK_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url, { headers: PROXY_HEADERS })
}

function mockExchange(error: { code?: string; message: string; status?: number } | null) {
  const exchangeCodeForSession = vi.fn().mockResolvedValue({ error })
  vi.mocked(createClient).mockResolvedValue({ auth: { exchangeCodeForSession } } as never)
  return exchangeCodeForSession
}

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

describe('GET /api/auth/callback (PKCE, unused today) behind a proxy', () => {
  it('missing code → redirects to the error page without calling Supabase', async () => {
    const exchange = mockExchange(null)
    const res = await GET(buildRequest({ type: 'invite' }))
    expectLocalRedirect(res, '/auth/confirm-email?error=invalid_link')
    expect(exchange).not.toHaveBeenCalled()
  })

  it('a failed exchange → redirects to the error page', async () => {
    mockExchange({ code: 'bad_code_verifier', message: 'invalid flow state', status: 400 })
    const res = await GET(buildRequest({ code: 'pkce-code', type: 'invite' }))
    expectLocalRedirect(res, '/auth/confirm-email?error=invalid_link')
  })

  it('type=invite exchanges the exact code and lands on /auth/accept-invite', async () => {
    const exchange = mockExchange(null)
    const res = await GET(buildRequest({ code: 'pkce-code', type: 'invite' }))
    expect(exchange).toHaveBeenCalledWith('pkce-code')
    expectLocalRedirect(res, '/auth/accept-invite')
  })

  it('type=recovery lands on /auth/reset-password', async () => {
    mockExchange(null)
    const res = await GET(buildRequest({ code: 'pkce-code', type: 'recovery' }))
    expectLocalRedirect(res, '/auth/reset-password')
  })

  it('no type lands on /dashboard', async () => {
    mockExchange(null)
    const res = await GET(buildRequest({ code: 'pkce-code' }))
    expectLocalRedirect(res, '/dashboard')
  })

  it('never echoes the code into the redirect', async () => {
    mockExchange({ code: 'bad_code_verifier', message: 'invalid flow state', status: 400 })
    const res = await GET(buildRequest({ code: 'super-secret-code-value' }))
    expect(res.headers.get('location')).not.toContain('super-secret-code-value')
  })
})

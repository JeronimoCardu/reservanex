import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@orderflow/supabase/admin', () => ({ createAdminClient: vi.fn() }))

import { createAdminClient } from '@orderflow/supabase/admin'
import { POST } from './route'

const HEARTBEAT_URL = 'http://127.0.0.1/api/webhooks/autoresponder/heartbeat'

function buildRequest(token?: string | null): NextRequest {
  const headers = new Headers()
  if (token !== null) headers.set('x-reservanex-device-token', token ?? '')
  return new NextRequest(HEARTBEAT_URL, { method: 'POST', headers })
}

// Records exactly which account id the UPDATE targeted, so tests can assert
// isolation ("heartbeat never touches another account/tenant").
function mockAdminClient(opts: {
  account: { id: string; active: boolean } | null
  lookupError?: { code: string; message: string } | null
  updateError?: { code: string; message: string } | null
}) {
  const updateCalls: { table: string; payload: unknown; matchedId: string | null }[] = []
  let capturedId: string | null = null

  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: opts.account, error: opts.lookupError ?? null }),
          }),
        }),
      }),
      update: (payload: unknown) => ({
        eq: (_col: string, id: string) => {
          capturedId = id
          updateCalls.push({ table, payload, matchedId: id })
          return Promise.resolve({ data: null, error: opts.updateError ?? null })
        },
      }),
    }),
  } as never)

  return { updateCalls, getCapturedId: () => capturedId }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/webhooks/autoresponder/heartbeat (Fase 7 Parte A)', () => {
  it('1. no token → 401', async () => {
    mockAdminClient({ account: null })
    const res = await POST(buildRequest(null))
    expect(res.status).toBe(401)
  })

  it('1b. empty/whitespace token → 401', async () => {
    mockAdminClient({ account: null })
    const res = await POST(buildRequest('   '))
    expect(res.status).toBe(401)
  })

  it('2. incorrect token (no matching account) → 401', async () => {
    mockAdminClient({ account: null })
    const res = await POST(buildRequest('wrong-token'))
    expect(res.status).toBe(401)
  })

  it('3/4. inactive account → 401 (rejected, never updated)', async () => {
    const { updateCalls } = mockAdminClient({ account: { id: 'acc-1', active: false } })
    const res = await POST(buildRequest('real-token'))
    expect(res.status).toBe(401)
    expect(updateCalls).toHaveLength(0)
  })

  it('6. valid token → 200 {ok:true}, updates only that account', async () => {
    const { updateCalls, getCapturedId } = mockAdminClient({ account: { id: 'acc-42', active: true } })
    const res = await POST(buildRequest('real-token'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    expect(updateCalls).toHaveLength(1)
    expect(getCapturedId()).toBe('acc-42')
  })

  it('7. never accepts an account id from the request — resolution is entirely via the token hash lookup', async () => {
    // Body/query params are never read by the route at all (no JSON parsing,
    // no searchParams access) — a request carrying an account_id has no
    // effect; the mocked account below is what the (mocked) token hash
    // lookup resolves to, proving the account comes only from that path.
    const { getCapturedId } = mockAdminClient({ account: { id: 'acc-from-token-only', active: true } })
    const req = new NextRequest(`${HEARTBEAT_URL}?account_id=acc-attacker-supplied`, {
      method: 'POST',
      headers: { 'x-reservanex-device-token': 'real-token' },
    })
    await POST(req)
    expect(getCapturedId()).toBe('acc-from-token-only')
  })

  it('8. response never contains secrets — only {ok:true} on success, {error} on failure', async () => {
    mockAdminClient({ account: { id: 'acc-1', active: true } })
    const res = await POST(buildRequest('real-token'))
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['ok'])
    expect(JSON.stringify(body)).not.toMatch(/token|hash|webhook|secret/i)
  })

  it('a lookup error is treated as an auth failure, never a 500 that could leak internals', async () => {
    mockAdminClient({ account: null, lookupError: { code: '500', message: 'connection reset' } })
    const res = await POST(buildRequest('real-token'))
    expect(res.status).toBe(401)
  })
})

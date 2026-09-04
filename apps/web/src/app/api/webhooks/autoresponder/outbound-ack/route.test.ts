import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@orderflow/supabase/admin', () => ({ createAdminClient: vi.fn() }))

import { createAdminClient } from '@orderflow/supabase/admin'
import { POST } from './route'

const ACK_URL = 'http://127.0.0.1/api/webhooks/autoresponder/outbound-ack'
const VALID_OUTBOX_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_OUTBOX_ID = '99999999-8888-4777-8666-555555555555'

function buildRequest(headers: { token?: string | null; outboxId?: string | null }): NextRequest {
  const h = new Headers()
  if (headers.token !== null)    h.set('x-reservanex-device-token', headers.token ?? '')
  if (headers.outboxId !== null) h.set('x-reservanex-outbox-id', headers.outboxId ?? '')
  return new NextRequest(ACK_URL, { method: 'POST', headers: h })
}

// Mirrors heartbeat/route.test.ts and media/route.test.ts's approach —
// mocks the whole admin client, records exactly which id/payload each call
// targeted so tests can assert ownership/idempotency precisely.
function mockAdminClient(opts: {
  account:      { id: string; tenant_id: string; active: boolean } | null
  outboxItem:   { id: string; account_id: string; dispatched_at: string | null; device_ack_at: string | null } | null
  acctLookupError?: { code: string } | null
}) {
  const outboxUpdateCalls: { payload: unknown; matchedId: string | null; matchedAccountId: string | null; ackWasNull: boolean }[] = []
  const accountUpdateCalls: { payload: unknown; matchedId: string | null }[] = []

  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => {
      if (table === 'whatsapp_accounts') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: opts.account, error: opts.acctLookupError ?? null }),
              }),
            }),
          }),
          update: (payload: unknown) => ({
            eq: (_col: string, id: string) => {
              accountUpdateCalls.push({ payload, matchedId: id })
              return Promise.resolve({ data: null, error: null })
            },
          }),
        }
      }
      // messaging_outbox
      return {
        select: () => ({
          eq: (_c1: string, matchedId: string) => ({
            eq: (_c2: string, matchedAccountId: string) => ({
              maybeSingle: () => {
                const matches = opts.outboxItem
                  && opts.outboxItem.id === matchedId
                  && opts.outboxItem.account_id === matchedAccountId
                return Promise.resolve({ data: matches ? opts.outboxItem : null, error: null })
              },
            }),
          }),
        }),
        update: (payload: { device_ack_at: string }) => ({
          eq: (_c1: string, matchedId: string) => ({
            eq: (_c2: string, matchedAccountId: string) => ({
              is: (_c3: string, _val: null) => ({
                select: () => ({
                  maybeSingle: () => {
                    const ackWasNull = opts.outboxItem?.device_ack_at == null
                    outboxUpdateCalls.push({ payload, matchedId, matchedAccountId, ackWasNull })
                    // The real query only "wins" (returns a row) when
                    // device_ack_at IS NULL — mirror that here.
                    return Promise.resolve({ data: ackWasNull ? { id: matchedId } : null, error: null })
                  },
                }),
              }),
            }),
          }),
        }),
      }
    },
  } as never)

  return { outboxUpdateCalls, accountUpdateCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/webhooks/autoresponder/outbound-ack (Fase 8)', () => {
  it('1. missing token → 401', async () => {
    mockAdminClient({ account: null, outboxItem: null })
    const res = await POST(buildRequest({ token: null, outboxId: VALID_OUTBOX_ID }))
    expect(res.status).toBe(401)
  })

  it('2. invalid/unrecognized token → 401', async () => {
    mockAdminClient({ account: null, outboxItem: null })
    const res = await POST(buildRequest({ token: 'wrong-token', outboxId: VALID_OUTBOX_ID }))
    expect(res.status).toBe(401)
  })

  it('3. missing outbox id → 400', async () => {
    mockAdminClient({ account: null, outboxItem: null })
    const res = await POST(buildRequest({ token: 'real-token', outboxId: null }))
    expect(res.status).toBe(400)
  })

  it('4. invalid (non-UUID) outbox id → 400, before any DB call', async () => {
    const { outboxUpdateCalls } = mockAdminClient({ account: null, outboxItem: null })
    const res = await POST(buildRequest({ token: 'real-token', outboxId: 'not-a-uuid' }))
    expect(res.status).toBe(400)
    expect(outboxUpdateCalls).toHaveLength(0)
  })

  it('5. nonexistent outbox id (valid UUID, no matching row) → safe failure, no leak', async () => {
    mockAdminClient({
      account: { id: 'acc-1', tenant_id: 'tenant-1', active: true },
      outboxItem: null,
    })
    const res = await POST(buildRequest({ token: 'real-token', outboxId: VALID_OUTBOX_ID }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/tenant|account_id/i)
  })

  it('6. cross-account: a valid token for account A cannot ACK an outbox item belonging to account B — same response as nonexistent', async () => {
    mockAdminClient({
      account: { id: 'acc-A', tenant_id: 'tenant-A', active: true },
      // Item exists, but for a DIFFERENT account — the mock's lookup only
      // matches when BOTH id and account_id agree, exactly like the real
      // .eq('id',...).eq('account_id',...) query.
      outboxItem: { id: VALID_OUTBOX_ID, account_id: 'acc-B', dispatched_at: new Date().toISOString(), device_ack_at: null },
    })
    const res = await POST(buildRequest({ token: 'real-token', outboxId: VALID_OUTBOX_ID }))
    expect(res.status).toBe(404)
  })

  it('outbox exists for this account but was never dispatched → 409, not accepted as a valid ACK', async () => {
    mockAdminClient({
      account: { id: 'acc-1', tenant_id: 'tenant-1', active: true },
      outboxItem: { id: VALID_OUTBOX_ID, account_id: 'acc-1', dispatched_at: null, device_ack_at: null },
    })
    const res = await POST(buildRequest({ token: 'real-token', outboxId: VALID_OUTBOX_ID }))
    expect(res.status).toBe(409)
  })

  it('7. a valid dispatched outbox → 200, device_ack_at gets set', async () => {
    const { outboxUpdateCalls } = mockAdminClient({
      account: { id: 'acc-1', tenant_id: 'tenant-1', active: true },
      outboxItem: { id: VALID_OUTBOX_ID, account_id: 'acc-1', dispatched_at: new Date().toISOString(), device_ack_at: null },
    })
    const res = await POST(buildRequest({ token: 'real-token', outboxId: VALID_OUTBOX_ID }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    expect(outboxUpdateCalls).toHaveLength(1)
    expect(outboxUpdateCalls[0]?.matchedId).toBe(VALID_OUTBOX_ID)
    expect(outboxUpdateCalls[0]?.matchedAccountId).toBe('acc-1')
  })

  it('8. a second ACK on an already-acked item → still 200, but the conditional update never fires (first timestamp preserved)', async () => {
    const alreadyAckedAt = new Date(Date.now() - 60_000).toISOString()
    const { accountUpdateCalls } = mockAdminClient({
      account: { id: 'acc-1', tenant_id: 'tenant-1', active: true },
      outboxItem: { id: VALID_OUTBOX_ID, account_id: 'acc-1', dispatched_at: new Date().toISOString(), device_ack_at: alreadyAckedAt },
    })
    const res = await POST(buildRequest({ token: 'real-token', outboxId: VALID_OUTBOX_ID }))
    expect(res.status).toBe(200)
    // Repeat ACK still updates last_device_seen_at (real evidence of life)
    // but never last_outbound_device_ack_at (only set on the FIRST ack).
    expect(accountUpdateCalls[0]?.payload).toMatchObject({ last_device_seen_at: expect.any(String) })
    expect(accountUpdateCalls[0]?.payload).not.toHaveProperty('last_outbound_device_ack_at')
  })

  it('9. a valid ACK updates whatsapp_accounts.last_device_seen_at', async () => {
    const { accountUpdateCalls } = mockAdminClient({
      account: { id: 'acc-1', tenant_id: 'tenant-1', active: true },
      outboxItem: { id: VALID_OUTBOX_ID, account_id: 'acc-1', dispatched_at: new Date().toISOString(), device_ack_at: null },
    })
    await POST(buildRequest({ token: 'real-token', outboxId: VALID_OUTBOX_ID }))
    expect(accountUpdateCalls).toHaveLength(1)
    expect(accountUpdateCalls[0]?.matchedId).toBe('acc-1')
    expect(accountUpdateCalls[0]?.payload).toMatchObject({
      last_device_seen_at:         expect.any(String),
      last_outbound_device_ack_at: expect.any(String),
    })
  })

  it('never leaks the device token, tenant id, or any secret in the response body', async () => {
    mockAdminClient({
      account: { id: 'acc-1', tenant_id: 'tenant-1', active: true },
      outboxItem: { id: VALID_OUTBOX_ID, account_id: 'acc-1', dispatched_at: new Date().toISOString(), device_ack_at: null },
    })
    const res = await POST(buildRequest({ token: 'super-secret-device-token', outboxId: VALID_OUTBOX_ID }))
    const body = await res.json()
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('super-secret-device-token')
    expect(serialized).not.toMatch(/tenant-1/)
  })

  it('resolves the account entirely from the token — a different outbox id in the same request never changes which account is authenticated', async () => {
    const { accountUpdateCalls } = mockAdminClient({
      account: { id: 'acc-fixed', tenant_id: 'tenant-1', active: true },
      outboxItem: { id: OTHER_OUTBOX_ID, account_id: 'acc-fixed', dispatched_at: new Date().toISOString(), device_ack_at: null },
    })
    await POST(buildRequest({ token: 'real-token', outboxId: OTHER_OUTBOX_ID }))
    expect(accountUpdateCalls[0]?.matchedId).toBe('acc-fixed')
  })
})

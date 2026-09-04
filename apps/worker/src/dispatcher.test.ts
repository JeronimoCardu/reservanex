// Fase 8 physical E2E follow-up — a real dispatch failure (network_error)
// left no clearly-visible '[dispatcher] failed' line in the worker's output
// during a live test. These tests mock the DB/HTTP boundary and assert the
// consolidated markOutboxFailed() path (dispatcher.ts) reliably produces
// exactly one '[dispatcher] failed' log for every post-claim failure branch,
// with the exact shape { outboxId, accountId, error, networkCode? } and no
// secrets — never relying on a physical MacroDroid callback or a real DB.
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./lib/supabase', () => ({ createClient: vi.fn() }))
vi.mock('./providers/autoresponder/outbound', () => ({ dispatchToMacroDroid: vi.fn() }))

import { createClient } from './lib/supabase'
import { dispatchToMacroDroid } from './providers/autoresponder/outbound'
import { runDispatchTick } from './dispatcher'

const ITEM = {
  id: 'outbox-1', account_id: 'acct-1', conversation_id: 'conv-1', message_id: 'msg-1',
  tenant_id: 'tenant-1', destination_phone: '5491100000000', text: 'hola',
  provider: 'autoresponder', source: 'human', status: 'processing', error: null,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  dispatched_at: null, device_ack_at: null,
} as const

function buildMockSupabase(opts: {
  account: { macrodroid_webhook_url: string | null; active: boolean } | null
}) {
  let claimCalls = 0
  const outboxUpdates:  { payload: unknown; id: string }[] = []
  const accountUpdates: { payload: unknown; id: string }[] = []

  const client = {
    rpc: (_fn: string, _args: unknown) => {
      claimCalls++
      // Only the FIRST claim in a tick returns the item — every subsequent
      // call (same tick, or a re-run) returns empty, so runDispatchTick's
      // loop naturally stops after exactly one dispatch attempt.
      return Promise.resolve({ data: claimCalls === 1 ? [ITEM] : [], error: null })
    },
    from: (table: string) => {
      if (table === 'whatsapp_accounts') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.account, error: null }) }) }),
          update: (payload: unknown) => ({
            eq: (_c: string, id: string) => { accountUpdates.push({ payload, id }); return Promise.resolve({ data: null, error: null }) },
          }),
        }
      }
      // messaging_outbox
      return {
        update: (payload: unknown) => ({
          eq: (_c: string, id: string) => { outboxUpdates.push({ payload, id }); return Promise.resolve({ data: null, error: null }) },
        }),
      }
    },
  }

  return { client, outboxUpdates, accountUpdates }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dispatcher.ts — consolidated "[dispatcher] failed" logging', () => {
  it('a network_error result produces exactly one "[dispatcher] failed" log with outboxId, accountId, error and the sanitized networkCode', async () => {
    const { client, outboxUpdates } = buildMockSupabase({ account: { macrodroid_webhook_url: 'https://trigger.macrodroid.com/x', active: true } })
    vi.mocked(createClient).mockReturnValue(client as never)
    vi.mocked(dispatchToMacroDroid).mockResolvedValue({ status: 'failed', error: 'network_error', networkCode: 'ENOTFOUND' })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runDispatchTick()
    // Read the recorded calls BEFORE mockRestore() — mockRestore() clears
    // .mock.calls (it's mockReset() + restoring the original), so reading
    // it after would always see an empty array.
    const failedCalls = errSpy.mock.calls.filter((c) => c[0] === '[dispatcher] failed')
    errSpy.mockRestore()

    expect(outboxUpdates).toHaveLength(1)
    expect(outboxUpdates[0]!.payload).toMatchObject({ status: 'failed', error: 'network_error' })

    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0]![1]).toEqual({
      outboxId: 'outbox-1', accountId: 'acct-1', error: 'network_error', networkCode: 'ENOTFOUND',
    })
  })

  it('when networkCode is absent (e.g. http_503, timeout, unexpected_response), the log omits the key entirely rather than logging undefined', async () => {
    const { client } = buildMockSupabase({ account: { macrodroid_webhook_url: 'https://trigger.macrodroid.com/x', active: true } })
    vi.mocked(createClient).mockReturnValue(client as never)
    vi.mocked(dispatchToMacroDroid).mockResolvedValue({ status: 'failed', error: 'http_503' })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runDispatchTick()
    const failedCall = errSpy.mock.calls.find((c) => c[0] === '[dispatcher] failed')
    errSpy.mockRestore()

    expect(failedCall).toBeTruthy()
    expect(failedCall![1]).toEqual({ outboxId: 'outbox-1', accountId: 'acct-1', error: 'http_503' })
    expect('networkCode' in (failedCall![1] as object)).toBe(false)
  })

  it('an account that is inactive/missing its webhook URL ALSO funnels through the same "[dispatcher] failed" log — no separate/bespoke line', async () => {
    const { client, outboxUpdates } = buildMockSupabase({ account: { macrodroid_webhook_url: null, active: true } })
    vi.mocked(createClient).mockReturnValue(client as never)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runDispatchTick()
    const failedCalls = errSpy.mock.calls.filter((c) => c[0] === '[dispatcher] failed')
    errSpy.mockRestore()

    expect(dispatchToMacroDroid).not.toHaveBeenCalled()
    expect(outboxUpdates[0]!.payload).toMatchObject({ status: 'failed', error: 'account_misconfigured' })

    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0]![1]).toEqual({ outboxId: 'outbox-1', accountId: 'acct-1', error: 'account_misconfigured' })
  })

  it('a successful dispatch never logs "[dispatcher] failed" — only "[dispatcher] dispatched"', async () => {
    const { client } = buildMockSupabase({ account: { macrodroid_webhook_url: 'https://trigger.macrodroid.com/x', active: true } })
    vi.mocked(createClient).mockReturnValue(client as never)
    vi.mocked(dispatchToMacroDroid).mockResolvedValue({ status: 'dispatched' })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runDispatchTick()
    const hadFailedLog      = errSpy.mock.calls.some((c) => c[0] === '[dispatcher] failed')
    const hadDispatchedLog  = logSpy.mock.calls.some((c) => c[0] === '[dispatcher] dispatched')
    errSpy.mockRestore()
    logSpy.mockRestore()

    expect(hadFailedLog).toBe(false)
    expect(hadDispatchedLog).toBe(true)
  })

  it('the "[dispatcher] failed" log never contains a URL, hostname, or anything token-shaped, even when the underlying error result carries one by mistake', async () => {
    const { client } = buildMockSupabase({ account: { macrodroid_webhook_url: 'https://trigger.macrodroid.com/x', active: true } })
    vi.mocked(createClient).mockReturnValue(client as never)
    // Only the fixed, sanitized error/networkCode vocabulary should ever be
    // forwarded — dispatcher.ts must never accept/forward arbitrary fields.
    vi.mocked(dispatchToMacroDroid).mockResolvedValue({ status: 'failed', error: 'network_error', networkCode: 'ECONNREFUSED' })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runDispatchTick()
    const failedCall = errSpy.mock.calls.find((c) => c[0] === '[dispatcher] failed')
    errSpy.mockRestore()

    const serialized = JSON.stringify(failedCall![1])
    expect(serialized).not.toMatch(/https?:\/\//)
    expect(serialized).not.toContain('trigger.macrodroid.com')
  })
})

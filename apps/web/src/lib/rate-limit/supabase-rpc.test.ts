import { describe, expect, it, vi } from 'vitest'

vi.mock('@orderflow/supabase/admin', () => ({ createAdminClient: vi.fn() }))

import { createAdminClient } from '@orderflow/supabase/admin'
import type { RateLimitRpcBucket } from './limiter'
import { supabaseRateLimitRpc, type RateLimitRpcClient } from './supabase-rpc'

const BUCKETS: RateLimitRpcBucket[] = [{ bucket_key: `rl1.ip.${'a'.repeat(43)}`, window_seconds: 600, limit: 3 }]

function fakeClient() {
  const abortSignal = vi.fn().mockResolvedValue({ data: { allowed: true, retry_after_seconds: 0 }, error: null })
  const rpc = vi.fn().mockReturnValue({ abortSignal })
  return { client: { rpc } as unknown as RateLimitRpcClient, rpc, abortSignal }
}

describe('supabaseRateLimitRpc', () => {
  it('llama a rate_limit_hit con p_buckets y le pasa el signal al request', async () => {
    const { client, rpc, abortSignal } = fakeClient()
    const signal = new AbortController().signal

    const result = await supabaseRateLimitRpc(client)(BUCKETS, signal)

    expect(rpc).toHaveBeenCalledWith('rate_limit_hit', { p_buckets: BUCKETS })
    expect(abortSignal).toHaveBeenCalledWith(signal)
    expect(result).toEqual({ data: { allowed: true, retry_after_seconds: 0 }, error: null })
  })

  it('sin cliente explícito usa el admin client (service_role)', () => {
    const { client } = fakeClient()
    vi.mocked(createAdminClient).mockReturnValue(client as never)
    supabaseRateLimitRpc()
    expect(createAdminClient).toHaveBeenCalledTimes(1)
  })
})

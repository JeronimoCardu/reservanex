// MVP P0-A — claim del poller y falla terminal. La exclusión de AutoResponder
// y la atomicidad viven en la RPC claim_next_pollable_message_queue_item (la
// prueba contra la base real es apps/web/scripts/validate-autoresponder-stability.ts).
// Acá: que el poller use SOLO esa RPC —nunca el SELECT "pendiente más vieja"
// sin filtro de antes— y que una falla terminal no vuelva a 'pending'.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ kind: 'rpc' | 'from'; name: string; op?: string; payload?: unknown }>,
  rpcResult: { data: null as unknown, error: null as unknown },
  attempts: 0,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (name: string) => {
      sdk.calls.push({ kind: 'rpc', name })
      return Promise.resolve(sdk.rpcResult)
    },
    from: (table: string) => {
      const entry: { kind: 'from'; name: string; op?: string; payload?: unknown } = { kind: 'from', name: table, op: 'select' }
      sdk.calls.push(entry)
      const c: Record<string, unknown> = {}
      Object.assign(c, {
        select: () => c,
        update: (payload: unknown) => { entry.op = 'update'; entry.payload = payload; return c },
        eq: () => c,
        lt: () => c,
        single: () => Promise.resolve({ data: { attempts: sdk.attempts }, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res),
      })
      return c
    },
  }),
}))

process.env.SUPABASE_URL = 'https://example.invalid'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-for-tests'

const { claimQueueItem, failQueueItem } = await import('./supabase')

beforeEach(() => {
  sdk.calls.length = 0
  sdk.rpcResult = { data: null, error: null }
  sdk.attempts = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('claimQueueItem (poller genérico)', () => {
  it('reclama SOLO por la RPC atómica que excluye AutoResponder — ningún SELECT/UPDATE directo sobre message_queue', async () => {
    const row = { id: 'meta-row', status: 'processing' }
    sdk.rpcResult = { data: [row], error: null }

    expect(await claimQueueItem()).toEqual(row)
    expect(sdk.calls).toEqual([{ kind: 'rpc', name: 'claim_next_pollable_message_queue_item' }])
  })

  it('nada pollable (p. ej. sólo filas AutoResponder pendientes) → null', async () => {
    sdk.rpcResult = { data: [], error: null }
    expect(await claimQueueItem()).toBeNull()
  })

  it('error de la RPC → null, logueado', async () => {
    sdk.rpcResult = { data: null, error: { code: 'XX000', message: 'boom' } }
    expect(await claimQueueItem()).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })
})

describe('failQueueItem', () => {
  const lastUpdate = () => sdk.calls.filter((c) => c.op === 'update').at(-1)?.payload

  it('no terminal (poller / Meta): con intentos disponibles vuelve a pending', async () => {
    sdk.attempts = 0
    await failQueueItem('q1', 'boom')
    expect(lastUpdate()).toEqual({ status: 'pending', attempts: 1, last_error: 'boom' })
  })

  it('no terminal: al agotar los 3 intentos queda failed', async () => {
    sdk.attempts = 2
    await failQueueItem('q1', 'boom')
    expect(lastUpdate()).toEqual({ status: 'failed', attempts: 3, last_error: 'boom' })
  })

  it('terminal (camino síncrono AutoResponder): failed de una, nunca pending', async () => {
    sdk.attempts = 0
    await failQueueItem('q1', 'sync_timeout', { terminal: true })
    expect(lastUpdate()).toEqual({ status: 'failed', attempts: 1, last_error: 'sync_timeout' })
  })
})

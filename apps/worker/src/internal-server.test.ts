// Fase 1 (AutoResponder sin MacroDroid) — pure-core tests for the internal
// sync endpoint, same deps-injection style as
// providers/autoresponder/webhook-handler.test.ts: no real HTTP server, no
// real DB, no real LLM call — deps are stub functions.
import { describe, expect, it, vi } from 'vitest'
import { handleProcessSync, type ProcessSyncDeps } from './internal-server'
import type { Database } from '@orderflow/types'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

const SECRET = 'internal-secret-for-tests'

function makeQueueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  const now = new Date().toISOString()
  return {
    id: 'queue-item-1', tenant_id: 'tenant-1', whatsapp_account_id: 'account-1',
    raw_payload: {} as unknown as QueueRow['raw_payload'], status: 'processing', attempts: 0,
    last_error: null, processed_at: null, processing_started_at: now, scheduled_at: now,
    created_at: now, updated_at: now,
    ...overrides,
  }
}

function makeDeps(overrides: Partial<ProcessSyncDeps> = {}): ProcessSyncDeps {
  return {
    claimQueueItemById: vi.fn(async (id: string) => makeQueueRow({ id })),
    processMessage:     vi.fn(async () => ({ replyText: 'Hola! ¿En qué te ayudo?' })),
    completeQueueItem:  vi.fn(async () => undefined),
    failQueueItem:      vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('handleProcessSync — auth/validation', () => {
  it('rejects a missing secret header', async () => {
    const deps = makeDeps()
    const result = await handleProcessSync({ secretHeader: null, expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 1000, deps })
    expect(result.httpStatus).toBe(401)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('rejects an incorrect secret header', async () => {
    const deps = makeDeps()
    const result = await handleProcessSync({ secretHeader: 'wrong', expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 1000, deps })
    expect(result.httpStatus).toBe(401)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('refuses to run with no expectedSecret configured (fails closed, never "open")', async () => {
    const deps = makeDeps()
    const result = await handleProcessSync({ secretHeader: 'anything', expectedSecret: '', queueItemId: 'q1', timeoutMs: 1000, deps })
    expect(result.httpStatus).toBe(500)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('rejects a missing/non-string queueItemId', async () => {
    const deps = makeDeps()
    const result = await handleProcessSync({ secretHeader: SECRET, expectedSecret: SECRET, queueItemId: undefined, timeoutMs: 1000, deps })
    expect(result.httpStatus).toBe(400)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })
})

describe('handleProcessSync — claim outcomes', () => {
  it('a queueItemId that cannot be claimed (already claimed by the poller, or unknown) → safe no-op, replyText null', async () => {
    const deps = makeDeps({ claimQueueItemById: vi.fn(async () => null) })
    const result = await handleProcessSync({ secretHeader: SECRET, expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 1000, deps })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replyText: null, outcome: 'error_not_found' })
    expect(deps.processMessage).not.toHaveBeenCalled()
  })

  it('Caso A: processMessage resolves a reply within the budget → ok_replied, queue item completed', async () => {
    const deps = makeDeps({ processMessage: vi.fn(async () => ({ replyText: 'Encontré 2 propiedades.' })) })
    const result = await handleProcessSync({ secretHeader: SECRET, expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 1000, deps })

    expect(result.body).toEqual({ replyText: 'Encontré 2 propiedades.', outcome: 'ok_replied' })
    expect(deps.completeQueueItem).toHaveBeenCalledWith('q1')
    expect(deps.failQueueItem).not.toHaveBeenCalled()
  })

  it('Caso B/H: processMessage resolves null/empty replyText within the budget → ok_silent, still completed (not an error)', async () => {
    const deps = makeDeps({ processMessage: vi.fn(async () => ({ replyText: null })) })
    const result = await handleProcessSync({ secretHeader: SECRET, expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 1000, deps })

    expect(result.body).toEqual({ replyText: null, outcome: 'ok_silent' })
    expect(deps.completeQueueItem).toHaveBeenCalledWith('q1')
  })

  it('Caso D: processMessage throwing (e.g. DeepSeek error) → error_processing, never a fabricated reply, item marked failed', async () => {
    const deps = makeDeps({ processMessage: vi.fn(async () => { throw new Error('DeepSeek 500') }) })
    const result = await handleProcessSync({ secretHeader: SECRET, expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 1000, deps })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replyText: null, outcome: 'error_processing' })
    expect(deps.failQueueItem).toHaveBeenCalledWith('q1', 'DeepSeek 500')
    expect(deps.completeQueueItem).not.toHaveBeenCalled()
  })

  it('never leaks an error message with secrets/stack traces — body only carries the fixed outcome shape', async () => {
    const deps = makeDeps({ processMessage: vi.fn(async () => { throw new Error('token=abc123 leaked') }) })
    const result = await handleProcessSync({ secretHeader: SECRET, expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 1000, deps })

    expect(JSON.stringify(result.body)).not.toMatch(/token=abc123/)
  })
})

describe('handleProcessSync — timeout (Fase 1 §10/§11)', () => {
  it('Caso D (timeout): a slow processMessage beyond the budget → ok_timeout, responds without waiting for it to finish', async () => {
    let resolveSlow!: (v: { replyText: string | null }) => void
    const slow = new Promise<{ replyText: string | null }>((resolve) => { resolveSlow = resolve })

    const deps = makeDeps({ processMessage: vi.fn(() => slow) })
    const start = Date.now()
    const result = await handleProcessSync({ secretHeader: SECRET, expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 30, deps })
    const elapsed = Date.now() - start

    expect(result.body).toEqual({ replyText: null, outcome: 'ok_timeout' })
    expect(elapsed).toBeLessThan(1000) // responded at ~timeoutMs, not waiting for `slow`
    expect(deps.completeQueueItem).not.toHaveBeenCalled() // not yet — still pending

    // Once the slow call eventually finishes, bookkeeping still happens in the background.
    resolveSlow({ replyText: 'respuesta tardía' })
    await new Promise((r) => setTimeout(r, 20))
    expect(deps.completeQueueItem).toHaveBeenCalledWith('q1')
  })

  it('a background failure after timeout marks the item failed, not completed', async () => {
    let rejectSlow!: (err: Error) => void
    const slow = new Promise<{ replyText: string | null }>((_resolve, reject) => { rejectSlow = reject })

    const deps = makeDeps({ processMessage: vi.fn(() => slow) })
    await handleProcessSync({ secretHeader: SECRET, expectedSecret: SECRET, queueItemId: 'q1', timeoutMs: 20, deps })

    rejectSlow(new Error('boom after timeout'))
    await new Promise((r) => setTimeout(r, 20))
    expect(deps.failQueueItem).toHaveBeenCalledWith('q1', 'boom after timeout')
    expect(deps.completeQueueItem).not.toHaveBeenCalled()
  })
})

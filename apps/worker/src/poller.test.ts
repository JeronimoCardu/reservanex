// MVP PROD-A1 — apagado ordenado del poller: stopPoller() no arranca ciclos
// nuevos y espera el que está en curso (para no dejar una fila a medias).
// Sin base ni LLM: lib/supabase y processor son stubs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  claimQueueItem:         vi.fn(),
  completeQueueItem:      vi.fn(async () => undefined),
  failQueueItem:          vi.fn(async () => undefined),
  recoverProcessingItems: vi.fn(async () => undefined),
  processMessage:         vi.fn(async () => undefined),
}))

vi.mock('./lib/supabase', () => ({
  claimQueueItem:         stubs.claimQueueItem,
  completeQueueItem:      stubs.completeQueueItem,
  failQueueItem:          stubs.failQueueItem,
  recoverProcessingItems: stubs.recoverProcessingItems,
}))
vi.mock('./processor', () => ({ processMessage: stubs.processMessage }))

// Estado de módulo (timers, stopped): un módulo fresco por test.
async function loadPoller() {
  vi.resetModules()
  return import('./poller')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  stubs.claimQueueItem.mockReset().mockResolvedValue(null)
  stubs.processMessage.mockReset().mockResolvedValue(undefined)
  stubs.completeQueueItem.mockClear()
  stubs.recoverProcessingItems.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('stopPoller', () => {
  it('después de stopPoller no se reclama nada más', async () => {
    const { startPoller, stopPoller } = await loadPoller()
    await startPoller()
    await vi.advanceTimersByTimeAsync(6_000)
    const claimsBefore = stubs.claimQueueItem.mock.calls.length
    expect(claimsBefore).toBeGreaterThanOrEqual(2)

    await stopPoller()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(stubs.claimQueueItem).toHaveBeenCalledTimes(claimsBefore)
    // El recovery periódico (60 s) también se frenó: sólo corrió el del arranque.
    expect(stubs.recoverProcessingItems).toHaveBeenCalledTimes(1)
  })

  it('espera el ciclo en curso: la fila se completa antes de que resuelva', async () => {
    let finish!: () => void
    stubs.claimQueueItem.mockResolvedValueOnce({ id: 'q1' })
    stubs.processMessage.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined) }))

    const { startPoller, stopPoller } = await loadPoller()
    await startPoller()
    await vi.advanceTimersByTimeAsync(0)
    expect(stubs.processMessage).toHaveBeenCalledTimes(1)

    let stopped = false
    const stopping = stopPoller().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stopped).toBe(false)
    expect(stubs.completeQueueItem).not.toHaveBeenCalled()

    finish()
    await stopping
    expect(stubs.completeQueueItem).toHaveBeenCalledWith('q1')
  })

  it('si se frena durante el recovery del arranque, no programa ticks', async () => {
    let releaseRecovery!: () => void
    stubs.recoverProcessingItems.mockImplementationOnce(() => new Promise<undefined>((resolve) => { releaseRecovery = () => resolve(undefined) }))

    const { startPoller, stopPoller } = await loadPoller()
    const starting = startPoller()
    await stopPoller()
    releaseRecovery()
    await starting
    await vi.advanceTimersByTimeAsync(30_000)
    expect(stubs.claimQueueItem).not.toHaveBeenCalled()
  })
})

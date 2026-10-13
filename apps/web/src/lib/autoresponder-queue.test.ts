// MVP P0-A — una fila de AutoResponder que el camino síncrono no llegó a
// procesar termina 'failed' con motivo, nunca 'pending' para siempre.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { failPendingAutoResponderRow, syncFailureMessage, type SyncFailureReason } from './autoresponder-queue'

function fakeClient(result: { error: { code?: string } | null } | 'throw' = { error: null }) {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const builder = {
    update: (...args: unknown[]) => { calls.push({ op: 'update', args }); return builder },
    eq: (...args: unknown[]) => {
      calls.push({ op: 'eq', args })
      return calls.filter((c) => c.op === 'eq').length === 2
        ? (result === 'throw' ? Promise.reject(new Error('red caída')) : Promise.resolve(result))
        : builder
    },
  }
  const client = { from: (table: string) => { calls.push({ op: 'from', args: [table] }); return builder } }
  return { client: client as never, calls }
}

describe('failPendingAutoResponderRow', () => {
  it('marca failed con el motivo, SÓLO si la fila sigue pending (nunca pisa una que el worker tomó)', async () => {
    const { client, calls } = fakeClient()
    await failPendingAutoResponderRow(client, 'q1', 'sync_worker_timeout')
    expect(calls).toEqual([
      { op: 'from', args: ['message_queue'] },
      { op: 'update', args: [{ status: 'failed', last_error: 'sync_worker_timeout' }] },
      { op: 'eq', args: ['id', 'q1'] },
      { op: 'eq', args: ['status', 'pending'] },
    ])
  })

  it('el detalle opcional queda acotado (p. ej. el status HTTP del worker)', async () => {
    const { client, calls } = fakeClient()
    await failPendingAutoResponderRow(client, 'q1', 'sync_worker_http_error', 'HTTP 502')
    expect(calls[1]!.args[0]).toEqual({ status: 'failed', last_error: 'sync_worker_http_error: HTTP 502' })
    expect(syncFailureMessage('sync_worker_http_error', 'x'.repeat(500))).toHaveLength('sync_worker_http_error: '.length + 100)
  })

  it('nunca tira: un error de la base o de red se loguea y el webhook sigue', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(failPendingAutoResponderRow(fakeClient({ error: { code: '42501' } }).client, 'q1', 'sync_claim_failed')).resolves.toBeUndefined()
    await expect(failPendingAutoResponderRow(fakeClient('throw').client, 'q1', 'sync_claim_failed')).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})

describe('el webhook cierra la fila en TODOS los caminos donde el worker no la tomó', () => {
  const source = readFileSync(join(__dirname, '..', 'app', 'api', 'webhooks', 'autoresponder', 'route.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it.each<SyncFailureReason>([
    'sync_not_configured',
    'sync_worker_timeout',
    'sync_worker_unreachable',
    'sync_worker_http_error',
    'sync_worker_bad_response',
    'sync_claim_failed',
  ])('%s', (reason) => {
    expect(source).toMatch(new RegExp(`failPendingAutoResponderRow\\(admin, queueItemId, [^)]*'${reason}'`))
  })
})

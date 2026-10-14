// MVP PROD-A1 — the node:http adapter, over a REAL socket (ephemeral port)
// with fake deps: health, auth before reading the body, body cap, draining.
// No DB, no LLM: the deps are stubs (same ones as internal-server.test.ts).

import type { AddressInfo } from 'node:net'
import { request, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@orderflow/types'
import {
  HEALTH_PATH,
  INTERNAL_PROCESS_PATH,
  INTERNAL_SECRET_HEADER,
  MAX_BODY_BYTES,
  createInternalHttpServer,
  type ProcessSyncDeps,
} from './internal-server'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

const SECRET = 'a-test-only-internal-secret-of-48-characters-xx'

function makeDeps(): ProcessSyncDeps {
  return {
    claimQueueItemById: vi.fn(async (id: string) => ({ id, tenant_id: 'tenant-1' }) as unknown as QueueRow),
    processMessage:     vi.fn(async () => ({ replyText: 'Hola' })),
    completeQueueItem:  vi.fn(async () => undefined),
    failQueueItem:      vi.fn(async () => undefined),
  }
}

let server: Server | null = null

async function start(opts: { deps?: ProcessSyncDeps; draining?: boolean; secret?: string } = {}) {
  const deps = opts.deps ?? makeDeps()
  server = createInternalHttpServer({
    expectedSecret: opts.secret ?? SECRET,
    timeoutMs:      2_000,
    deps,
    isDraining:     () => opts.draining ?? false,
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { deps, base: `http://127.0.0.1:${port}` }
}

function post(base: string, body: string, secret?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret !== undefined) headers[INTERNAL_SECRET_HEADER] = secret
  return fetch(`${base}${INTERNAL_PROCESS_PATH}`, { method: 'POST', headers, body })
}

// node:http instead of fetch, to control the upload. With `finish: false` the
// request declares `declaredBytes` but only sends `body` and never ends: a
// client still uploading. Resolves with the status as soon as the server
// answers; if the server waited for the whole body, it never does.
function rawPost(
  base: string,
  opts: { body: string; secret?: string; declaredBytes?: number; finish?: boolean },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type':   'application/json',
      'content-length': String(opts.declaredBytes ?? Buffer.byteLength(opts.body)),
    }
    if (opts.secret !== undefined) headers[INTERNAL_SECRET_HEADER] = opts.secret
    const { port } = new URL(base)
    const req = request({ host: '127.0.0.1', port, path: INTERNAL_PROCESS_PATH, method: 'POST', headers })
    let answered = false
    const timer = setTimeout(() => {
      req.destroy()
      reject(new Error('no response: the server waited for the body'))
    }, 3_000)
    req.on('response', (res) => {
      answered = true
      clearTimeout(timer)
      res.resume()
      resolve(res.statusCode ?? 0)
      req.destroy()
    })
    // After the answer the server closes the connection mid-upload: expected.
    req.on('error', (err) => { if (!answered) { clearTimeout(timer); reject(err) } })
    req.write(opts.body)
    if (opts.finish !== false) req.end()
  })
}

// A VALID envelope of exactly `bytes` bytes: the real queueItemId plus
// synthetic ASCII padding (1 byte per char). The worker only reads queueItemId.
function envelope(bytes: number): string {
  const empty = JSON.stringify({ queueItemId: 'q1', pad: '' })
  const body  = JSON.stringify({ queueItemId: 'q1', pad: 'x'.repeat(bytes - empty.length) })
  if (Buffer.byteLength(body) !== bytes) throw new Error(`envelope is ${Buffer.byteLength(body)} bytes, wanted ${bytes}`)
  return body
}

const KiB = 1024

beforeEach(() => {
  // The adapter logs every outcome; keep test output clean.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

describe('GET /healthz', () => {
  it('200 {"status":"ok"} — nothing else: no env, no DB, no tenant', async () => {
    const { base, deps } = await start()
    const res = await fetch(`${base}${HEALTH_PATH}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('HEAD también (algunos checkers usan HEAD)', async () => {
    const { base } = await start()
    expect((await fetch(`${base}${HEALTH_PATH}`, { method: 'HEAD' })).status).toBe(200)
  })

  it('no requiere el secret', async () => {
    const { base } = await start()
    expect((await fetch(`${base}${HEALTH_PATH}`, { headers: { [INTERNAL_SECRET_HEADER]: 'wrong' } })).status).toBe(200)
  })

  it('while draining → 503 {"status":"draining"}', async () => {
    const { base } = await start({ draining: true })
    const res = await fetch(`${base}${HEALTH_PATH}`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'draining' })
  })
})

describe(`POST ${INTERNAL_PROCESS_PATH} — auth`, () => {
  it('sin secret → 401, sin tocar la cola', async () => {
    const { base, deps } = await start()
    const res = await post(base, JSON.stringify({ queueItemId: 'q1' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid internal secret' })
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('secret incorrecto → 401, sin tocar la cola', async () => {
    const { base, deps } = await start()
    const res = await post(base, JSON.stringify({ queueItemId: 'q1' }), 'not-the-secret')
    expect(res.status).toBe(401)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('secret correcto → procesa (claim del id pedido) y responde la respuesta', async () => {
    const { base, deps } = await start()
    const res = await post(base, JSON.stringify({ queueItemId: 'q1' }), SECRET)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ replyText: 'Hola', outcome: 'ok_replied' })
    expect(deps.claimQueueItemById).toHaveBeenCalledWith('q1')
  })

  it('sin secret configurado en el worker → 500, nunca "abierto"', async () => {
    const { base, deps } = await start({ secret: '' })
    const res = await post(base, JSON.stringify({ queueItemId: 'q1' }), 'anything')
    expect(res.status).toBe(500)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('JSON inválido con secret → 400', async () => {
    const { base, deps } = await start()
    expect((await post(base, '{nope', SECRET)).status).toBe(400)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('while draining → 503 shutting_down, sin tocar la cola', async () => {
    const { base, deps } = await start({ draining: true })
    const res = await post(base, JSON.stringify({ queueItemId: 'q1' }), SECRET)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'shutting_down' })
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })
})

// MVP PROD-A1.1 — tope de body: 64 KiB, INCLUSIVO (≤ 65536 se acepta, 65537
// es 413). El secret se valida antes de leer una sola línea del body.
describe(`POST ${INTERNAL_PROCESS_PATH} — tope de body (${MAX_BODY_BYTES} bytes, inclusivo)`, () => {
  it('el tope es 64 KiB = 65536 bytes', () => {
    expect(MAX_BODY_BYTES).toBe(65_536)
  })

  it('A. sin secret + body grande → 401 sin esperar ni acumular el body (10 MiB declarados, 1 KiB enviado)', async () => {
    const { base, deps } = await start()
    const status = await rawPost(base, { body: 'x'.repeat(KiB), declaredBytes: 10 * KiB * KiB, finish: false })
    expect(status).toBe(401)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('B. secret incorrecto + body grande → 401 sin esperar el body', async () => {
    const { base, deps } = await start()
    const status = await rawPost(base, { body: 'x'.repeat(KiB), secret: 'not-the-secret', declaredBytes: 10 * KiB * KiB, finish: false })
    expect(status).toBe(401)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('C. secret correcto + envelope válido de ~16 KiB (16385 B, más que el tope anterior) → no 413, llega al claim', async () => {
    const { base, deps } = await start()
    const res = await post(base, envelope(16 * KiB + 1), SECRET)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ replyText: 'Hola', outcome: 'ok_replied' })
    expect(deps.claimQueueItemById).toHaveBeenCalledWith('q1')
  })

  it('D. secret correcto + envelope válido de 32 KiB → pasa el tope, se parsea y llega al claim', async () => {
    const { base, deps } = await start()
    const res = await post(base, envelope(32 * KiB), SECRET)
    expect(res.status).toBe(200)
    expect(deps.claimQueueItemById).toHaveBeenCalledWith('q1')
  })

  it('E. secret correcto + más de 64 KiB (96 KiB) → 413, sin tocar la cola', async () => {
    const { base, deps } = await start()
    expect(await rawPost(base, { body: envelope(96 * KiB), secret: SECRET })).toBe(413)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('F. límite exacto: 65536 bytes se acepta (≤)', async () => {
    const { base, deps } = await start()
    const res = await post(base, envelope(65_536), SECRET)
    expect(res.status).toBe(200)
    expect(deps.claimQueueItemById).toHaveBeenCalledWith('q1')
  })

  it('F. límite exacto: 65537 bytes → 413, sin tocar la cola', async () => {
    const { base, deps } = await start()
    expect(await rawPost(base, { body: envelope(65_537), secret: SECRET })).toBe(413)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })

  it('un binario (no JSON) con secret → 400: esta ruta no transporta media', async () => {
    const { base, deps } = await start()
    const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const res = await fetch(`${base}${INTERNAL_PROCESS_PATH}`, {
      method:  'POST',
      headers: { 'content-type': 'image/jpeg', [INTERNAL_SECRET_HEADER]: SECRET },
      body:    jpegHeader,
    })
    expect(res.status).toBe(400)
    expect(deps.claimQueueItemById).not.toHaveBeenCalled()
  })
})

describe('otras rutas', () => {
  it.each([
    ['GET', INTERNAL_PROCESS_PATH],
    ['POST', HEALTH_PATH],
    ['GET', '/'],
    ['GET', '/internal'],
  ])('%s %s → 404', async (method, path) => {
    const { base } = await start()
    expect((await fetch(`${base}${path}`, { method })).status).toBe(404)
  })
})

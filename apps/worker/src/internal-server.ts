// Fase 1 (AutoResponder sin MacroDroid) — internal HTTP server exposing
// POST /internal/autoresponder/process, called synchronously by apps/web's
// public webhook (POST /api/webhooks/autoresponder) so an AutoResponder
// reply can be generated and returned in the SAME HTTP response that
// AutoResponder's "Web Server" trigger is waiting on — no messaging_outbox,
// no dispatcher, no MacroDroid for this path (see processor.ts's
// dispatchOutboundReply and MessageContext.syncReply).
//
// This is a NEW capability for apps/worker, which previously only ran
// background poll loops (poller.ts/dispatcher.ts/media-dispatcher.ts) with
// no HTTP surface at all — see index.ts. Deployment implication: the worker
// process must now be reachable over HTTP from apps/web (a separate,
// independently deployed process — see WORKER_INTERNAL_URL), not just have
// outbound network access. Uses Node's built-in http module — no new
// dependency — since the only client is apps/web via a single fixed route.
//
// Split into a pure, dependency-injected core (handleProcessSync) and a
// thin node:http adapter (startInternalServer), same pattern as
// providers/autoresponder/webhook-handler.ts, so the auth/timeout/outcome
// logic is unit-testable without a real DB, HTTP server, or LLM call.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Database } from '@orderflow/types'
import { claimQueueItemById, completeQueueItem, failQueueItem } from './lib/supabase'
import { processMessage, type ProcessMessageSyncResult } from './processor'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

export const INTERNAL_SECRET_HEADER = 'x-worker-internal-secret'
export const INTERNAL_PROCESS_PATH  = '/internal/autoresponder/process'
// MVP PROD-A1 — liveness para la plataforma (healthCheckPath de Render). Público: no lee la base,
// no llama al LLM, no expone configuración. Sólo dice "el proceso y su HTTP
// están vivos" (o que se está apagando).
export const HEALTH_PATH            = '/healthz'

const DEFAULT_PORT       = 8788
const DEFAULT_TIMEOUT_MS = 20_000
// El body legítimo es {"queueItemId":"<uuid>"}: el mensaje, su texto y
// cualquier media viven en message_queue y el worker los lee por id, así que
// por esta ruta no viajan media, binarios ni base64 (lo que no sea JSON es 400
// y del JSON sólo se usa queueItemId). 64 KiB acota la memoria por request con
// margen sobre ese envelope. Tope INCLUSIVO: hasta MAX_BODY_BYTES (65536)
// bytes se acepta; desde 65537, 413. El secret se valida antes de leer el body.
export const MAX_BODY_BYTES = 64 * 1024

export interface ProcessSyncDeps {
  claimQueueItemById(id: string): Promise<QueueRow | null>
  processMessage(item: QueueRow, syncOptions: { timeoutMs: number }): Promise<ProcessMessageSyncResult | void>
  completeQueueItem(id: string): Promise<void>
  /**
   * MVP P0-A — TERMINAL: deja la fila 'failed' con `error` en last_error. Una
   * fila de este camino ya no puede responder después de cerrado el request,
   * y el poller genérico no la reclama: nada de volver a 'pending'.
   */
  failQueueItem(id: string, error: string): Promise<void>
}

/** last_error de una fila cuyo presupuesto síncrono se agotó: la respuesta ya no se puede entregar. */
export const SYNC_TIMEOUT_ERROR = 'sync_timeout: presupuesto síncrono agotado, respuesta no entregada'

export type ProcessSyncOutcome =
  | 'ok_replied'          // AI generated a reply within the budget
  | 'ok_silent'           // AI ran within the budget and produced no reply (manual mode, deferred audio, etc.)
  | 'ok_timeout'          // budget exceeded — nothing can be delivered anymore; the row ends 'failed' (SYNC_TIMEOUT_ERROR)
  | 'error_not_found'     // queueItemId not claimable (already claimed by the async poller, or unknown id) — safe no-op
  | 'error_processing'    // processMessage threw before the timeout fired
  | 'rejected_bad_request' // auth or payload validation failed

export interface ProcessSyncResult {
  httpStatus: number
  body:       { replyText: string | null; outcome: ProcessSyncOutcome } | { error: string }
  outcome:    ProcessSyncOutcome
}

// Constant-time comparison so a mistyped/attacker-guessed secret can't be
// distinguished by timing — same rationale as any bearer-token check, even
// though this endpoint is only ever meant to be reachable from apps/web.
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** null si el secret es válido; el rechazo (sin detalles) si no. */
export function authorizeInternalRequest(secretHeader: string | null, expectedSecret: string): ProcessSyncResult | null {
  if (!expectedSecret) {
    // Misconfiguration, not a client error — never silently "open" the endpoint.
    console.error('[internal-server] WORKER_INTERNAL_SECRET is not configured')
    return { httpStatus: 500, body: { error: 'Server misconfigured' }, outcome: 'rejected_bad_request' }
  }
  if (!secretHeader || !timingSafeStringEqual(secretHeader, expectedSecret)) {
    return { httpStatus: 401, body: { error: 'Invalid internal secret' }, outcome: 'rejected_bad_request' }
  }
  return null
}

// Pure core — no HTTP, no direct DB/LLM calls (those come in via deps).
// Never throws: every failure mode is expressed as a ProcessSyncResult.
export async function handleProcessSync(params: {
  secretHeader:   string | null
  expectedSecret: string
  queueItemId:    unknown
  timeoutMs:      number
  deps:           ProcessSyncDeps
}): Promise<ProcessSyncResult> {
  const { secretHeader, expectedSecret, queueItemId, timeoutMs, deps } = params

  const denied = authorizeInternalRequest(secretHeader, expectedSecret)
  if (denied) return denied
  if (typeof queueItemId !== 'string' || !queueItemId.trim()) {
    return { httpStatus: 400, body: { error: 'Missing queueItemId' }, outcome: 'rejected_bad_request' }
  }

  const item = await deps.claimQueueItemById(queueItemId)
  if (!item) {
    // Already claimed (by the regular poller, or a retried/duplicate call to
    // THIS endpoint) or the id doesn't exist / isn't pending. Safe no-op —
    // never fabricate a reply, never double-process.
    return { httpStatus: 200, body: { replyText: null, outcome: 'error_not_found' }, outcome: 'error_not_found' }
  }

  const resultPromise = deps.processMessage(item, { timeoutMs })

  const TIMEOUT = Symbol('sync-budget-exceeded')
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    setTimeout(() => resolve(TIMEOUT), timeoutMs)
  })

  let winner: ProcessMessageSyncResult | void | typeof TIMEOUT
  try {
    winner = await Promise.race([resultPromise, timeoutPromise])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[internal-server] processMessage error', { queueItemId: item.id, error: message })
    await deps.failQueueItem(item.id, message).catch(() => undefined)
    return { httpStatus: 200, body: { replyText: null, outcome: 'error_processing' }, outcome: 'error_processing' }
  }

  if (winner === TIMEOUT) {
    console.warn('[internal-server] sync budget exceeded — responding empty, letting processing finish in the background', {
      queueItemId: item.id,
      timeoutMs,
    })
    // resultPromise keeps running after this function returns. Whatever it
    // generates can no longer be delivered (deliverAIReply refuses a reply
    // past its deadline, and there is no other AutoResponder transport), so
    // the row ends TERMINAL and diagnosable: 'failed' + why.
    resultPromise
      .then(() => deps.failQueueItem(item.id, SYNC_TIMEOUT_ERROR))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[internal-server] background processMessage (post-timeout) failed', { queueItemId: item.id, error: message })
        return deps.failQueueItem(item.id, `${SYNC_TIMEOUT_ERROR} (${message})`)
      })
      .catch(() => undefined)

    return { httpStatus: 200, body: { replyText: null, outcome: 'ok_timeout' }, outcome: 'ok_timeout' }
  }

  // The pipeline itself can notice the budget ran out (its own abort fired
  // first): same terminal outcome as the race above.
  if (winner?.reason === 'deadline_exceeded') {
    await deps.failQueueItem(item.id, SYNC_TIMEOUT_ERROR)
    return { httpStatus: 200, body: { replyText: null, outcome: 'ok_timeout' }, outcome: 'ok_timeout' }
  }

  await deps.completeQueueItem(item.id)
  const replyText = winner?.replyText ?? null
  const outcome: ProcessSyncOutcome = replyText ? 'ok_replied' : 'ok_silent'
  if (!replyText && winner?.reason) {
    console.log('[internal-server] silent by design', { queueItemId: item.id, reason: winner.reason })
  }
  return { httpStatus: 200, body: { replyText, outcome }, outcome }
}

class BodyTooLargeError extends Error {}

// Lee el body con tope: pasado MAX_BODY_BYTES deja de acumular y rechaza.
function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown, opts: { close?: boolean } = {}): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // Una respuesta que no leyó el body entero no reutiliza la conexión.
  if (opts.close) headers['connection'] = 'close'
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

// Real deps of the sync path. Every failure here is TERMINAL (MVP P0-A): an
// AutoResponder row can no longer answer once its HTTP request is closed, and
// the generic poller never claims it — back to 'pending' would mean forever.
export function createInternalServerDeps(): ProcessSyncDeps {
  return {
    claimQueueItemById,
    processMessage,
    completeQueueItem,
    failQueueItem: (id, error) => failQueueItem(id, error, { terminal: true }),
  }
}

export interface InternalHttpServerOptions {
  expectedSecret: string
  timeoutMs:      number
  deps:           ProcessSyncDeps
  /** true mientras el proceso se apaga: health 503, requests nuevas 503. */
  isDraining?:    () => boolean
}

// Thin node:http adapter — translates ProcessSyncResult to a JSON HTTP
// response. Never throws out of the request handler (any unexpected error
// becomes a 500 JSON body). Returns the server WITHOUT listening, so tests
// can drive it with fake deps on an ephemeral port.
export function createInternalHttpServer(opts: InternalHttpServerOptions): Server {
  const { expectedSecret, timeoutMs, deps } = opts
  const draining = () => opts.isDraining?.() ?? false

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0]

    if (path === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      if (draining()) sendJson(res, 503, { status: 'draining' })
      else            sendJson(res, 200, { status: 'ok' })
      return
    }

    if (req.method !== 'POST' || req.url !== INTERNAL_PROCESS_PATH) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }

    const startedAt = Date.now()

    if (draining()) {
      sendJson(res, 503, { error: 'shutting_down' }, { close: true })
      console.log('[internal-server]', { outcome: 'rejected_draining', durationMs: 0 })
      return
    }

    // MVP PROD-A1 — auth ANTES de leer el body: con el endpoint expuesto por
    // HTTPS, un request sin el secret no llega a ocupar memoria.
    const rawHeader    = req.headers[INTERNAL_SECRET_HEADER]
    const secretHeader = typeof rawHeader === 'string' ? rawHeader : null
    const denied = authorizeInternalRequest(secretHeader, expectedSecret)
    if (denied) {
      sendJson(res, denied.httpStatus, denied.body, { close: true })
      console.log('[internal-server]', { outcome: denied.outcome, httpStatus: denied.httpStatus, durationMs: Date.now() - startedAt })
      return
    }

    readRequestBody(req, MAX_BODY_BYTES)
      .then(async (raw) => {
        let parsed: unknown = {}
        if (raw) {
          try {
            parsed = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { error: 'invalid_json' })
            return
          }
        }

        const queueItemId = (parsed as Record<string, unknown>)?.['queueItemId']

        const result = await handleProcessSync({
          secretHeader,
          expectedSecret,
          queueItemId,
          timeoutMs,
          deps,
        })

        console.log('[internal-server]', {
          outcome:     result.outcome,
          queueItemId: typeof queueItemId === 'string' ? queueItemId : null,
          durationMs:  Date.now() - startedAt,
        })
        sendJson(res, result.httpStatus, result.body)
      })
      .catch((err: unknown) => {
        if (err instanceof BodyTooLargeError) {
          if (!res.headersSent) sendJson(res, 413, { error: 'payload_too_large' }, { close: true })
          console.warn('[internal-server]', { outcome: 'rejected_payload_too_large', durationMs: Date.now() - startedAt })
          return
        }
        console.error('[internal-server] fatal error', { error: err instanceof Error ? err.message : String(err) })
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
      })
  })
}

export interface InternalServerHandle {
  /** Deja de aceptar conexiones, responde 503 a lo nuevo y espera lo que está en curso. */
  close(): Promise<void>
}

// Real deps + env. La configuración ya la validó lib/startup-config.ts al
// arrancar (index.ts): acá sólo se lee.
export function startInternalServer(): InternalServerHandle {
  const port           = Number(process.env.WORKER_INTERNAL_PORT ?? DEFAULT_PORT)
  const expectedSecret = process.env.WORKER_INTERNAL_SECRET ?? ''
  const timeoutMs       = Number(process.env.AUTORESPONDER_SYNC_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)

  if (!expectedSecret) {
    console.error(
      '[internal-server] WORKER_INTERNAL_SECRET is not set — the synchronous ' +
      'AutoResponder endpoint will reject every request. Set it in .env.local ' +
      '(same value on apps/web and apps/worker).',
    )
  }

  let draining = false
  const server = createInternalHttpServer({
    expectedSecret,
    timeoutMs,
    deps:       createInternalServerDeps(),
    isDraining: () => draining,
  })

  // Puerto ocupado, permisos, etc.: sin HTTP el worker no sirve. Se termina
  // para que la plataforma lo reinicie, en vez de quedar vivo a medias.
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error('[internal-server] server error — exiting', { code: err.code ?? null, error: err.message })
    process.exit(1)
  })

  // Sin host: Node escucha en la dirección no especificada (:: con IPv6,
  // que acepta también IPv4; 0.0.0.0 si no hay IPv6). Render enruta a PORT
  // por esa interfaz; en local, localhost también llega.
  server.listen(port, () => {
    console.log(`[internal-server] listening on :${port} — sync AutoResponder processing, timeout=${timeoutMs}ms, health=${HEALTH_PATH}`)
  })

  return {
    close: () => new Promise<void>((resolve) => {
      draining = true
      server.close(() => resolve())
      // Las keep-alive ociosas no tienen nada en curso: se cierran ya.
      server.closeIdleConnections()
    }),
  }
}

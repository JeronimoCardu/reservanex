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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Database } from '@orderflow/types'
import { claimQueueItemById, completeQueueItem, failQueueItem } from './lib/supabase'
import { processMessage, type ProcessMessageSyncResult } from './processor'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

export const INTERNAL_SECRET_HEADER = 'x-worker-internal-secret'
export const INTERNAL_PROCESS_PATH  = '/internal/autoresponder/process'

const DEFAULT_PORT       = 8788
const DEFAULT_TIMEOUT_MS = 20_000

export interface ProcessSyncDeps {
  claimQueueItemById(id: string): Promise<QueueRow | null>
  processMessage(item: QueueRow, syncOptions: { timeoutMs: number }): Promise<ProcessMessageSyncResult | void>
  completeQueueItem(id: string): Promise<void>
  failQueueItem(id: string, error: string): Promise<void>
}

export type ProcessSyncOutcome =
  | 'ok_replied'          // AI generated a reply within the budget
  | 'ok_silent'           // AI ran within the budget and produced no reply (manual mode, deferred audio, etc.)
  | 'ok_timeout'          // budget exceeded — processing continues in the background, falls back to messaging_outbox if it eventually replies
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

  if (!expectedSecret) {
    // Misconfiguration, not a client error — never silently "open" the endpoint.
    console.error('[internal-server] WORKER_INTERNAL_SECRET is not configured')
    return { httpStatus: 500, body: { error: 'Server misconfigured' }, outcome: 'rejected_bad_request' }
  }
  if (!secretHeader || !timingSafeStringEqual(secretHeader, expectedSecret)) {
    return { httpStatus: 401, body: { error: 'Invalid internal secret' }, outcome: 'rejected_bad_request' }
  }
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
    // resultPromise keeps running after this function returns. Once it
    // settles, dispatchOutboundReply will see the deadline has passed and
    // fall back to messaging_outbox (the only delivery path left at that
    // point) — bookkeep the queue row's terminal status either way.
    resultPromise
      .then(() => deps.completeQueueItem(item.id))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[internal-server] background processMessage (post-timeout) failed', { queueItemId: item.id, error: message })
        return deps.failQueueItem(item.id, message)
      })
      .catch(() => undefined)

    return { httpStatus: 200, body: { replyText: null, outcome: 'ok_timeout' }, outcome: 'ok_timeout' }
  }

  await deps.completeQueueItem(item.id)
  const replyText = winner?.replyText ?? null
  const outcome: ProcessSyncOutcome = replyText ? 'ok_replied' : 'ok_silent'
  return { httpStatus: 200, body: { replyText, outcome }, outcome }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8') })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// Thin node:http adapter — real deps, real request parsing, translates
// ProcessSyncResult to a JSON HTTP response. Never throws out of the
// request handler (any unexpected error becomes a 500 JSON body).
export function startInternalServer(): void {
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

  const deps: ProcessSyncDeps = { claimQueueItemById, processMessage, completeQueueItem, failQueueItem }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== INTERNAL_PROCESS_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
      return
    }

    readRequestBody(req)
      .then(async (raw) => {
        let parsed: unknown = {}
        if (raw) {
          try {
            parsed = JSON.parse(raw)
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_json' }))
            return
          }
        }

        const queueItemId = (parsed as Record<string, unknown>)?.['queueItemId']
        const secretHeader = req.headers[INTERNAL_SECRET_HEADER]

        const result = await handleProcessSync({
          secretHeader: typeof secretHeader === 'string' ? secretHeader : null,
          expectedSecret,
          queueItemId,
          timeoutMs,
          deps,
        })

        console.log('[internal-server]', { outcome: result.outcome, queueItemId: typeof queueItemId === 'string' ? queueItemId : null })
        res.writeHead(result.httpStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result.body))
      })
      .catch((err: unknown) => {
        console.error('[internal-server] fatal error', { error: err instanceof Error ? err.message : String(err) })
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal_error' }))
        }
      })
  })

  server.listen(port, () => {
    console.log(`[internal-server] listening on :${port} — sync AutoResponder processing, timeout=${timeoutMs}ms`)
  })
}

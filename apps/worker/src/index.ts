import path from 'path'
import { config } from 'dotenv'

// Development: load the unified root .env.local (src/ → apps/worker/ → apps/
// → repo root). MVP PROD-A1 — in production (NODE_ENV=production, set by the
// Dockerfile) configuration comes ONLY from the platform's environment (Render
// env vars), never from a file that might have slipped into the image.
if (process.env.NODE_ENV !== 'production') {
  config({ path: path.resolve(__dirname, '../../../.env.local') })
}

import { validateWorkerConfig } from './lib/startup-config'
import { startPoller, stopPoller } from './poller'
import { startInternalServer, type InternalServerHandle } from './internal-server'

// MVP PROD-A1 — fail fast: a worker missing what makes it useful must not
// look healthy. Only variable NAMES are printed, never values.
const configCheck = validateWorkerConfig(process.env)
if (!configCheck.ok) {
  console.error(
    '[worker] invalid configuration — not starting:\n' +
    configCheck.problems.map((p) => `  - ${p}`).join('\n'),
  )
  process.exit(1)
}
for (const warning of configCheck.warnings) console.warn('[worker] config warning:', warning)

// Fase 2A (AUTORESPONDER-ONLY) — this worker runs exactly two components.
// The former outbound dispatcher and media dispatcher (both MacroDroid
// transports) were deleted: AutoResponder replies are delivered
// synchronously in the webhook's own HTTP response (internal-server.ts →
// processor.ts's deliverAIReply), and AutoResponder media is answered with
// a fixed "send it as text" reply instead of being extracted off the
// device. Meta is unaffected — it never used either dispatcher; its
// outbound send is a direct Graph API call inside the pipeline.
console.log('[worker] started — pid', process.pid, { nodeEnv: process.env.NODE_ENV ?? 'development' })
console.log('[worker] GROQ_API_KEY configured:', !!process.env.GROQ_API_KEY)

// Inbound message_queue poll loop. Still needed: it is the crash-recovery
// path for queue rows the synchronous endpoint could not finish (and the
// only processing path for provider=meta).
startPoller().catch((err) => {
  console.error('[worker] fatal startup error (poller):', err)
  process.exit(1)
})

// Internal HTTP server for synchronous AI processing, called by apps/web's
// public webhook so a reply can be returned in the SAME HTTP response
// AutoResponder is waiting on. See internal-server.ts.
let internalServer: InternalServerHandle | null = null
try {
  internalServer = startInternalServer()
} catch (err) {
  console.error('[worker] fatal startup error (internal server):', err)
  process.exit(1)
}

// MVP PROD-A1 — orderly shutdown. Render sends SIGTERM to the old instance on
// every deploy/restart; Ctrl+C sends SIGINT. No new work is accepted,
// in-flight work gets up to SHUTDOWN_DEADLINE_MS (the sync budget is 20s;
// render.yaml's maxShutdownDelaySeconds is 30s before SIGKILL), then the
// process exits. A second signal exits immediately.
const SHUTDOWN_DEADLINE_MS = 25_000
let shuttingDown = false

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    console.warn(`[worker] ${signal} received again — exiting now`)
    process.exit(1)
  }
  shuttingDown = true
  console.log(`[worker] ${signal} received — draining (up to ${SHUTDOWN_DEADLINE_MS}ms)`)

  setTimeout(() => {
    console.error('[worker] drain deadline exceeded — exiting')
    process.exit(1)
  }, SHUTDOWN_DEADLINE_MS).unref()

  Promise.all([stopPoller(), internalServer?.close()])
    .then(() => {
      console.log('[worker] drained — exiting')
      process.exit(0)
    })
    .catch((err: unknown) => {
      console.error('[worker] error while draining — exiting', { error: err instanceof Error ? err.message : String(err) })
      process.exit(1)
    })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

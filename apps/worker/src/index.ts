import path from 'path'
import { config } from 'dotenv'

// Load unified root .env.local (src/ → apps/worker/ → apps/ → repo root)
// In production the file doesn't exist and vars come from the platform (Render/Railway).
config({ path: path.resolve(__dirname, '../../../.env.local') })

import { startPoller } from './poller'
import { startInternalServer } from './internal-server'

// Fase 2A (AUTORESPONDER-ONLY) — this worker runs exactly two components.
// The former outbound dispatcher and media dispatcher (both MacroDroid
// transports) were deleted: AutoResponder replies are delivered
// synchronously in the webhook's own HTTP response (internal-server.ts →
// processor.ts's deliverAIReply), and AutoResponder media is answered with
// a fixed "send it as text" reply instead of being extracted off the
// device. Meta is unaffected — it never used either dispatcher; its
// outbound send is a direct Graph API call inside the pipeline.
console.log('[worker] started — pid', process.pid)
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
try {
  startInternalServer()
} catch (err) {
  console.error('[worker] fatal startup error (internal server):', err)
  process.exit(1)
}

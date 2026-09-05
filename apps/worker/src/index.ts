import path from 'path'
import { config } from 'dotenv'

// Load unified root .env.local (src/ → apps/worker/ → apps/ → repo root)
// In production the file doesn't exist and vars come from the platform (Render/Railway).
config({ path: path.resolve(__dirname, '../../../.env.local') })

import { startPoller } from './poller'
import { startDispatcher } from './dispatcher'
import { startMediaDispatcher } from './media-dispatcher'
import { startInternalServer } from './internal-server'

console.log('[worker] started — pid', process.pid)
console.log('[worker] GROQ_API_KEY configured:', !!process.env.GROQ_API_KEY)
startPoller().catch((err) => {
  console.error('[worker] fatal startup error (poller):', err)
  process.exit(1)
})
// Independent poll loop for outbound AutoResponder/MacroDroid dispatch — see
// dispatcher.ts. A failure here must not take down inbound processing.
startDispatcher().catch((err) => {
  console.error('[worker] fatal startup error (dispatcher):', err)
  process.exit(1)
})
// Independent poll loop for AutoResponder media (audio/image/document)
// extraction triggers — see media-dispatcher.ts (Fase 6B). A failure here
// must not take down inbound processing or outbound text dispatch.
startMediaDispatcher().catch((err) => {
  console.error('[worker] fatal startup error (media dispatcher):', err)
  process.exit(1)
})
// Fase 1 (AutoResponder sin MacroDroid) — internal HTTP server for
// synchronous AI processing, called by apps/web's public webhook so a reply
// can be returned in the SAME HTTP response AutoResponder is waiting on.
// See internal-server.ts. A failure here must not take down the poll loops.
try {
  startInternalServer()
} catch (err) {
  console.error('[worker] fatal startup error (internal server):', err)
  process.exit(1)
}

import { type NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import {
  handleAutoResponderWebhook,
  type AutoResponderWebhookDeps,
} from '@/lib/autoresponder-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Fase 1 (AutoResponder sin MacroDroid) — this route now waits (synchronously)
// on the worker's internal AI pipeline before responding, instead of
// returning the instant it enqueues. Must exceed WORKER_SYNC_FETCH_TIMEOUT_MS
// below with headroom. On Vercel this requires a plan whose function timeout
// ceiling covers this value (Hobby currently caps at 60s) — verify against
// the deployed plan if AUTORESPONDER_SYNC_TIMEOUT_MS is ever raised.
export const maxDuration = 30

const DEVICE_TOKEN_HEADER      = 'x-reservanex-device-token'
const INTERNAL_SECRET_HEADER   = 'x-worker-internal-secret'
const INTERNAL_PROCESS_PATH    = '/internal/autoresponder/process'
const DEFAULT_SYNC_TIMEOUT_MS  = 20_000
// Fase 1 — the worker's own internal endpoint races processMessage() against
// AUTORESPONDER_SYNC_TIMEOUT_MS and always responds by then. This fetch's
// own timeout must be safely LARGER than that so we never give up on the
// worker before it has even finished giving up on itself — a race between
// the two timeouts would make an honest ok_timeout from the worker
// indistinguishable from this route's own network-level failure.
const FETCH_TIMEOUT_BUFFER_MS = 5_000

// POST /api/webhooks/autoresponder
//
// Inbound endpoint for AutoResponder for WA's "Web Server" trigger, configured
// with a custom header (x-reservanex-device-token) instead of a URL secret —
// physically confirmed to work on the Android test device (Fase 4 audit).
//
// Auth identifies the tenant/account by DEVICE TOKEN — never by the message
// sender's phone/name (see apps/web/src/lib/autoresponder-webhook.ts).
//
// Fase 1 (AutoResponder sin MacroDroid): once the event is queued, this
// route calls the worker's internal HTTP endpoint SYNCHRONOUSLY and waits
// for the generated reply, returning {"replies":[{"message":"..."}]} (or
// {"replies":[]} when there is deliberately no reply, or when processing
// fails/times out — never a fabricated answer) in THIS same HTTP response.
// AutoResponder's "Web Server" trigger publishes that reply directly to
// WhatsApp — no messaging_outbox, no dispatcher, no MacroDroid for this
// path. Group/unresolved-sender/package-mismatch messages are still
// answered instantly with {"replies":[]} without ever reaching the worker.
export async function POST(req: NextRequest) {
  try {
    const deviceTokenHeader = req.headers.get(DEVICE_TOKEN_HEADER)
    const rawBody = await req.text()

    const admin = createAdminClient()

    const deps: AutoResponderWebhookDeps = {
      async findAccountByTokenHash(tokenHash) {
        const { data, error } = await admin
          .from('whatsapp_accounts')
          .select('id, tenant_id, active')
          .eq('provider', 'autoresponder')
          .eq('inbound_token_hash', tokenHash)
          .maybeSingle()

        if (error) {
          console.error('[webhook:autoresponder] account lookup error', { code: error.code })
          return null
        }
        if (!data) return null

        return { id: data.id, tenantId: data.tenant_id, active: data.active }
      },

      async enqueueMessage({ tenantId, accountId, rawPayload }) {
        const { data, error } = await admin
          .from('message_queue')
          .insert({
            tenant_id:           tenantId,
            whatsapp_account_id: accountId,
            raw_payload:         rawPayload as never,
          })
          .select('id')
          .single()

        if (error || !data) {
          console.error('[webhook:autoresponder] queue insert error', { code: error?.code, message: error?.message })
          return null
        }
        return { id: data.id }
      },

      async recordRejection({ tenantId, accountId, reason, internalEventId, senderLength }) {
        // Best-effort — never allowed to fail the webhook response. Never
        // receives or persists the raw sender string, only its length.
        const { error } = await admin.from('inbound_rejections').insert({
          tenant_id:         tenantId,
          account_id:        accountId,
          provider:          'autoresponder',
          reason,
          internal_event_id: internalEventId,
          sender_length:     senderLength,
        })

        if (error) {
          console.error('[webhook:autoresponder] rejection insert error', { code: error.code, message: error.message })
        }
      },

      // Fase 7 Parte A — device health: an authenticated inbound request is
      // direct physical evidence the Android is alive. Best-effort, never
      // fails the webhook response.
      async markDeviceSeen(accountId) {
        const now = new Date().toISOString()
        const { error } = await admin
          .from('whatsapp_accounts')
          .update({ last_device_seen_at: now, last_inbound_at: now })
          .eq('id', accountId)
        if (error) {
          console.warn('[webhook:autoresponder] health update failed (non-fatal)', { code: error.code })
        }
      },

      // Fase 1 (AutoResponder sin MacroDroid) — calls the worker's internal
      // HTTP endpoint (apps/worker/src/internal-server.ts), which claims
      // this exact message_queue row and runs the real AI pipeline
      // (buildContext → generateAIReply → tools → DeepSeek → writeMemory —
      // the SAME code the async poller uses for Meta, zero duplication).
      // Never throws: every failure (missing config, network error,
      // timeout, non-2xx, malformed body) resolves to null, which the pure
      // handler above turns into a safe {replies:[]}.
      async processSync({ queueItemId, tenantId, accountId }) {
        const workerUrl = process.env.WORKER_INTERNAL_URL
        const secret     = process.env.WORKER_INTERNAL_SECRET

        if (!workerUrl || !secret) {
          console.error('[webhook:autoresponder] WORKER_INTERNAL_URL/WORKER_INTERNAL_SECRET not configured — cannot process synchronously', {
            tenantId, accountId,
          })
          return null
        }

        const budgetMs = Number(process.env.AUTORESPONDER_SYNC_TIMEOUT_MS ?? DEFAULT_SYNC_TIMEOUT_MS)
        const fetchTimeoutMs = budgetMs + FETCH_TIMEOUT_BUFFER_MS

        try {
          const res = await fetch(`${workerUrl.replace(/\/$/, '')}${INTERNAL_PROCESS_PATH}`, {
            method:  'POST',
            headers: {
              'content-type':           'application/json',
              [INTERNAL_SECRET_HEADER]: secret,
            },
            body:   JSON.stringify({ queueItemId }),
            signal: AbortSignal.timeout(fetchTimeoutMs),
          })

          if (!res.ok) {
            console.error('[webhook:autoresponder] worker internal call returned non-OK status', { status: res.status, queueItemId })
            return null
          }

          const data = (await res.json()) as { replyText?: unknown; outcome?: unknown }
          console.log('[webhook:autoresponder] worker internal call completed', { queueItemId, outcome: data.outcome })
          return { replyText: typeof data.replyText === 'string' ? data.replyText : null }
        } catch (err) {
          const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          console.error('[webhook:autoresponder] worker internal call failed', {
            queueItemId,
            reason: isTimeout ? 'timeout' : (err instanceof Error ? err.message : String(err)),
          })
          return null
        }
      },
    }

    const result = await handleAutoResponderWebhook({ deviceTokenHeader, rawBody, deps })

    // logContext never contains the device token, the sender's raw value
    // beyond a coarse "reason" code, or message text — safe to log as-is.
    console.log('[webhook:autoresponder]', { outcome: result.outcome, ...result.logContext })

    return NextResponse.json(result.body, { status: result.httpStatus })
  } catch (err) {
    console.error('[webhook:autoresponder] fatal error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Webhook fatal error' }, { status: 500 })
  }
}

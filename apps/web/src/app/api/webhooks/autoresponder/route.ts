import { type NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import {
  handleAutoResponderWebhook,
  type AutoResponderWebhookDeps,
} from '@/lib/autoresponder-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEVICE_TOKEN_HEADER = 'x-reservanex-device-token'

// POST /api/webhooks/autoresponder
//
// Inbound endpoint for AutoResponder for WA's "Web Server" trigger, configured
// with a custom header (x-reservanex-device-token) instead of a URL secret —
// physically confirmed to work on the Android test device (Fase 4 audit).
//
// Auth identifies the tenant/account by DEVICE TOKEN — never by the message
// sender's phone/name (see apps/web/src/lib/autoresponder-webhook.ts).
//
// Always responds fast with {"replies":[]} once the event is queued (or
// deliberately ignored — group, unresolved sender, package mismatch) — the
// DeepSeek agent runs asynchronously in the worker via the existing
// message_queue pipeline, exactly like Meta's webhook already does.
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

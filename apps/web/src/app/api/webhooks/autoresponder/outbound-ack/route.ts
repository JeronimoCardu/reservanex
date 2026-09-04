import { type NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { hashDeviceToken } from '@/lib/autoresponder-webhook'
import { isValidOutboxId } from '@/lib/autoresponder-outbound-ack'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEVICE_TOKEN_HEADER = 'x-reservanex-device-token'
const OUTBOX_ID_HEADER    = 'x-reservanex-outbox-id'

// POST /api/webhooks/autoresponder/outbound-ack
//
// Fase 8 "outbound ACK" — physical confirmation from the MacroDroid macro
// that it ran WhatsApp Send for a specific dispatched messaging_outbox item.
// No body required or read — everything travels in headers, same wire
// convention as the heartbeat/media webhooks. Fired by the SAME macro that
// handles rn_action=outbound, immediately AFTER the WhatsApp Send action —
// never reuses the media endpoint or rn_event_id (those belong to a
// different, unrelated flow).
//
// HONESTY CONTRACT: a successful call here means "MacroDroid physically ran
// past WhatsApp Send" — it is NOT a WhatsApp delivery or read receipt, and
// none exists in this architecture. See apps/web/src/lib/outbound-status.ts
// for the full disclaimer and the derived CRM display states this feeds.
//
// Auth identifies the account ENTIRELY by device token — never by any
// tenant id/name in the request (there is none to receive). Ownership of
// the outbox item is re-verified against that resolved account on every
// call; a token from tenant A can never ACK an item belonging to tenant B —
// the lookup itself is scoped by account_id, so a cross-account id is
// indistinguishable in the response from one that doesn't exist at all.
export async function POST(req: NextRequest) {
  try {
    const deviceTokenHeader = req.headers.get(DEVICE_TOKEN_HEADER)
    const outboxIdHeader    = req.headers.get(OUTBOX_ID_HEADER)

    if (!deviceTokenHeader || !deviceTokenHeader.trim()) {
      return NextResponse.json({ error: 'Missing device token' }, { status: 401 })
    }
    // Reject a non-UUID id BEFORE it ever reaches a query against
    // messaging_outbox.id (a UUID column) — see isValidOutboxId's doc
    // comment (same reasoning as the media webhook's event id check).
    if (!isValidOutboxId(outboxIdHeader)) {
      return NextResponse.json({ error: 'Missing or invalid outbox id' }, { status: 400 })
    }

    const admin = createAdminClient()

    // 1. Authenticate — same hash scheme as every other AutoResponder webhook.
    const tokenHash = hashDeviceToken(deviceTokenHeader)
    const { data: account, error: acctErr } = await admin
      .from('whatsapp_accounts')
      .select('id, tenant_id, active')
      .eq('provider', 'autoresponder')
      .eq('inbound_token_hash', tokenHash)
      .maybeSingle()

    if (acctErr) {
      console.error('[webhook:autoresponder:outbound-ack] account lookup error', { code: acctErr.code })
      return NextResponse.json({ error: 'Invalid device token' }, { status: 401 })
    }
    if (!account || !account.active) {
      return NextResponse.json({ error: 'Invalid device token' }, { status: 401 })
    }

    // 2. Resolve the outbox item — MUST belong to THIS account. Filtering by
    // account_id in the same query means a cross-account/cross-tenant id and
    // a genuinely nonexistent one produce the exact same response — never
    // an oracle for probing other tenants' ids.
    const { data: item, error: itemErr } = await admin
      .from('messaging_outbox')
      .select('id, account_id, dispatched_at, device_ack_at')
      .eq('id', outboxIdHeader)
      .eq('account_id', account.id)
      .maybeSingle()

    if (itemErr) {
      console.error('[webhook:autoresponder:outbound-ack] outbox lookup error', { code: itemErr.code })
      return NextResponse.json({ error: 'Outbox lookup failed' }, { status: 500 })
    }
    if (!item) {
      return NextResponse.json({ error: 'Outbox item not found' }, { status: 404 })
    }
    // An ACK only makes sense for something we actually dispatched — a
    // never-dispatched item being ACKed means something is wired wrong on
    // the macro side; reject it rather than silently accepting.
    if (!item.dispatched_at) {
      console.warn('[webhook:autoresponder:outbound-ack] ACK for an item that was never dispatched', { outboxId: item.id })
      return NextResponse.json({ error: 'Outbox item was not dispatched' }, { status: 409 })
    }

    // 3. First-ACK-wins — atomic, single round trip: only a row where
    // device_ack_at IS STILL NULL gets updated, so a duplicate/retried ACK
    // for the same item can never race past this and overwrite the original
    // physical confirmation timestamp with a later one (Fase 8 §6).
    const nowIso = new Date().toISOString()
    const { data: firstAck } = await admin
      .from('messaging_outbox')
      .update({ device_ack_at: nowIso })
      .eq('id', item.id)
      .eq('account_id', account.id)
      .is('device_ack_at', null)
      .select('id')
      .maybeSingle()

    // 4. Health — a valid ACK is direct physical evidence the Android is
    // alive right now (unlike the trigger-cloud's own 200 OK at dispatch
    // time, which only proves the relay is up — see dispatcher.ts's doc
    // comment). last_device_seen_at is updated on every valid ACK, first or
    // repeat; last_outbound_device_ack_at only on the first (it mirrors
    // device_ack_at's own "preserve the first confirmation" semantics).
    // Best-effort — never allowed to fail the ACK response itself.
    const { error: healthErr } = await admin
      .from('whatsapp_accounts')
      .update({
        last_device_seen_at: nowIso,
        ...(firstAck ? { last_outbound_device_ack_at: nowIso } : {}),
      })
      .eq('id', account.id)
    if (healthErr) {
      console.warn('[webhook:autoresponder:outbound-ack] health update failed (non-fatal)', { code: healthErr.code })
    }

    console.log('[webhook:autoresponder:outbound-ack]', {
      outboxId: item.id, accountId: account.id, tenantId: account.tenant_id, firstAck: Boolean(firstAck),
    })

    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    console.error('[webhook:autoresponder:outbound-ack] fatal error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Webhook fatal error' }, { status: 500 })
  }
}

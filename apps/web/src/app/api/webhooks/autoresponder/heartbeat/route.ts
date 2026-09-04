import { type NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { hashDeviceToken } from '@/lib/autoresponder-webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEVICE_TOKEN_HEADER = 'x-reservanex-device-token'

// POST /api/webhooks/autoresponder/heartbeat
//
// Fase 7 Parte A — a small, independent signal endpoint for a SEPARATE
// MacroDroid macro ("ReservaNex - Heartbeat", fired on a periodic interval —
// see the Fase 7 report for the exact physical configuration). No body
// required or read. Reuses the EXACT SAME device-token auth scheme as the
// inbound/media webhooks (SHA-256 hash lookup) — no new credential is
// introduced.
//
// The account is resolved ENTIRELY from the token — never from a body or
// query param — so there is no way for one account to update another
// account's health by supplying a different id (Fase 7 report §17).
//
// Never returns tenant data, the webhook URL, the token/hash, or any other
// configuration — the only possible responses are {ok:true} or a generic
// error.
export async function POST(req: NextRequest) {
  try {
    const deviceTokenHeader = req.headers.get(DEVICE_TOKEN_HEADER)

    if (!deviceTokenHeader || !deviceTokenHeader.trim()) {
      return NextResponse.json({ error: 'Missing device token' }, { status: 401 })
    }

    const admin = createAdminClient()
    const tokenHash = hashDeviceToken(deviceTokenHeader)

    const { data: account, error: acctErr } = await admin
      .from('whatsapp_accounts')
      .select('id, active')
      .eq('provider', 'autoresponder')
      .eq('inbound_token_hash', tokenHash)
      .maybeSingle()

    if (acctErr) {
      console.error('[webhook:autoresponder:heartbeat] account lookup error', { code: acctErr.code })
      return NextResponse.json({ error: 'Invalid device token' }, { status: 401 })
    }
    if (!account || !account.active) {
      return NextResponse.json({ error: 'Invalid device token' }, { status: 401 })
    }

    const { error: updateErr } = await admin
      .from('whatsapp_accounts')
      .update({ last_device_seen_at: new Date().toISOString() })
      .eq('id', account.id)

    if (updateErr) {
      console.error('[webhook:autoresponder:heartbeat] update error', { code: updateErr.code })
      return NextResponse.json({ error: 'Heartbeat update failed' }, { status: 500 })
    }

    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    console.error('[webhook:autoresponder:heartbeat] fatal error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Webhook fatal error' }, { status: 500 })
  }
}

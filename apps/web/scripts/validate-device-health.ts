/**
 * Fase 7 Parte A integration validation: exercises
 * POST /api/webhooks/autoresponder/heartbeat and the health-tracking side
 * effects of POST /api/webhooks/autoresponder, directly against the real
 * linked Supabase project (el destino lo impone assert-safe-target.ts,
 * no este comentario) — no running Next.js
 * server needed, same technique as validate-media-upload.ts.
 *
 * Complements the offline Vitest suites (autoresponder-device-health.test.ts
 * for pure status derivation, heartbeat/route.test.ts for mocked auth
 * logic) with what genuinely needs a real DB: cross-endpoint health
 * propagation and cross-account/cross-provider isolation.
 *
 * Usage:  pnpm --filter @orderflow/web validate:device-health
 * Env:    DEMO_TENANT_ID (required — same demo tenant used elsewhere)
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { NextRequest } from 'next/server'
import { randomBytes, createHash } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { POST as heartbeat } from '../src/app/api/webhooks/autoresponder/heartbeat/route'
import { POST as inboundWebhook } from '../src/app/api/webhooks/autoresponder/route'

const HR   = '─'.repeat(78)
const PASS = '  ✓'
const FAIL = '  ✗'

let passed = 0
let failed = 0
function ok(label: string): void { console.log(`${PASS} ${label}`); passed++ }
function nok(label: string, detail?: string): void {
  console.error(`${FAIL} ${label}`)
  if (detail) console.error(`       ${detail}`)
  failed++
}

function hashDeviceToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

const HEARTBEAT_URL = 'http://127.0.0.1/api/webhooks/autoresponder/heartbeat'
const INBOUND_URL    = 'http://127.0.0.1/api/webhooks/autoresponder'

function buildHeartbeatRequest(token: string | null): NextRequest {
  const headers = new Headers()
  if (token !== null) headers.set('x-reservanex-device-token', token)
  return new NextRequest(HEARTBEAT_URL, { method: 'POST', headers })
}

function buildInboundRequest(token: string, sender: string, message: string, isGroup = false): NextRequest {
  const headers = new Headers({ 'x-reservanex-device-token': token, 'content-type': 'application/json' })
  const body = JSON.stringify({
    appPackageName:       'tkstudio.autoresponderforwa',
    messengerPackageName: 'com.whatsapp.w4b',
    query: { sender, message, isGroup, groupParticipant: '', ruleId: 1, isTestMessage: false },
  })
  return new NextRequest(INBOUND_URL, { method: 'POST', headers, body })
}

const recentEnough = (iso: string | null | undefined, withinMs = 60_000) =>
  !!iso && Date.now() - new Date(iso).getTime() < withinMs

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Device Health Validation (heartbeat + inbound, real Supabase)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const tenantId = process.env.DEMO_TENANT_ID ?? ''
  if (!tenantId) {
    nok('Tenant resolution', 'DEMO_TENANT_ID is required.')
    process.exitCode = 1
    return
  }

  const supabase = createAdminClient()
  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('id', tenantId).maybeSingle()
  if (!tenant) {
    nok('Tenant resolution', `DEMO_TENANT_ID=${tenantId} does not exist.`)
    process.exitCode = 1
    return
  }
  console.log(`  tenant: ${tenantId} (${tenant.name})\n`)

  const createdAccountIds: string[] = []
  const createdQueueIds:   string[] = []

  function nextPhone(base: number): string {
    return '549' + String(base + Math.floor(Math.random() * 999_999)).padStart(10, '0')
  }

  try {
    // ── Setup: active AutoResponder account, inactive AutoResponder
    //    account, and a Meta account (provider isolation) ──────────────────
    const rawToken = randomBytes(24).toString('hex')
    const { data: account, error: acctErr } = await supabase.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: nextPhone(3_800_000_000),
      inbound_token_hash: hashDeviceToken(rawToken), macrodroid_webhook_url: 'https://example.org/unused', active: true,
    }).select('id').single()
    if (acctErr || !account) { nok('Setup: account', acctErr?.message ?? 'no data'); throw new Error('cannot continue') }
    createdAccountIds.push(account.id)

    const inactiveRawToken = randomBytes(24).toString('hex')
    const { data: inactiveAccount } = await supabase.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: nextPhone(3_810_000_000),
      inbound_token_hash: hashDeviceToken(inactiveRawToken), macrodroid_webhook_url: 'https://example.org/unused2', active: false,
    }).select('id').single()
    if (inactiveAccount) createdAccountIds.push(inactiveAccount.id)

    const metaRawToken = randomBytes(24).toString('hex')
    const { data: metaAccount } = await supabase.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'meta', phone_number: nextPhone(3_820_000_000),
      business_account_id: `test-baid-${Date.now()}`, access_token_encrypted: 'unused', webhook_secret: 'unused',
      inbound_token_hash: hashDeviceToken(metaRawToken), active: true,
    }).select('id').single()
    if (metaAccount) createdAccountIds.push(metaAccount.id)

    ok('Setup: active account, inactive account, Meta account (provider isolation) created')

    // ── Heartbeat: auth/isolation ─────────────────────────────────────────
    {
      const res = await heartbeat(buildHeartbeatRequest(null))
      if (res.status === 401) ok('1. Heartbeat: no token → 401'); else nok('1. no token', `status=${res.status}`)
    }
    {
      const res = await heartbeat(buildHeartbeatRequest('totally-wrong-token'))
      if (res.status === 401) ok('2. Heartbeat: incorrect token → 401'); else nok('2. wrong token', `status=${res.status}`)
    }
    if (inactiveAccount) {
      const res = await heartbeat(buildHeartbeatRequest(inactiveRawToken))
      if (res.status === 401) ok('4. Heartbeat: inactive account → 401'); else nok('4. inactive account', `status=${res.status}`)
    }
    if (metaAccount) {
      const res = await heartbeat(buildHeartbeatRequest(metaRawToken))
      if (res.status === 401) {
        ok('5. Heartbeat: a token belonging to a Meta-provider account is rejected — provider=autoresponder is enforced in the lookup')
      } else {
        nok('5. Meta provider isolation', `status=${res.status}`)
      }
    }
    {
      const res = await heartbeat(buildHeartbeatRequest(rawToken))
      const body = await res.json() as { ok?: boolean }
      const { data: after } = await supabase.from('whatsapp_accounts').select('last_device_seen_at').eq('id', account.id).single()
      if (res.status === 200 && body.ok && recentEnough(after?.last_device_seen_at)) {
        ok('6. Heartbeat: valid token → 200 {ok:true}, last_device_seen_at updated')
      } else {
        nok('6. valid heartbeat', `status=${res.status}, body=${JSON.stringify(body)}, after=${JSON.stringify(after)}`)
      }
    }
    if (inactiveAccount) {
      const { data: untouched } = await supabase.from('whatsapp_accounts').select('last_device_seen_at').eq('id', inactiveAccount.id).single()
      if (!untouched?.last_device_seen_at) {
        ok('7. Heartbeat never modifies another account\'s health')
      } else {
        nok('7. cross-account isolation', JSON.stringify(untouched))
      }
    }
    {
      const res = await heartbeat(buildHeartbeatRequest(rawToken))
      const body = await res.json() as Record<string, unknown>
      if (Object.keys(body).length === 1 && 'ok' in body) {
        ok('8. Heartbeat response never contains secrets — only {ok:true}')
      } else {
        nok('8. response shape', JSON.stringify(body))
      }
    }

    // ── Inbound webhook: authenticated request updates health ────────────
    {
      const sender = nextPhone(3_830_000_000)
      const res = await inboundWebhook(buildInboundRequest(rawToken, sender, 'hola, quiero info'))
      const body = await res.json() as { replies?: unknown[] }

      // Track the resulting queue row for cleanup (best-effort lookup by
      // whatsapp_account_id + recency — the route generates its own id).
      const { data: queueRows } = await supabase
        .from('message_queue').select('id').eq('whatsapp_account_id', account.id)
        .order('created_at', { ascending: false }).limit(1)
      if (queueRows?.[0]) createdQueueIds.push(queueRows[0].id)

      const { data: after } = await supabase
        .from('whatsapp_accounts').select('last_device_seen_at, last_inbound_at').eq('id', account.id).single()

      if (res.status === 200 && Array.isArray(body.replies)) {
        ok('9a. Inbound webhook: valid authenticated request → 200 {replies:[]}')
      } else {
        nok('9a. inbound accepted', `status=${res.status}, body=${JSON.stringify(body)}`)
      }
      if (recentEnough(after?.last_inbound_at)) {
        ok('9. Inbound webhook: a valid authenticated inbound updates last_inbound_at')
      } else {
        nok('9. last_inbound_at update', JSON.stringify(after))
      }
      if (recentEnough(after?.last_device_seen_at)) {
        ok('10. Inbound webhook: a valid authenticated inbound ALSO updates last_device_seen_at')
      } else {
        nok('10. last_device_seen_at update', JSON.stringify(after))
      }
    }

    // ── An authenticated-but-ignored outcome (group message) still proves
    //    the device is alive — health updates regardless of the specific
    //    outcome, as long as auth succeeded. ───────────────────────────────
    {
      const sender = nextPhone(3_840_000_000)
      await supabase.from('whatsapp_accounts').update({ last_device_seen_at: null, last_inbound_at: null }).eq('id', account.id)
      const res = await inboundWebhook(buildInboundRequest(rawToken, sender, 'hola desde un grupo', true))
      const body = await res.json() as { replies?: unknown[] }
      const { data: after } = await supabase
        .from('whatsapp_accounts').select('last_device_seen_at, last_inbound_at').eq('id', account.id).single()

      if (res.status === 200 && Array.isArray(body.replies) && recentEnough(after?.last_device_seen_at) && recentEnough(after?.last_inbound_at)) {
        ok('An authenticated group-ignored request still updates health — auth is what matters, not the specific outcome')
      } else {
        nok('Authenticated-but-ignored health update', `status=${res.status}, after=${JSON.stringify(after)}`)
      }
    }

  } finally {
    if (createdQueueIds.length)   await supabase.from('message_queue').delete().in('id', createdQueueIds)
    if (createdAccountIds.length) await supabase.from('whatsapp_accounts').delete().in('id', createdAccountIds)
  }

  console.log(`\n${HR}`)
  console.log(`  Result: ${passed} passed, ${failed} failed`)
  console.log(HR)

  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n  [validate-device-health] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

/**
 * Fase 8 "outbound ACK" integration validation: exercises
 * POST /api/webhooks/autoresponder/outbound-ack directly against the real
 * linked Supabase project (akvaswvkdqfguksinrwa) — no running Next.js
 * server needed, same technique as validate-device-health.ts and
 * validate-purge-tenant.ts. Complements the mocked route.test.ts (auth/
 * shape logic) and the pure outbound-status.test.ts (derivation logic)
 * with what genuinely needs a real DB: real UPDATE ... WHERE device_ack_at
 * IS NULL race-free idempotency, real cross-tenant RLS-independent
 * ownership checks, and the real getOutboundTrackingForMessages()
 * repository path (admin client, not the anon/session client — see that
 * function's own comment for why messaging_outbox specifically requires it).
 *
 * Builds its OWN two brand-new, isolated tenants (A, B) — never the demo or
 * physical tenant. Full cleanup in `finally`, including the one auth user
 * created to exercise a source='human' outbound message.
 *
 * Usage:  pnpm --filter @orderflow/web validate:outbound-ack
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { NextRequest } from 'next/server'
import { randomBytes, randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { hashDeviceToken } from '../src/lib/autoresponder-webhook'
import { POST as outboundAck } from '../src/app/api/webhooks/autoresponder/outbound-ack/route'
import { getOutboundTrackingForMessages } from '../src/lib/repositories/messages.repository'
import {
  deriveOutboundDisplayStatus,
  ACK_PROTOCOL_INTRODUCED_AT,
  OUTBOUND_UNCONFIRMED_THRESHOLD_MS,
} from '../src/lib/outbound-status'

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

const ACK_URL = 'http://127.0.0.1/api/webhooks/autoresponder/outbound-ack'

function buildAckRequest(token: string | null, outboxId: string | null): NextRequest {
  const headers = new Headers()
  if (token !== null)    headers.set('x-reservanex-device-token', token)
  if (outboxId !== null) headers.set('x-reservanex-outbox-id', outboxId)
  return new NextRequest(ACK_URL, { method: 'POST', headers })
}

function nextPhone(base: number): string {
  return '549' + String(base + Math.floor(Math.random() * 999_999)).padStart(10, '0')
}

const recentEnough = (iso: string | null | undefined, withinMs = 60_000) =>
  !!iso && Date.now() - new Date(iso).getTime() < withinMs

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Outbound ACK Validation (Fase 8, real Supabase)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const admin = createAdminClient()
  const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  console.log(`  run: ${RUN_ID}\n`)

  const tenantIds:   string[] = []
  const authUserIds: string[] = []

  type TenantFixture = {
    tenantId:       string
    accountId:      string
    rawToken:       string
    conversationId: string
    contactPhone:   string
  }

  async function buildTenant(label: string, phoneBase: number): Promise<TenantFixture> {
    const { data: tenant, error: tErr } = await admin.from('tenants').insert({
      name: `[TEST] OutboundAck ${label} ${RUN_ID}`,
      slug: `test-outbound-ack-${label.toLowerCase()}-${RUN_ID}`,
      status: 'active',
    }).select('id').single()
    if (tErr || !tenant) throw new Error(`tenant insert failed: ${tErr?.message}`)
    tenantIds.push(tenant.id)

    const rawToken  = randomBytes(24).toString('hex')
    const { data: account, error: aErr } = await admin.from('whatsapp_accounts').insert({
      tenant_id: tenant.id, provider: 'autoresponder', phone_number: nextPhone(phoneBase),
      inbound_token_hash: hashDeviceToken(rawToken), macrodroid_webhook_url: 'https://example.org/outbound-ack-test', active: true,
    }).select('id').single()
    if (aErr || !account) throw new Error(`whatsapp_accounts insert failed: ${aErr?.message}`)

    const contactPhone = nextPhone(phoneBase + 1_000_000)
    const { data: contact, error: cErr } = await admin.from('contacts').insert({
      tenant_id: tenant.id, phone: contactPhone, name: `Contact ${label}`,
    }).select('id').single()
    if (cErr || !contact) throw new Error(`contacts insert failed: ${cErr?.message}`)

    const { data: conversation, error: convErr } = await admin.from('conversations').insert({
      tenant_id: tenant.id, contact_id: contact.id, whatsapp_account_id: account.id,
    }).select('id').single()
    if (convErr || !conversation) throw new Error(`conversations insert failed: ${convErr?.message}`)

    return { tenantId: tenant.id, accountId: account.id, rawToken, conversationId: conversation.id, contactPhone }
  }

  // source='human' requires a real tenant_users row (FK to auth.users) —
  // built once, reused for the one human-outbound fixture message.
  async function createHumanSenderId(tenantId: string, label: string): Promise<string> {
    const email = `agent-outbound-ack-${label}-${RUN_ID}@example.test`
    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email, password: randomBytes(18).toString('hex'), email_confirm: true,
    })
    if (authErr || !authUser.user) throw new Error(`createUser failed: ${authErr?.message}`)
    authUserIds.push(authUser.user.id)
    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: authUser.user.id, tenant_id: tenantId, name: `Agent ${label}`, email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users insert failed: ${tuErr.message}`)
    return authUser.user.id
  }

  async function insertOutboxItem(params: {
    tenantId:       string
    accountId:      string
    conversationId: string
    phone:          string
    source:         'ai' | 'human'
    senderId?:      string | null
    status:         'pending' | 'dispatched' | 'failed'
    dispatchedAt:   string | null
  }): Promise<{ messageId: string; outboxId: string }> {
    const { data: message, error: mErr } = await admin.from('messages').insert({
      tenant_id: params.tenantId, conversation_id: params.conversationId,
      sender_type: params.source === 'human' ? 'human' : 'ai',
      sender_id: params.source === 'human' ? (params.senderId ?? null) : null,
      content: `outbound test ${RUN_ID}`,
    }).select('id').single()
    if (mErr || !message) throw new Error(`messages insert failed: ${mErr?.message}`)

    const { data: outbox, error: oErr } = await admin.from('messaging_outbox').insert({
      tenant_id: params.tenantId, account_id: params.accountId, conversation_id: params.conversationId,
      message_id: message.id, destination_phone: params.phone, text: 'hola', provider: 'autoresponder',
      source: params.source, status: params.status, dispatched_at: params.dispatchedAt,
    }).select('id').single()
    if (oErr || !outbox) throw new Error(`messaging_outbox insert failed: ${oErr?.message}`)

    return { messageId: message.id, outboxId: outbox.id }
  }

  async function fetchOutbox(outboxId: string) {
    const { data } = await admin.from('messaging_outbox')
      .select('status, dispatched_at, device_ack_at').eq('id', outboxId).single()
    return data
  }

  try {
    const A = await buildTenant('A', 3_900_000_000)
    const B = await buildTenant('B', 3_910_000_000)
    ok('Setup: two isolated tenants (A, B), each with an active AutoResponder account')

    // ── §17 multitenant + §18 endpoint tests ──────────────────────────────
    const outboxA = await insertOutboxItem({
      tenantId: A.tenantId, accountId: A.accountId, conversationId: A.conversationId, phone: A.contactPhone,
      source: 'ai', status: 'dispatched', dispatchedAt: new Date().toISOString(),
    })

    {
      const res = await outboundAck(buildAckRequest(null, outboxA.outboxId))
      if (res.status === 401) ok('1. Missing token → 401'); else nok('1. missing token', `status=${res.status}`)
    }
    {
      const res = await outboundAck(buildAckRequest('totally-wrong-token', outboxA.outboxId))
      if (res.status === 401) ok('2. Invalid/unrecognized token → 401'); else nok('2. invalid token', `status=${res.status}`)
    }
    {
      const res = await outboundAck(buildAckRequest(A.rawToken, null))
      if (res.status === 400) ok('3. Missing outbox id → 400'); else nok('3. missing outbox id', `status=${res.status}`)
    }
    {
      const res = await outboundAck(buildAckRequest(A.rawToken, 'not-a-uuid'))
      if (res.status === 400) ok('4. Invalid (non-UUID) outbox id → 400, before any DB call'); else nok('4. invalid uuid', `status=${res.status}`)
    }
    {
      const res  = await outboundAck(buildAckRequest(A.rawToken, randomUUID()))
      const body = await res.json() as Record<string, unknown>
      const leaks = JSON.stringify(body).match(/tenant|account_id/i)
      if (res.status === 404 && !leaks) ok('5. Nonexistent (valid-format) outbox id → 404, no cross-tenant info leaked'); else nok('5. nonexistent outbox', `status=${res.status} body=${JSON.stringify(body)}`)
    }
    {
      // Token B authenticates account B; outboxA belongs to account A. The
      // lookup is scoped by account_id, so this must be indistinguishable
      // from a genuinely nonexistent id — same 404, never a 403/other signal.
      const res = await outboundAck(buildAckRequest(B.rawToken, outboxA.outboxId))
      if (res.status === 404) ok('6. Cross-account: token B cannot ACK an outbox belonging to account A → 404 (same as nonexistent)'); else nok('6. cross-account rejection', `status=${res.status}`)
    }

    const outboxPending = await insertOutboxItem({
      tenantId: A.tenantId, accountId: A.accountId, conversationId: A.conversationId, phone: A.contactPhone,
      source: 'ai', status: 'pending', dispatchedAt: null,
    })
    {
      const res = await outboundAck(buildAckRequest(A.rawToken, outboxPending.outboxId))
      if (res.status === 409) ok('11. An outbox item that was never dispatched → 409, not accepted as a valid ACK'); else nok('11. never-dispatched rejection', `status=${res.status}`)
    }

    {
      const res  = await outboundAck(buildAckRequest(A.rawToken, outboxA.outboxId))
      const body = await res.json() as { ok?: boolean }
      const row  = await fetchOutbox(outboxA.outboxId)
      if (res.status === 200 && body.ok && recentEnough(row?.device_ack_at)) {
        ok('7. Valid dispatched outbox + matching token → 200, device_ack_at set')
      } else {
        nok('7. valid ACK', `status=${res.status} body=${JSON.stringify(body)} row=${JSON.stringify(row)}`)
      }
    }
    const firstAckAt = (await fetchOutbox(outboxA.outboxId))?.device_ack_at ?? null
    {
      // Repeat ACK — must still return 200, but the conditional
      // UPDATE ... WHERE device_ack_at IS NULL must not fire a second time,
      // so the original physical confirmation timestamp is preserved.
      const res = await outboundAck(buildAckRequest(A.rawToken, outboxA.outboxId))
      const row  = await fetchOutbox(outboxA.outboxId)
      if (res.status === 200 && row?.device_ack_at === firstAckAt) {
        ok('8/12. A second ACK on an already-acked item → still 200, device_ack_at unchanged (first timestamp preserved)')
      } else {
        nok('8/12. idempotent re-ACK', `status=${res.status} first=${firstAckAt} now=${row?.device_ack_at}`)
      }
    }
    {
      const { data: acct } = await admin.from('whatsapp_accounts')
        .select('last_device_seen_at, last_outbound_device_ack_at').eq('id', A.accountId).single()
      if (recentEnough(acct?.last_device_seen_at) && recentEnough(acct?.last_outbound_device_ack_at)) {
        ok('9. A valid ACK updates whatsapp_accounts.last_device_seen_at AND last_outbound_device_ack_at')
      } else {
        nok('9. device-health side effects', JSON.stringify(acct))
      }
    }
    {
      // Repeat ACK from the block above already ran once more against A's
      // account — last_device_seen_at must have moved again (real evidence
      // of life on every valid ACK, first or repeat) while
      // last_outbound_device_ack_at must NOT have moved past firstAckAt.
      const { data: acct } = await admin.from('whatsapp_accounts')
        .select('last_outbound_device_ack_at').eq('id', A.accountId).single()
      if (acct?.last_outbound_device_ack_at === firstAckAt) {
        ok('A repeat ACK updates last_device_seen_at again but never moves last_outbound_device_ack_at past the first confirmation')
      } else {
        nok('repeat-ACK health timestamp stability', `first=${firstAckAt} now=${acct?.last_outbound_device_ack_at}`)
      }
    }
    {
      const { data: otherAcct } = await admin.from('whatsapp_accounts')
        .select('last_device_seen_at, last_outbound_device_ack_at').eq('id', B.accountId).single()
      if (!otherAcct?.last_device_seen_at && !otherAcct?.last_outbound_device_ack_at) {
        ok('10. Tenant B\'s account health is completely untouched by every ACK attempt against tenant A\'s outbox')
      } else {
        nok('10. cross-tenant health isolation', JSON.stringify(otherAcct))
      }
    }

    // ── Derived display status, against REAL fetched rows (not synthetic) ──
    {
      const row    = await fetchOutbox(outboxA.outboxId)
      const status = deriveOutboundDisplayStatus(row ? { status: row.status, dispatchedAt: row.dispatched_at, deviceAckAt: row.device_ack_at } : null)
      if (status === 'device_executed') ok('14. A real ACKed row derives to "device_executed"'); else nok('14. derived status after ACK', String(status))
    }
    {
      const oldDispatch = new Date(Date.now() - OUTBOUND_UNCONFIRMED_THRESHOLD_MS - 5_000).toISOString()
      const stale = await insertOutboxItem({
        tenantId: A.tenantId, accountId: A.accountId, conversationId: A.conversationId, phone: A.contactPhone,
        source: 'ai', status: 'dispatched', dispatchedAt: oldDispatch,
      })
      const row    = await fetchOutbox(stale.outboxId)
      const status = deriveOutboundDisplayStatus(row ? { status: row.status, dispatchedAt: row.dispatched_at, deviceAckAt: row.device_ack_at } : null)
      if (status === 'unconfirmed') ok('13. A real dispatched-past-threshold, never-ACKed row derives to "unconfirmed"'); else nok('13. derived unconfirmed', String(status))
    }
    {
      const preProtocol = new Date(new Date(ACK_PROTOCOL_INTRODUCED_AT).getTime() - 3_600_000).toISOString()
      const historical = await insertOutboxItem({
        tenantId: A.tenantId, accountId: A.accountId, conversationId: A.conversationId, phone: A.contactPhone,
        source: 'ai', status: 'dispatched', dispatchedAt: preProtocol,
      })
      const row    = await fetchOutbox(historical.outboxId)
      const status = deriveOutboundDisplayStatus(row ? { status: row.status, dispatchedAt: row.dispatched_at, deviceAckAt: row.device_ack_at } : null)
      if (status === 'dispatched_to_device') {
        ok('18. A real pre-protocol dispatched row never derives to "unconfirmed", even though it is far past the threshold now')
      } else {
        nok('18. historical pre-protocol handling', String(status))
      }
    }

    // ── §12/§16/§17 items 15-17 — shared tracking path (repository layer),
    //    both source='ai' and source='human' via the SAME function, and no
    //    entry at all for an inbound (customer) message ─────────────────────
    const humanSenderId = await createHumanSenderId(A.tenantId, 'A')
    const humanItem = await insertOutboxItem({
      tenantId: A.tenantId, accountId: A.accountId, conversationId: A.conversationId, phone: A.contactPhone,
      source: 'human', senderId: humanSenderId, status: 'dispatched', dispatchedAt: new Date().toISOString(),
    })
    await outboundAck(buildAckRequest(A.rawToken, humanItem.outboxId))

    const { data: customerMsg, error: custErr } = await admin.from('messages').insert({
      tenant_id: A.tenantId, conversation_id: A.conversationId, sender_type: 'customer', content: 'hola',
    }).select('id').single()
    if (custErr || !customerMsg) throw new Error(`customer message insert failed: ${custErr?.message}`)

    const tracking = await getOutboundTrackingForMessages(A.tenantId, [outboxA.messageId, humanItem.messageId, customerMsg.id])
    const aiTracked    = tracking[outboxA.messageId]
    const humanTracked = tracking[humanItem.messageId]
    if (aiTracked && humanTracked) {
      ok('16/17. getOutboundTrackingForMessages() returns a tracking row for BOTH source=ai and source=human via the exact same call — no duplicate implementation')
    } else {
      nok('16/17. shared ai/human tracking', JSON.stringify(tracking))
    }
    if (deriveOutboundDisplayStatus(humanTracked ?? null) === 'device_executed') {
      ok('17. A source=human outbound message, once ACKed, derives to "device_executed" through the exact same path as AI')
    } else {
      nok('17. human outbound derived status', JSON.stringify(humanTracked))
    }
    if (!(customerMsg.id in tracking)) {
      ok('15. An inbound (customer) message never has an entry in the outbound-tracking map — no outbound status to show')
    } else {
      nok('15. inbound message must have no outbound tracking entry', JSON.stringify(tracking[customerMsg.id]))
    }

    // Cross-tenant: tenant B must never see tenant A's outbound tracking,
    // even if (hypothetically) it guessed A's message ids.
    const crossTenantTracking = await getOutboundTrackingForMessages(B.tenantId, [outboxA.messageId, humanItem.messageId])
    if (Object.keys(crossTenantTracking).length === 0) {
      ok('getOutboundTrackingForMessages() is tenant-scoped — tenant B gets nothing for tenant A\'s message ids')
    } else {
      nok('cross-tenant tracking isolation', JSON.stringify(crossTenantTracking))
    }

  } finally {
    // Use the already-audited admin_purge_tenant() RPC rather than a
    // hand-rolled per-table delete loop — it's the single source of truth
    // for "every table a tenant can leave rows in" (including audit_logs,
    // which every ACK/webhook call and every fixture insert here writes to
    // via triggers, and which a manual delete loop would miss — exactly the
    // class of bug validate-purge-tenant.ts's own fix addressed earlier in
    // this project). Never touches any tenant outside this run's own ids.
    for (const tenantId of tenantIds) {
      const { error } = await admin.rpc('admin_purge_tenant', { p_tenant_id: tenantId })
      if (error) console.error(`       cleanup: admin_purge_tenant(${tenantId}) failed: ${error.message}`)
    }
    for (const uid of authUserIds) {
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
  }

  console.log(`\n${HR}`)
  console.log(`  Result: ${passed} passed, ${failed} failed`)
  console.log(HR)

  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n  [validate-outbound-ack] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

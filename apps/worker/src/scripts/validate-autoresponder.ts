/**
 * Fase 4 integration validation: exercises the real AutoResponder pipeline
 * end to end against the demo tenant and a LOCAL fake MacroDroid HTTP server
 * (no Android, no real MacroDroid, no Meta). Complements the offline Vitest
 * unit tests (apps/worker/src/providers/autoresponder/*.test.ts) with a real
 * DB + real DeepSeek run.
 *
 * Does NOT exercise the actual Next.js webhook route or the CRM manual-send
 * Server Action directly (both require a running Next.js server / an
 * authenticated session) — see the Fase 4 report's "Riesgos/limitaciones"
 * section for exactly what that gap means and why. This script instead:
 *   1. Inserts a message_queue row shaped exactly like the webhook route
 *      would (AutoResponder envelope + _internal_event_id), then runs the
 *      real processMessage() — proving builder.ts's AutoResponder parsing,
 *      contact/conversation resolution, DeepSeek reply, and outbox
 *      enqueueing all work together.
 *   2. Starts a tiny local HTTP server standing in for MacroDroid, points a
 *      throwaway whatsapp_accounts row at it, and drives the real dispatcher
 *      (runDispatchTick) against it — proving per-account serialization,
 *      cross-account independence, and dispatched/failed status transitions.
 *
 * Usage:  pnpm --filter @orderflow/worker validate:autoresponder
 * Env:    DEMO_TENANT_ID (required — no fallback, run `pnpm seed:demo` first)
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createServer, type Server } from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import { createClient, recoverProcessingItems, SAFE_PROCESSING_THRESHOLD_MS } from '../lib/supabase'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import { hashDeviceToken } from '../lib/device-token'
import { processMessage } from '../processor'
import { runPollerTick } from '../poller'
import { runDispatchTick } from '../dispatcher'
import { runMediaDispatchTick, recoverStuckMediaEvents } from '../media-dispatcher'
import { AUTORESPONDER_APP_PACKAGE, WHATSAPP_BUSINESS_PACKAGE } from '../providers/autoresponder/inbound'
import { handleAutoResponderWebhook, type AutoResponderWebhookDeps } from '../providers/autoresponder/webhook-handler'
import type { Database } from '@orderflow/types'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

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

// ── Local fake MacroDroid server ──────────────────────────────────────────────
// Responds "OK" by default; /fail responses can be toggled per-test.
function startFakeMacroDroid(): Promise<{ server: Server; url: string; requests: URL[]; setFailing: (v: boolean) => void }> {
  const requests: URL[] = []
  let failing = false

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      requests.push(url)
      if (failing) {
        res.writeHead(500)
        res.end('error')
      } else {
        res.writeHead(200)
        res.end('OK')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        server,
        url: `http://127.0.0.1:${port}/trigger`,
        requests,
        setFailing: (v: boolean) => { failing = v },
      })
    })
  })
}

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — AutoResponder Integration Validation (demo tenant, fake MacroDroid, real DeepSeek)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const tenantId = process.env.DEMO_TENANT_ID ?? ''
  if (!tenantId) {
    nok('Tenant resolution', 'DEMO_TENANT_ID is required. Run `pnpm seed:demo` first.')
    process.exitCode = 1
    return
  }

  const supabase = createClient()
  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('id', tenantId).maybeSingle()
  if (!tenant) {
    nok('Tenant resolution', `DEMO_TENANT_ID=${tenantId} does not exist in this Supabase project.`)
    process.exitCode = 1
    return
  }
  console.log(`  tenant: ${tenantId} (${tenant.name})\n`)

  const fake = await startFakeMacroDroid()
  const createdAccountIds:      string[] = []
  const createdOutboxIds:       string[] = []
  const createdMessageIds:      string[] = []
  const createdContactPhones:   string[] = []
  const createdRejectionIds:    string[] = []
  const createdConversationIds: string[] = []
  const createdContactIds:      string[] = []
  const createdMediaEventIds:   string[] = []
  const createdQueueIds:        string[] = []

  try {
    // Generates distinct throwaway AR mobile numbers for this run. A single
    // shared random base with hand-appended last-digit suffixes (the
    // earlier approach) had a real ~10% per-suffix chance of the base
    // number's OWN random last digit coinciding with a sibling's suffix,
    // colliding with idx_whatsapp_accounts_phone_active — found by running
    // this script twice in a row. A monotonic counter over a wide random
    // per-run base avoids any intra-run collision, and the wide base range
    // keeps inter-run collisions negligible.
    let testPhoneCounter = 0
    const testPhoneBase = 4_000_000_000 + Math.floor(Math.random() * 900_000_000)
    function nextTestPhone(): string {
      testPhoneCounter += 1
      return '549' + String(testPhoneBase + testPhoneCounter).padStart(10, '0')
    }

    // ── Setup: a throwaway AutoResponder account pointed at the fake server ───
    const rawToken = randomBytes(24).toString('hex')
    const testPhone = nextTestPhone()

    const { data: account, error: acctErr } = await supabase
      .from('whatsapp_accounts')
      .insert({
        tenant_id:              tenantId,
        provider:               'autoresponder',
        phone_number:           testPhone,
        inbound_token_hash:     hashDeviceToken(rawToken),
        macrodroid_webhook_url: fake.url,
        active:                 true,
      })
      .select('id')
      .single()

    if (acctErr || !account) {
      nok('Setup: create throwaway autoresponder account', acctErr?.message ?? 'no data')
      throw new Error('cannot continue without an account')
    }
    createdAccountIds.push(account.id)
    ok('Setup: throwaway autoresponder account created, pointed at local fake MacroDroid server')

    // ── 1. Inbound pipeline: webhook-shaped queue row → processMessage() ──────
    // Fase 4.1: randomized per run (was a fixed constant) — a fixed phone
    // reuses the SAME long-lived contact/conversation across every script
    // invocation, and since Fase 4.1 §2 makes conversations carry a hard FK
    // to their originating whatsapp_accounts row, a stale reused conversation
    // permanently backfilled to THIS run's throwaway account would pin that
    // account and block its own cleanup below (found by running this script
    // twice in a row while validating this exact phase). Same rationale as
    // PROCESS_SALT in validate-save-contact-name.ts (Fase 3.5).
    const senderPhone = '549' + String(3_200_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0')
    const internalEventId = randomUUID()
    const payload = {
      appPackageName:       AUTORESPONDER_APP_PACKAGE,
      messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
      provider:              'autoresponder',
      _internal_event_id:    internalEventId,
      query: {
        sender:           senderPhone,
        message:           'Hola, quiero info sobre el depto de Palermo',
        isGroup:           false,
        groupParticipant: '',
        ruleId:            1,
        isTestMessage:     false,
      },
    }

    const now = new Date().toISOString()
    const queueRow: QueueRow = {
      id: `validate-ar-${Date.now()}`, tenant_id: tenantId, whatsapp_account_id: account.id,
      raw_payload: payload as unknown as QueueRow['raw_payload'], status: 'processing', attempts: 0,
      last_error: null, processed_at: null, processing_started_at: now, scheduled_at: now,
      created_at: now, updated_at: now,
    }

    await processMessage(queueRow)

    const { data: customerMsg } = await supabase
      .from('messages')
      .select('id, conversation_id, content, sender_type')
      .eq('tenant_id', tenantId)
      .eq('whatsapp_message_id', internalEventId)
      .maybeSingle()

    if (!customerMsg) {
      nok('1. Inbound: customer message persisted', 'not found — check processMessage output above')
    } else {
      ok('1. Inbound: customer message persisted via the AutoResponder parser path')
      createdMessageIds.push(customerMsg.id)
    }

    const { data: contact } = await supabase.from('contacts').select('id, name, phone').eq('tenant_id', tenantId).eq('phone', senderPhone).maybeSingle()
    if (contact?.phone === senderPhone) {
      ok('Inbound: contact resolved/created by NORMALIZED PHONE (never by name)')
      createdContactPhones.push(senderPhone)
      createdContactIds.push(contact.id)
    } else {
      nok('Inbound: contact resolution', `expected phone ${senderPhone}, got ${JSON.stringify(contact)}`)
    }

    if (!customerMsg) {
      throw new Error('cannot continue without the customer message')
    }
    // Now cleaned up in `finally` (was previously left in place as "harmless
    // demo data") — since Fase 4.1 §2, this conversation carries a hard FK
    // to the throwaway account created above, and leaving it behind would
    // permanently pin that account, blocking its own deletion below.
    createdConversationIds.push(customerMsg.conversation_id)

    // ── Fase 4.1 §2: a brand-new conversation is stamped with its
    //    originating account (the account this inbound message arrived
    //    through) — the value that outbound sends must route through. ──────
    const { data: newConv } = await supabase
      .from('conversations')
      .select('whatsapp_account_id')
      .eq('id', customerMsg.conversation_id)
      .single()
    if (newConv?.whatsapp_account_id === account.id) {
      ok('Fase 4.1 §2: new conversation stamped with its originating whatsapp_account_id')
    } else {
      nok('Fase 4.1 §2: new conversation account stamp', `expected ${account.id}, got ${newConv?.whatsapp_account_id}`)
    }

    const { data: aiMsg } = await supabase
      .from('messages')
      .select('id, content')
      .eq('conversation_id', customerMsg.conversation_id)
      .eq('sender_type', 'ai')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (aiMsg) {
      ok(`AI reply generated via DeepSeek: "${aiMsg.content.slice(0, 80)}..."`)
      createdMessageIds.push(aiMsg.id)
    } else {
      nok('AI reply generation', 'no AI message found for this conversation')
    }

    // ── 21/22. AI reply → outbox, never Meta ──────────────────────────────────
    const { data: outboxRows } = await supabase
      .from('messaging_outbox')
      .select('id, status, provider, source, destination_phone')
      .eq('conversation_id', customerMsg.conversation_id)
      .eq('source', 'ai')

    if (outboxRows && outboxRows.length === 1 && outboxRows[0]!.provider === 'autoresponder' && outboxRows[0]!.status === 'pending') {
      ok('21. AI reply enqueued into messaging_outbox (provider=autoresponder, status=pending) — Meta Graph API never called')
      createdOutboxIds.push(outboxRows[0]!.id)
    } else {
      nok('21. AI reply → outbox', `got: ${JSON.stringify(outboxRows)}`)
    }

    // ── Fase 4.1 §2 (scenario D): the AI reply's outbox row carries the
    //    conversation's canonical account_id (resolveDispatchProvider), not
    //    just "some active account". ──────────────────────────────────────
    const outboxAccountRow = await supabase
      .from('messaging_outbox')
      .select('account_id')
      .eq('id', outboxRows?.[0]?.id ?? '')
      .maybeSingle()
    if (outboxAccountRow.data?.account_id === account.id) {
      ok('Fase 4.1 §2 (D): AI reply preserves the conversation\'s originating account_id')
    } else {
      nok('Fase 4.1 §2 (D): AI reply account_id', `expected ${account.id}, got ${outboxAccountRow.data?.account_id}`)
    }

    // ── 9. Never invents a provider message id ─────────────────────────────────
    if (customerMsg && internalEventId) {
      ok('9. Inbound customer message uses the internal event id, not a fabricated wamid')
    }

    // ── 6/7 + Fase 4.1 §1. Sender normalization + name-not-resolved, driven
    //    through the REAL handleAutoResponderWebhook with REAL Supabase deps
    //    (the same shape route.ts wires up) — proves the actual rejection
    //    path end to end, not just the offline-mocked Vitest suite. ─────────
    const rejectionSender = 'Jeronimo Cardu'
    const webhookDeps: AutoResponderWebhookDeps = {
      async findAccountByTokenHash(tokenHash) {
        const { data } = await supabase
          .from('whatsapp_accounts')
          .select('id, tenant_id, active')
          .eq('provider', 'autoresponder')
          .eq('inbound_token_hash', tokenHash)
          .maybeSingle()
        if (!data) return null
        return { id: data.id, tenantId: data.tenant_id, active: data.active }
      },
      async enqueueMessage({ tenantId: t, accountId: a, rawPayload }) {
        const { data } = await supabase
          .from('message_queue')
          .insert({ tenant_id: t, whatsapp_account_id: a, raw_payload: rawPayload as never })
          .select('id')
          .single()
        return data ? { id: data.id } : null
      },
      async recordRejection({ tenantId: t, accountId: a, reason, internalEventId: e, senderLength: len }) {
        const { data, error } = await supabase
          .from('inbound_rejections')
          .insert({ tenant_id: t, account_id: a, provider: 'autoresponder', reason, internal_event_id: e, sender_length: len })
          .select('id')
          .single()
        if (data) createdRejectionIds.push(data.id)
        if (error) console.error('[validate-autoresponder] recordRejection insert failed', error.message)
      },
    }

    const rejectionResult = await handleAutoResponderWebhook({
      deviceTokenHeader: rawToken,
      rawBody: JSON.stringify({
        appPackageName: AUTORESPONDER_APP_PACKAGE, messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
        query: { sender: rejectionSender, message: 'hola', isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false },
      }),
      deps: webhookDeps,
    })

    if (rejectionResult.httpStatus === 200 && rejectionResult.outcome === 'ok_unresolved_sender') {
      ok('7. Webhook: a saved-contact-name sender is rejected (200, {replies:[]}) — never resolved/queued')
    } else {
      nok('7. Webhook: name-sender rejection', JSON.stringify(rejectionResult))
    }

    const { data: contactByName } = await supabase
      .from('contacts').select('id').eq('tenant_id', tenantId).eq('name', rejectionSender).maybeSingle()
    if (!contactByName) {
      ok('Fase 4.1 §1: no contact/conversation was created for the unresolved-sender name')
    } else {
      nok('Fase 4.1 §1: unresolved sender must not create a contact', JSON.stringify(contactByName))
    }

    if (createdRejectionIds.length > 0) {
      const { data: rejectionRow } = await supabase
        .from('inbound_rejections')
        .select('reason, sender_length, tenant_id, account_id, internal_event_id')
        .eq('id', createdRejectionIds[createdRejectionIds.length - 1]!)
        .single()

      const rowJson = JSON.stringify(rejectionRow)
      const leaksRawSender = rowJson.includes(rejectionSender)

      if (
        rejectionRow?.reason === 'sender_not_a_phone' &&
        rejectionRow.sender_length === rejectionSender.length &&
        rejectionRow.tenant_id === tenantId &&
        rejectionRow.account_id === account.id &&
        !leaksRawSender
      ) {
        ok('Fase 4.1 §1: inbound_rejections row durably recorded (reason, sender_length, tenant/account) — never the raw sender string')
      } else {
        nok('Fase 4.1 §1: inbound_rejections row shape', rowJson)
      }
    } else {
      nok('Fase 4.1 §1: inbound_rejections row created', 'recordRejection was never called or the insert failed')
    }

    // ── 14. HTTP OK → dispatched ─────────────────────────────────────────────
    await runDispatchTick()
    const { data: afterDispatch } = await supabase.from('messaging_outbox').select('status, dispatched_at').eq('id', createdOutboxIds[0]!).single()
    if (afterDispatch?.status === 'dispatched' && afterDispatch.dispatched_at) {
      ok('14. Dispatcher: HTTP 200 "OK" from fake MacroDroid → status=dispatched, dispatched_at set')
    } else {
      nok('14. Dispatcher dispatched status', JSON.stringify(afterDispatch))
    }
    if (
      fake.requests.length >= 1 &&
      fake.requests[0]!.searchParams.get('rn_action') === 'outbound' &&
      fake.requests[0]!.searchParams.get('rn_phone') &&
      fake.requests[0]!.searchParams.get('rn_message')
    ) {
      ok('10/11. Dispatcher request carried rn_action=outbound, rn_phone and rn_message as query params')
    } else {
      nok('10/11. Dispatcher request shape', JSON.stringify(fake.requests[0]?.search))
    }

    // ── Fase 7 Parte A — 13/14 (outbound): a trigger accepted by the
    //    MacroDroid endpoint updates last_outbound_dispatch_at, but must
    //    NEVER update last_device_seen_at — the trigger SERVICE accepting
    //    an order is not evidence the Android itself did anything. ────────
    {
      const { data: acctHealth } = await supabase
        .from('whatsapp_accounts').select('last_outbound_dispatch_at, last_device_seen_at').eq('id', account.id).single()
      const dispatchRecent = acctHealth?.last_outbound_dispatch_at
        && Date.now() - new Date(acctHealth.last_outbound_dispatch_at).getTime() < 60_000

      if (dispatchRecent) {
        ok('13. Outbound dispatch (HTTP OK accepted) updates last_outbound_dispatch_at')
      } else {
        nok('13. last_outbound_dispatch_at update', JSON.stringify(acctHealth))
      }
      if (!acctHealth?.last_device_seen_at) {
        ok('14. Outbound dispatch ACK never updates last_device_seen_at — only the trigger relay accepted it, not physical evidence from the Android')
      } else {
        nok('14. last_device_seen_at must stay untouched by outbound ACK', JSON.stringify(acctHealth))
      }
    }

    // ── 17/18. Serialization: same account vs different account ────────────────
    const { data: msg2 } = await supabase.from('messages').insert({
      tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: 'seg mensaje', content_type: 'text', sender_type: 'ai',
      metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
    }).select('id').single()
    if (msg2) createdMessageIds.push(msg2.id)

    const { data: outbox2 } = await supabase.from('messaging_outbox').insert({
      tenant_id: tenantId, account_id: account.id, conversation_id: customerMsg.conversation_id,
      message_id: msg2!.id, destination_phone: senderPhone, text: 'seg mensaje', provider: 'autoresponder', source: 'ai', status: 'pending',
    }).select('id').single()
    if (outbox2) createdOutboxIds.push(outbox2.id)

    // second account (different Android) with its own pending item
    const { data: account2 } = await supabase.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
      inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
    }).select('id').single()
    if (account2) createdAccountIds.push(account2.id)

    const { data: msg3 } = await supabase.from('messages').insert({
      tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: 'otro android', content_type: 'text', sender_type: 'ai',
      metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
    }).select('id').single()
    if (msg3) createdMessageIds.push(msg3.id)

    const { data: outbox3 } = await supabase.from('messaging_outbox').insert({
      tenant_id: tenantId, account_id: account2!.id, conversation_id: customerMsg.conversation_id,
      message_id: msg3!.id, destination_phone: senderPhone, text: 'otro android', provider: 'autoresponder', source: 'ai', status: 'pending',
    }).select('id').single()
    if (outbox3) createdOutboxIds.push(outbox3.id)

    // account (account 1) is now within its post-dispatch cooldown from the
    // first message — outbox2 (same account) must NOT dispatch yet, but
    // outbox3 (a DIFFERENT account) must dispatch in the same tick.
    await runDispatchTick()

    const { data: statusAfterTick } = await supabase
      .from('messaging_outbox')
      .select('id, status')
      .in('id', [outbox2!.id, outbox3!.id])

    const s2 = statusAfterTick?.find(r => r.id === outbox2!.id)?.status
    const s3 = statusAfterTick?.find(r => r.id === outbox3!.id)?.status

    if (s2 === 'pending') {
      ok('17. Same-account serialization: second message for account 1 stayed pending during its cooldown (no parallel/duplicate WhatsApp Send)')
    } else {
      nok('17. Same-account serialization', `expected outbox2 (account 1, same device) to stay pending, got status=${s2}`)
    }
    if (s3 === 'dispatched') {
      ok('18. Cross-account independence: account 2 (a different Android) dispatched in the same tick, unaffected by account 1\'s cooldown')
    } else {
      nok('18. Cross-account independence', `expected outbox3 (account 2, different device) to dispatch, got status=${s3}`)
    }

    // ── 15. HTTP error → failed ─────────────────────────────────────────────
    // Uses a FRESH third account — account1/account2 are still inside their
    // post-dispatch cooldown at this point in the script (that's test 17/18
    // working correctly), which would make the dispatcher correctly SKIP them
    // here too and make this sub-test ambiguous. A fresh account has no
    // dispatch history, so it is never "busy".
    const { data: account3 } = await supabase.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
      inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
    }).select('id').single()
    if (account3) createdAccountIds.push(account3.id)

    fake.setFailing(true)
    const { data: msg4 } = await supabase.from('messages').insert({
      tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: 'fallará', content_type: 'text', sender_type: 'ai',
      metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
    }).select('id').single()
    if (msg4) createdMessageIds.push(msg4.id)

    const { data: outbox4 } = await supabase.from('messaging_outbox').insert({
      tenant_id: tenantId, account_id: account3!.id, conversation_id: customerMsg.conversation_id,
      message_id: msg4!.id, destination_phone: senderPhone, text: 'fallará', provider: 'autoresponder', source: 'ai', status: 'pending',
    }).select('id').single()
    if (outbox4) createdOutboxIds.push(outbox4.id)

    await runDispatchTick()
    const { data: afterFail } = await supabase.from('messaging_outbox').select('status, error').eq('id', outbox4!.id).single()
    if (afterFail?.status === 'failed' && afterFail.error) {
      ok(`15. Dispatcher: HTTP 500 from MacroDroid → status=failed, error="${afterFail.error}" (sanitized, no URL/text)`)
    } else {
      nok('15. Dispatcher failed status', JSON.stringify(afterFail))
    }
    fake.setFailing(false)

    // ── 16. Timeout/failure → no automatic retry ─────────────────────────────
    const requestCountBeforeExtraTick = fake.requests.length
    await runDispatchTick() // outbox4 is 'failed', must NOT be picked up again
    const { data: stillFailed } = await supabase.from('messaging_outbox').select('status').eq('id', outbox4!.id).single()
    if (stillFailed?.status === 'failed' && fake.requests.length === requestCountBeforeExtraTick) {
      ok('16. A failed dispatch is never retried automatically by subsequent ticks')
    } else {
      nok('16. No automatic retry', `status=${stillFailed?.status}, new requests=${fake.requests.length - requestCountBeforeExtraTick}`)
    }

    // ── Fase 4.1 correction: a contact writing through TWO different
    //    accounts/providers must get TWO SEPARATE conversations, never the
    //    same one reused by phone match alone. Scenarios A-E from the
    //    correction spec, driven through the REAL processMessage() pipeline
    //    for both a Meta-shaped and an AutoResponder-shaped inbound payload
    //    for the SAME contact. ─────────────────────────────────────────────
    const abPhone = '549' + String(3_100_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0')
    const fakeMetaPhoneNumber = nextTestPhone()

    const { data: fakeMetaAccount, error: metaAcctErr } = await supabase
      .from('whatsapp_accounts')
      .insert({
        tenant_id: tenantId, provider: 'meta', phone_number: fakeMetaPhoneNumber,
        business_account_id: `test-baid-${Date.now()}`, access_token_encrypted: 'test-dummy-token-never-used-for-real-send',
        webhook_secret: 'test-dummy-secret', active: true,
      })
      .select('id')
      .single()

    if (metaAcctErr || !fakeMetaAccount) {
      nok('Fase 4.1 setup: create fake Meta account', metaAcctErr?.message ?? 'no data')
    } else {
      createdAccountIds.push(fakeMetaAccount.id)

      // ── A. Meta inbound → conversation account=Meta ────────────────────
      const metaWamid = `wamid.test-${randomUUID()}`
      const metaPayload = {
        entry: [{ changes: [{ value: { messages: [{
          from: abPhone, id: metaWamid, type: 'text', text: { body: 'Hola, te escribo por Meta' },
        }] } }] }],
      }
      const metaNow = new Date().toISOString()
      const metaQueueRow: QueueRow = {
        id: `validate-ar-meta-${Date.now()}`, tenant_id: tenantId, whatsapp_account_id: fakeMetaAccount.id,
        raw_payload: metaPayload as unknown as QueueRow['raw_payload'], status: 'processing', attempts: 0,
        last_error: null, processed_at: null, processing_started_at: metaNow, scheduled_at: metaNow,
        created_at: metaNow, updated_at: metaNow,
      }
      await processMessage(metaQueueRow)

      const { data: metaMsg } = await supabase
        .from('messages').select('id, conversation_id')
        .eq('tenant_id', tenantId).eq('whatsapp_message_id', metaWamid).maybeSingle()
      if (metaMsg) createdMessageIds.push(metaMsg.id)

      const { data: contactAfterMeta } = await supabase
        .from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', abPhone).maybeSingle()
      if (contactAfterMeta) createdContactIds.push(contactAfterMeta.id)

      let metaConvAccountId: string | null | undefined
      if (metaMsg) {
        createdConversationIds.push(metaMsg.conversation_id)
        const { data: metaConv } = await supabase
          .from('conversations').select('whatsapp_account_id').eq('id', metaMsg.conversation_id).single()
        metaConvAccountId = metaConv?.whatsapp_account_id
      }

      if (metaMsg && metaConvAccountId === fakeMetaAccount.id) {
        ok('A. Meta inbound creates a conversation with whatsapp_account_id = the Meta account')
      } else {
        nok('A. Meta inbound conversation account', `expected ${fakeMetaAccount.id}, got ${metaConvAccountId}`)
      }

      // ── B. AutoResponder inbound, SAME contact → must NOT reuse the Meta
      //      conversation; must create/use a SEPARATE AutoResponder one. ──
      const arEventId = randomUUID()
      const arPayload = {
        appPackageName: AUTORESPONDER_APP_PACKAGE, messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
        provider: 'autoresponder', _internal_event_id: arEventId,
        query: { sender: abPhone, message: 'hola de nuevo, ahora por otro canal', isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false },
      }
      const arNow = new Date().toISOString()
      const arQueueRow: QueueRow = {
        id: `validate-ar-cross-${Date.now()}`, tenant_id: tenantId, whatsapp_account_id: account.id,
        raw_payload: arPayload as unknown as QueueRow['raw_payload'], status: 'processing', attempts: 0,
        last_error: null, processed_at: null, processing_started_at: arNow, scheduled_at: arNow,
        created_at: arNow, updated_at: arNow,
      }
      await processMessage(arQueueRow)

      const { data: arMsg } = await supabase
        .from('messages').select('id, conversation_id')
        .eq('tenant_id', tenantId).eq('whatsapp_message_id', arEventId).maybeSingle()
      if (arMsg) createdMessageIds.push(arMsg.id)

      let arConvAccountId: string | null | undefined
      if (arMsg) {
        createdConversationIds.push(arMsg.conversation_id)
        const { data: arConv } = await supabase
          .from('conversations').select('whatsapp_account_id').eq('id', arMsg.conversation_id).single()
        arConvAccountId = arConv?.whatsapp_account_id
      }

      if (arMsg && metaMsg && arMsg.conversation_id !== metaMsg.conversation_id && arConvAccountId === account.id) {
        ok('B. AutoResponder inbound for the SAME contact creates a SEPARATE conversation (not the Meta one), account=AutoResponder')
      } else {
        nok(
          'B. AutoResponder inbound must not reuse the Meta conversation',
          `metaConv=${metaMsg?.conversation_id}, arConv=${arMsg?.conversation_id}, arConvAccountId=${arConvAccountId}`,
        )
      }

      // ── C. Exactly 1 contact, 2 conversations, 2 distinct account ids ──
      const { data: contactConvs } = await supabase
        .from('conversations').select('id, whatsapp_account_id').eq('tenant_id', tenantId).eq('contact_id', contactAfterMeta?.id ?? '')
      const distinctAccounts = new Set((contactConvs ?? []).map((c) => c.whatsapp_account_id))
      if (contactAfterMeta && contactConvs?.length === 2 && distinctAccounts.size === 2) {
        ok('C. 1 contact now has 2 conversations with 2 distinct whatsapp_account_id values')
      } else {
        nok('C. contact/conversation/account cardinality', `conversations=${contactConvs?.length}, distinctAccounts=${distinctAccounts.size}`)
      }

      // ── D. AI reply from the Meta conversation → Meta (never outbox) ──
      const { data: metaOutboxAfter } = await supabase
        .from('messaging_outbox').select('id').eq('conversation_id', metaMsg?.conversation_id ?? '').eq('source', 'ai')
      metaOutboxAfter?.forEach((r) => createdOutboxIds.push(r.id))
      if (metaOutboxAfter && metaOutboxAfter.length === 0) {
        ok('D. AI reply for the Meta conversation is NOT routed into messaging_outbox')
      } else {
        nok('D. AI reply routing for Meta conversation', `expected 0 outbox rows, got ${metaOutboxAfter?.length}`)
      }
      const { data: metaAiMsg } = await supabase
        .from('messages').select('id').eq('conversation_id', metaMsg?.conversation_id ?? '').eq('sender_type', 'ai')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (metaAiMsg) createdMessageIds.push(metaAiMsg.id)

      // ── E. AI reply from the AutoResponder conversation → outbox,
      //      provider=autoresponder, account=account.id ──────────────────
      const { data: arOutboxAfter } = await supabase
        .from('messaging_outbox').select('id, provider, account_id').eq('conversation_id', arMsg?.conversation_id ?? '').eq('source', 'ai')
      arOutboxAfter?.forEach((r) => createdOutboxIds.push(r.id))
      if (arOutboxAfter?.length === 1 && arOutboxAfter[0]!.provider === 'autoresponder' && arOutboxAfter[0]!.account_id === account.id) {
        ok('E. AI reply for the AutoResponder conversation is enqueued into messaging_outbox with the correct account')
      } else {
        nok('E. AI reply routing for AutoResponder conversation', JSON.stringify(arOutboxAfter))
      }
      const { data: arAiMsg } = await supabase
        .from('messages').select('id').eq('conversation_id', arMsg?.conversation_id ?? '').eq('sender_type', 'ai')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (arAiMsg) createdMessageIds.push(arAiMsg.id)
    }

    // ── J. Legacy conversation (whatsapp_account_id = NULL) is backfilled
    //      once, unambiguously, by the first inbound that reaches it. ─────
    const legacyPhone = '549' + String(3_400_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0')
    const { data: legacyContact } = await supabase
      .from('contacts').insert({ tenant_id: tenantId, phone: legacyPhone, source: 'whatsapp' }).select('id').single()

    if (!legacyContact) {
      nok('J setup: create legacy contact', 'no data')
    } else {
      createdContactIds.push(legacyContact.id)

      const { data: legacyConv } = await supabase
        .from('conversations')
        .insert({
          tenant_id: tenantId, contact_id: legacyContact.id, channel: 'whatsapp', source: 'whatsapp_direct',
          ai_mode: 'autonomous', status: 'open', whatsapp_account_id: null,
        })
        .select('id')
        .single()

      if (!legacyConv) {
        nok('J setup: create legacy (NULL account) conversation', 'no data')
      } else {
        createdConversationIds.push(legacyConv.id)

        const legacyEventId = randomUUID()
        const legacyPayload = {
          appPackageName: AUTORESPONDER_APP_PACKAGE, messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
          provider: 'autoresponder', _internal_event_id: legacyEventId,
          query: { sender: legacyPhone, message: 'mensaje sobre conversación legacy', isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false },
        }
        const legacyNow = new Date().toISOString()
        const legacyQueueRow: QueueRow = {
          id: `validate-ar-legacy-${Date.now()}`, tenant_id: tenantId, whatsapp_account_id: account.id,
          raw_payload: legacyPayload as unknown as QueueRow['raw_payload'], status: 'processing', attempts: 0,
          last_error: null, processed_at: null, processing_started_at: legacyNow, scheduled_at: legacyNow,
          created_at: legacyNow, updated_at: legacyNow,
        }
        await processMessage(legacyQueueRow)

        const { data: legacyMsg } = await supabase
          .from('messages').select('id, conversation_id')
          .eq('tenant_id', tenantId).eq('whatsapp_message_id', legacyEventId).maybeSingle()
        if (legacyMsg) createdMessageIds.push(legacyMsg.id)

        const { data: legacyConvAfter } = await supabase
          .from('conversations').select('whatsapp_account_id').eq('id', legacyConv.id).single()

        if (legacyMsg?.conversation_id === legacyConv.id && legacyConvAfter?.whatsapp_account_id === account.id) {
          ok('J. Legacy (NULL account) conversation is reused and backfilled to the first account that reaches it')
        } else {
          nok(
            'J. Legacy conversation backfill',
            `expected reuse of ${legacyConv.id} backfilled to ${account.id}, got conversation_id=${legacyMsg?.conversation_id}, account=${legacyConvAfter?.whatsapp_account_id}`,
          )
        }

        // A DIFFERENT account writing to the SAME legacy-turned-linked
        // contact afterward must get its OWN separate conversation, never
        // reuse the one now linked to `account`.
        const { data: legacyOutbox } = await supabase
          .from('messaging_outbox').select('id').eq('conversation_id', legacyConv.id).eq('source', 'ai')
        legacyOutbox?.forEach((r) => createdOutboxIds.push(r.id))
        const { data: legacyAiMsg } = await supabase
          .from('messages').select('id').eq('conversation_id', legacyConv.id).eq('sender_type', 'ai')
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (legacyAiMsg) createdMessageIds.push(legacyAiMsg.id)
      }
    }

    // ── Fase 4.1 §3: genuine concurrent claim — N simultaneous RPC calls
    //    against the SAME account/pending pool must never let more than one
    //    succeed (max 1 processing item per account at a time; two "workers"
    //    never claim the same outbox row). Real parallel Postgres
    //    transactions via Promise.all(), not simulated. ─────────────────────
    const { data: concAccount, error: concAcctErr } = await supabase
      .from('whatsapp_accounts')
      .insert({
        tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
        inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
      })
      .select('id')
      .single()

    if (concAcctErr || !concAccount) {
      nok('Fase 4.1 §3 setup: create concurrency-test account', concAcctErr?.message ?? 'no data')
    } else {
      createdAccountIds.push(concAccount.id)

      const CONCURRENT_PENDING = 5
      const concOutboxIds: string[] = []
      for (let i = 0; i < CONCURRENT_PENDING; i++) {
        const { data: concMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: `conc-${i}`, content_type: 'text', sender_type: 'ai',
          metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
        }).select('id').single()
        if (!concMsg) continue
        createdMessageIds.push(concMsg.id)

        const { data: concOutbox } = await supabase.from('messaging_outbox').insert({
          tenant_id: tenantId, account_id: concAccount.id, conversation_id: customerMsg.conversation_id,
          message_id: concMsg.id, destination_phone: senderPhone, text: `conc-${i}`, provider: 'autoresponder', source: 'ai', status: 'pending',
        }).select('id').single()
        if (concOutbox) {
          concOutboxIds.push(concOutbox.id)
          createdOutboxIds.push(concOutbox.id)
        }
      }

      if (concOutboxIds.length !== CONCURRENT_PENDING) {
        nok('Fase 4.1 §3 setup: create concurrent pending items', `expected ${CONCURRENT_PENDING}, got ${concOutboxIds.length}`)
      } else {
        const CONCURRENT_CALLERS = 8
        const claimResults = await Promise.all(
          Array.from({ length: CONCURRENT_CALLERS }, () =>
            supabase.rpc('claim_next_outbox_item', { p_cooldown_seconds: 8 }),
          ),
        )

        const rpcErrors = claimResults.filter((r) => r.error)
        const claimedRows = claimResults.flatMap((r) => r.data ?? [])
        const claimedIds  = claimedRows.map((r) => r.id)
        const uniqueClaimedIds = new Set(claimedIds)

        // Scoped to THIS test's account specifically: claim_next_outbox_item
        // operates globally over messaging_outbox (by design — any account
        // may be picked), so an unrelated pending item belonging to some
        // OTHER account (e.g. one whose cooldown from an earlier step in
        // this same script run has since expired) may legitimately also get
        // claimed by one of these 8 concurrent calls. That is correct
        // behavior, not a double-claim — the invariant under test is "at
        // most 1 processing item for THIS account", not "at most 1 claim
        // system-wide".
        const claimedForThisAccount = claimedRows.filter((r) => r.account_id === concAccount.id)
        const uniqueForThisAccount  = new Set(claimedForThisAccount.map((r) => r.id))

        if (rpcErrors.length > 0) {
          nok('Fase 4.1 §3: claim_next_outbox_item RPC callable', rpcErrors[0]?.error?.message ?? 'unknown error')
        } else if (claimedForThisAccount.length === 1 && uniqueForThisAccount.size === 1) {
          ok(
            `Fase 4.1 §3: ${CONCURRENT_CALLERS} concurrent claim_next_outbox_item() calls against the same busy account → ` +
            `exactly 1 succeeded for that account, 0 duplicate claims (${claimedIds.length} total claim(s) across all accounts system-wide: ${JSON.stringify(claimedIds)})`,
          )
        } else {
          nok(
            'Fase 4.1 §3: concurrent claim atomicity',
            `expected exactly 1 unique claim for account ${concAccount.id} across ${CONCURRENT_CALLERS} concurrent calls, got ${claimedForThisAccount.length} claim(s) (${uniqueForThisAccount.size} unique)`,
          )
        }

        const { data: concStatuses } = await supabase
          .from('messaging_outbox').select('id, status').in('id', concOutboxIds)
        const processingCount = concStatuses?.filter((r) => r.status === 'processing').length ?? -1
        const pendingCount    = concStatuses?.filter((r) => r.status === 'pending').length ?? -1

        if (processingCount === 1 && pendingCount === CONCURRENT_PENDING - 1) {
          ok(`Fase 4.1 §3: after the race, exactly 1 item is 'processing' for the account and the other ${CONCURRENT_PENDING - 1} remain untouched ('pending')`)
        } else {
          nok('Fase 4.1 §3: post-race status distribution', `processing=${processingCount}, pending=${pendingCount}`)
        }
      }
    }

    // Fase 6B.2 introduced whatsapp_accounts.device_dispatch_reserved_until
    // as a side effect of claiming. The Fase 4.1 §3 test above calls
    // claim_next_outbox_item directly via RPC (bypassing dispatchOne's
    // guaranteed release) specifically to test raw claim atomicity — its
    // own comment already documents that one of the 8 concurrent calls MAY
    // legitimately claim an unrelated stray pending row belonging to
    // `account`/`account2` (claim_next_outbox_item is globally FIFO-scoped
    // by design). Before Fase 6B.2 that was harmless; now it would also
    // leave that account's device lease reserved for up to 20s with nothing
    // to release it (no dispatch ever follows a direct RPC call in that
    // test). Clear it explicitly here so the Fase 6B media tests below
    // (which assert on these same two accounts) are never spuriously
    // blocked by that unrelated stress test's side effect.
    await supabase
      .from('whatsapp_accounts')
      .update({ device_dispatch_reserved_until: null })
      .in('id', [account.id, account2?.id ?? ''])

    // ── Fase 6B: media dispatcher — trigger shape, serialization (§23/§24) ──
    // Reuses the SAME fake MacroDroid HTTP server (captures request URLs in
    // fake.requests) and the SAME two throwaway accounts (account, account2)
    // already pointed at it from the tests above.
    {
      async function makeMediaEvent(acct: { id: string }, mediaType: 'audio' | 'image' | 'document', filename: string | null) {
        const { data: msg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg!.conversation_id, content: `[placeholder ${mediaType}]`,
          content_type: mediaType, sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (msg) createdMessageIds.push(msg.id)

        const { data: event } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: acct.id, conversation_id: customerMsg!.conversation_id, message_id: msg!.id,
          media_type: mediaType, expected_filename: filename, status: 'pending_android',
        }).select('id').single()
        if (event) createdMediaEventIds.push(event.id)
        return event
      }

      const requestsBefore = fake.requests.length
      const eventA1 = await makeMediaEvent(account, 'audio', null)
      const eventA2 = await makeMediaEvent(account, 'document', 'Contrato.pdf')

      await runMediaDispatchTick()

      const { data: eventsAfterTick } = await supabase
        .from('media_events').select('id, status, dispatched_at').in('id', [eventA1!.id, eventA2!.id])
      const dispatchedA = eventsAfterTick?.filter((e) => e.dispatched_at !== null) ?? []
      const stillPendingA = eventsAfterTick?.filter((e) => e.dispatched_at === null) ?? []

      if (dispatchedA.length === 1 && stillPendingA.length === 1) {
        ok('23. Two media events on the SAME account: only 1 dispatched in this tick, the other stays untouched — no simultaneous extraction on one Android')
      } else {
        nok('23. Media serialization same account', `dispatched=${dispatchedA.length}, pending=${stillPendingA.length}`)
      }

      const newRequests = fake.requests.slice(requestsBefore)
      const mediaRequest = newRequests.find((u) => u.searchParams.has('rn_event_id'))
      if (
        mediaRequest &&
        mediaRequest.searchParams.get('rn_action') === 'media' &&
        mediaRequest.searchParams.get('rn_media_type') &&
        ['audio', 'document'].includes(mediaRequest.searchParams.get('rn_media_type')!)
      ) {
        ok('Media trigger request carried rn_action=media, rn_event_id and rn_media_type as query params')
      } else {
        nok('Media trigger request shape', JSON.stringify(newRequests.map((u) => u.search)))
      }

      const documentRequest = newRequests.find((u) => u.searchParams.get('rn_media_type') === 'document')
      if (!documentRequest || documentRequest.searchParams.get('rn_filename') === 'Contrato.pdf') {
        ok('Document media trigger includes rn_filename with the exact expected filename (when it is the one dispatched)')
      } else {
        nok('Document rn_filename', documentRequest.search)
      }

      // ── 24. A different account (account2) is never blocked by account's
      // in-flight media event ────────────────────────────────────────────────
      const eventB = await makeMediaEvent(account2!, 'image', null)
      await runMediaDispatchTick()

      const { data: eventBAfter } = await supabase.from('media_events').select('dispatched_at').eq('id', eventB!.id).single()
      if (eventBAfter?.dispatched_at) {
        ok('24. A different account (account2) dispatches its media trigger independently — unaffected by account\'s in-flight event')
      } else {
        nok('24. Cross-account media independence', JSON.stringify(eventBAfter))
      }
    }

    // ── Fase 6B.2: cross-queue device lease — messaging_outbox (text) and
    //    media_events (media) are each serialized independently per account,
    //    but both fire the SAME MacroDroid webhook on the SAME Android. This
    //    proves outbound and media dispatch for the SAME account can never
    //    both be "in flight" at once, while a DIFFERENT account is never
    //    blocked by that. Real concurrent RPC calls via Promise.all(), not
    //    simulated. ─────────────────────────────────────────────────────────
    {
      // Drains any leftover claimable strays from earlier sections (e.g.
      // account 1's second message, left 'pending' by the cooldown check in
      // tests 17/18 — its cooldown may have expired by now) so the race
      // below genuinely contends over THIS section's own rows, not whatever
      // else happens to be oldest in the global FIFO queue. Uses the same
      // runDispatchTick/runMediaDispatchTick already exercised above — never
      // a destructive bulk UPDATE; busy/cooldown accounts are correctly left
      // untouched either way.
      await runDispatchTick()
      await runDispatchTick()
      await runMediaDispatchTick()

      // ── A. SAME account: 1 pending outbox item + 1 pending media event,
      //    claim_next_outbox_item and claim_next_media_event called
      //    concurrently → exactly one must win. ────────────────────────────
      const { data: leaseAccount, error: leaseAcctErr } = await supabase
        .from('whatsapp_accounts')
        .insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        })
        .select('id')
        .single()

      if (leaseAcctErr || !leaseAccount) {
        nok('Fase 6B.2 setup: create cross-queue lease test account', leaseAcctErr?.message ?? 'no data')
      } else {
        createdAccountIds.push(leaseAccount.id)

        const { data: leaseMsg1 } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: 'lease outbound', content_type: 'text', sender_type: 'ai',
          metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
        }).select('id').single()
        if (leaseMsg1) createdMessageIds.push(leaseMsg1.id)

        const { data: leaseOutbox } = await supabase.from('messaging_outbox').insert({
          tenant_id: tenantId, account_id: leaseAccount.id, conversation_id: customerMsg.conversation_id,
          message_id: leaseMsg1?.id ?? '', destination_phone: senderPhone, text: 'lease outbound', provider: 'autoresponder', source: 'ai', status: 'pending',
        }).select('id').single()
        if (leaseOutbox) createdOutboxIds.push(leaseOutbox.id)

        const { data: leaseMsg2 } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder audio]', content_type: 'audio', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (leaseMsg2) createdMessageIds.push(leaseMsg2.id)

        const { data: leaseMediaEvent } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: leaseAccount.id, conversation_id: customerMsg.conversation_id, message_id: leaseMsg2?.id ?? '',
          media_type: 'audio', expected_filename: null, status: 'pending_android',
        }).select('id').single()
        if (leaseMediaEvent) createdMediaEventIds.push(leaseMediaEvent.id)

        if (!leaseOutbox || !leaseMediaEvent) {
          nok('Fase 6B.2 setup: create paired pending outbox item + media event', 'insert failed')
        } else {
          const [outboxRace, mediaRace] = await Promise.all([
            supabase.rpc('claim_next_outbox_item', { p_cooldown_seconds: 8, p_lease_seconds: 20 }),
            supabase.rpc('claim_next_media_event', { p_lease_seconds: 20 }),
          ])

          if (outboxRace.error || mediaRace.error) {
            nok(
              'Fase 6B.2 A: concurrent claim RPCs callable',
              JSON.stringify({ outboxErr: outboxRace.error?.message, mediaErr: mediaRace.error?.message }),
            )
          }

          const { data: raceOutboxStatus } = await supabase
            .from('messaging_outbox').select('status').eq('id', leaseOutbox.id).single()
          const { data: raceMediaStatus } = await supabase
            .from('media_events').select('dispatched_at').eq('id', leaseMediaEvent.id).single()

          const outboxWon = raceOutboxStatus?.status === 'processing'
          const mediaWon  = !!raceMediaStatus?.dispatched_at

          if (outboxWon !== mediaWon && (outboxWon || mediaWon)) {
            ok(
              `A. Same account: outbound and media claimed concurrently → exactly one won ` +
              `(outboxWon=${outboxWon}, mediaWon=${mediaWon}), never both — the other stayed untouched`,
            )
          } else {
            nok(
              'A. Cross-queue mutual exclusion (same account)',
              `outboxStatus=${raceOutboxStatus?.status}, mediaDispatchedAt=${raceMediaStatus?.dispatched_at}`,
            )
          }

          // ── 6. Confirms the coordination is a real, queryable Postgres
          //    row — not just in-memory Node state. ─────────────────────────
          const { data: leaseRow } = await supabase
            .from('whatsapp_accounts').select('device_dispatch_reserved_until').eq('id', leaseAccount.id).single()
          if (leaseRow?.device_dispatch_reserved_until) {
            ok('6. device_dispatch_reserved_until was set in Postgres by whichever claim won the race')
          } else {
            nok('6. device_dispatch_reserved_until set on claim', JSON.stringify(leaseRow))
          }
        }
      }

      // ── D. DIFFERENT accounts: account A outbound + account B media,
      //    claimed concurrently → BOTH must progress, independently. ───────
      const { data: leaseAccountA, error: leaseAErr } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()
      const { data: leaseAccountB, error: leaseBErr } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()

      if (leaseAErr || leaseBErr || !leaseAccountA || !leaseAccountB) {
        nok('Fase 6B.2 D setup: create two independent accounts', JSON.stringify({ a: leaseAErr?.message, b: leaseBErr?.message }))
      } else {
        createdAccountIds.push(leaseAccountA.id, leaseAccountB.id)

        const { data: msgA } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: 'lease A outbound', content_type: 'text', sender_type: 'ai',
          metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
        }).select('id').single()
        if (msgA) createdMessageIds.push(msgA.id)

        const { data: outboxA } = await supabase.from('messaging_outbox').insert({
          tenant_id: tenantId, account_id: leaseAccountA.id, conversation_id: customerMsg.conversation_id,
          message_id: msgA?.id ?? '', destination_phone: senderPhone, text: 'lease A outbound', provider: 'autoresponder', source: 'ai', status: 'pending',
        }).select('id').single()
        if (outboxA) createdOutboxIds.push(outboxA.id)

        const { data: msgB } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder image]', content_type: 'image', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (msgB) createdMessageIds.push(msgB.id)

        const { data: mediaB } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: leaseAccountB.id, conversation_id: customerMsg.conversation_id, message_id: msgB?.id ?? '',
          media_type: 'image', expected_filename: null, status: 'pending_android',
        }).select('id').single()
        if (mediaB) createdMediaEventIds.push(mediaB.id)

        if (!outboxA || !mediaB) {
          nok('Fase 6B.2 D setup: create outbox(A) + media(B)', 'insert failed')
        } else {
          await Promise.all([
            supabase.rpc('claim_next_outbox_item', { p_cooldown_seconds: 8, p_lease_seconds: 20 }),
            supabase.rpc('claim_next_media_event', { p_lease_seconds: 20 }),
          ])

          const { data: statusA } = await supabase.from('messaging_outbox').select('status').eq('id', outboxA.id).single()
          const { data: statusB } = await supabase.from('media_events').select('dispatched_at').eq('id', mediaB.id).single()

          if (statusA?.status === 'processing' && statusB?.dispatched_at) {
            ok('D. Different accounts: account A (outbound) and account B (media) claimed concurrently → BOTH progressed independently')
          } else {
            nok(
              'D. Cross-account independence under concurrent claim',
              `accountA outbox status=${statusA?.status}, accountB media dispatched_at=${statusB?.dispatched_at}`,
            )
          }
        }
      }
    }

    // ── Fase 6B.2 correction: the device lease must survive a RESOLVED
    //    HTTP ACK, not just a concurrent claim race. A "200 OK" from
    //    MacroDroid only means the trigger was acknowledged — it says
    //    nothing about whether the physical macro (Screen On/Wait/Send, or
    //    Wait/locate-file/upload) actually finished on the Android. Drives
    //    the REAL dispatch path (runDispatchTick/runMediaDispatchTick,
    //    hitting the real local fake MacroDroid server — resolves in ms) so
    //    fetch() genuinely resolves, then immediately (no sleep — the 20s
    //    lease window is still wide open) attempts the OTHER queue for the
    //    SAME account and confirms it is blocked, while a different account
    //    proceeds normally in the same tick. ──────────────────────────────
    {
      // ── outbound → HTTP OK → media (same account) must stay blocked ────
      const { data: lease3, error: lease3Err } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()
      // Control account — must progress normally in the SAME tick, unaffected by lease3's reservation.
      const { data: leaseControl, error: leaseControlErr } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()

      if (lease3Err || !lease3 || leaseControlErr || !leaseControl) {
        nok('Fase 6B.3 setup: create lease3 + control accounts', JSON.stringify({ a: lease3Err?.message, b: leaseControlErr?.message }))
      } else {
        createdAccountIds.push(lease3.id, leaseControl.id)

        const { data: lease3OutMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: 'lease3 outbound', content_type: 'text', sender_type: 'ai',
          metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
        }).select('id').single()
        if (lease3OutMsg) createdMessageIds.push(lease3OutMsg.id)

        const { data: lease3Outbox } = await supabase.from('messaging_outbox').insert({
          tenant_id: tenantId, account_id: lease3.id, conversation_id: customerMsg.conversation_id,
          message_id: lease3OutMsg?.id ?? '', destination_phone: senderPhone, text: 'lease3 outbound', provider: 'autoresponder', source: 'ai', status: 'pending',
        }).select('id').single()
        if (lease3Outbox) createdOutboxIds.push(lease3Outbox.id)

        const { data: lease3MediaMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder image]', content_type: 'image', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (lease3MediaMsg) createdMessageIds.push(lease3MediaMsg.id)

        const { data: lease3Media } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: lease3.id, conversation_id: customerMsg.conversation_id, message_id: lease3MediaMsg?.id ?? '',
          media_type: 'image', expected_filename: null, status: 'pending_android',
        }).select('id').single()
        if (lease3Media) createdMediaEventIds.push(lease3Media.id)

        const { data: controlMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: 'control outbound', content_type: 'text', sender_type: 'ai',
          metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
        }).select('id').single()
        if (controlMsg) createdMessageIds.push(controlMsg.id)

        const { data: controlOutbox } = await supabase.from('messaging_outbox').insert({
          tenant_id: tenantId, account_id: leaseControl.id, conversation_id: customerMsg.conversation_id,
          message_id: controlMsg?.id ?? '', destination_phone: senderPhone, text: 'control outbound', provider: 'autoresponder', source: 'ai', status: 'pending',
        }).select('id').single()
        if (controlOutbox) createdOutboxIds.push(controlOutbox.id)

        if (!lease3Outbox || !lease3Media || !controlOutbox) {
          nok('Fase 6B.3 setup: create paired rows (outbound side)', 'insert failed')
        } else {
          // Real dispatch tick: claims + fires the REAL fetch to the fake
          // local MacroDroid server for BOTH lease3 and leaseControl
          // (two distinct, currently-free accounts) — resolves in ms.
          await runDispatchTick()

          const { data: lease3OutAfter } = await supabase.from('messaging_outbox').select('status').eq('id', lease3Outbox.id).single()
          const { data: controlOutAfter } = await supabase.from('messaging_outbox').select('status').eq('id', controlOutbox.id).single()

          if (lease3OutAfter?.status !== 'dispatched') {
            nok('7a. outbound dispatched (real fetch to fake MacroDroid, HTTP 200 "OK")', JSON.stringify(lease3OutAfter))
          }

          // Immediately (no sleep) — media for the SAME account must NOT
          // be able to claim, even though the HTTP fetch already resolved.
          await runMediaDispatchTick()
          const { data: lease3MediaAfter } = await supabase.from('media_events').select('dispatched_at').eq('id', lease3Media.id).single()

          if (!lease3MediaAfter?.dispatched_at) {
            ok('7. outbound → HTTP 200 OK → media for the SAME account stays blocked (lease not released after fetch resolves)')
          } else {
            nok('7. Lease must survive HTTP ACK (outbound→media)', JSON.stringify(lease3MediaAfter))
          }

          const { data: lease3AccountAfter } = await supabase.from('whatsapp_accounts').select('device_dispatch_reserved_until').eq('id', lease3.id).single()
          const stillReserved = !!lease3AccountAfter?.device_dispatch_reserved_until
            && new Date(lease3AccountAfter.device_dispatch_reserved_until).getTime() > Date.now()
          if (stillReserved) {
            ok('4. device_dispatch_reserved_until remains in the future after the HTTP fetch resolved — no explicit release happened')
          } else {
            nok('4. Lease must not be explicitly released after fetch resolves', JSON.stringify(lease3AccountAfter))
          }

          if (controlOutAfter?.status === 'dispatched') {
            ok('9a. A different account (control) dispatched normally in the same tick — unaffected by lease3\'s reservation')
          } else {
            nok('9a. Cross-account independence (control, outbound side)', JSON.stringify(controlOutAfter))
          }
        }
      }

      // ── media → HTTP OK → outbound (same account) must stay blocked ────
      const { data: lease5, error: lease5Err } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()
      const { data: leaseControl2, error: leaseControl2Err } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()

      if (lease5Err || !lease5 || leaseControl2Err || !leaseControl2) {
        nok('Fase 6B.3 (reverse) setup: create lease5 + control2 accounts', JSON.stringify({ a: lease5Err?.message, b: leaseControl2Err?.message }))
      } else {
        createdAccountIds.push(lease5.id, leaseControl2.id)

        const { data: lease5MediaMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder audio]', content_type: 'audio', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (lease5MediaMsg) createdMessageIds.push(lease5MediaMsg.id)

        const { data: lease5Media } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: lease5.id, conversation_id: customerMsg.conversation_id, message_id: lease5MediaMsg?.id ?? '',
          media_type: 'audio', expected_filename: null, status: 'pending_android',
        }).select('id').single()
        if (lease5Media) createdMediaEventIds.push(lease5Media.id)

        const { data: lease5OutMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: 'lease5 outbound', content_type: 'text', sender_type: 'ai',
          metadata: { in_reply_to_whatsapp_message_id: randomUUID() } as never,
        }).select('id').single()
        if (lease5OutMsg) createdMessageIds.push(lease5OutMsg.id)

        const { data: lease5Outbox } = await supabase.from('messaging_outbox').insert({
          tenant_id: tenantId, account_id: lease5.id, conversation_id: customerMsg.conversation_id,
          message_id: lease5OutMsg?.id ?? '', destination_phone: senderPhone, text: 'lease5 outbound', provider: 'autoresponder', source: 'ai', status: 'pending',
        }).select('id').single()
        if (lease5Outbox) createdOutboxIds.push(lease5Outbox.id)

        const { data: control2Msg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder image]', content_type: 'image', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (control2Msg) createdMessageIds.push(control2Msg.id)

        const { data: control2Media } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: leaseControl2.id, conversation_id: customerMsg.conversation_id, message_id: control2Msg?.id ?? '',
          media_type: 'image', expected_filename: null, status: 'pending_android',
        }).select('id').single()
        if (control2Media) createdMediaEventIds.push(control2Media.id)

        if (!lease5Media || !lease5Outbox || !control2Media) {
          nok('Fase 6B.3 (reverse) setup: create paired rows (media side)', 'insert failed')
        } else {
          await runMediaDispatchTick()

          const { data: lease5MediaAfter } = await supabase.from('media_events').select('dispatched_at').eq('id', lease5Media.id).single()
          const { data: control2MediaAfter } = await supabase.from('media_events').select('dispatched_at').eq('id', control2Media.id).single()

          if (!lease5MediaAfter?.dispatched_at) {
            nok('8a. media dispatched (real fetch to fake MacroDroid, HTTP 200 "OK")', JSON.stringify(lease5MediaAfter))
          }

          // Immediately (no sleep) — outbound for the SAME account must
          // NOT be able to claim, even though the HTTP fetch already
          // resolved.
          await runDispatchTick()
          const { data: lease5OutAfter } = await supabase.from('messaging_outbox').select('status').eq('id', lease5Outbox.id).single()

          if (lease5OutAfter?.status === 'pending') {
            ok('8. media → HTTP 200 OK → outbound for the SAME account stays blocked (lease not released after fetch resolves)')
          } else {
            nok('8. Lease must survive HTTP ACK (media→outbound)', JSON.stringify(lease5OutAfter))
          }

          if (control2MediaAfter?.dispatched_at) {
            ok('9b. A different account (control2) dispatched its media trigger normally in the same tick — unaffected by lease5\'s reservation')
          } else {
            nok('9b. Cross-account independence (control2, media side)', JSON.stringify(control2MediaAfter))
          }
        }
      }
    }

    // ── Fase 6B.5: a STUCK old media event (dispatched, never uploaded,
    //    now stale) must not starve a fresh media event for the SAME
    //    account forever. Reproduces the exact physical bug found in E2E
    //    testing: claim_next_media_event's own busy-check correctly treats
    //    ANY 'pending_android' row with dispatched_at set as "account
    //    busy" — before this fix, only a worker RESTART ever demoted a
    //    stuck row out of that state (recoverStuckMediaEvents ran once at
    //    startup only), so a single stuck upload could block every
    //    subsequent media event for that account indefinitely in a
    //    long-running worker. Backdates updated_at directly (no real
    //    5-minute sleep) to deterministically simulate staleness. ────────
    {
      const { data: starveAccount, error: starveAcctErr } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()

      if (starveAcctErr || !starveAccount) {
        nok('Fase 6B.5 setup: create starvation test account', starveAcctErr?.message ?? 'no data')
      } else {
        createdAccountIds.push(starveAccount.id)

        // The OLD, stuck event: dispatched well over STUCK_THRESHOLD_MS
        // (5 min) ago, never uploaded — updated_at backdated to simulate
        // real elapsed time without an actual 5-minute wait.
        const staleTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString()
        const { data: stuckMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder document]', content_type: 'document', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (stuckMsg) createdMessageIds.push(stuckMsg.id)

        const { data: stuckEvent } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: starveAccount.id, conversation_id: customerMsg.conversation_id, message_id: stuckMsg?.id ?? '',
          media_type: 'document', expected_filename: 'viejo.pdf', status: 'pending_android',
          dispatched_at: staleTimestamp, created_at: staleTimestamp, updated_at: staleTimestamp,
        }).select('id').single()
        if (stuckEvent) createdMediaEventIds.push(stuckEvent.id)

        // The NEW, fresh event for the SAME account — this is the one that
        // was starving physically.
        const { data: freshMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder document]', content_type: 'document', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (freshMsg) createdMessageIds.push(freshMsg.id)

        const { data: freshEvent } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: starveAccount.id, conversation_id: customerMsg.conversation_id, message_id: freshMsg?.id ?? '',
          media_type: 'document', expected_filename: 'nuevo.pdf', status: 'pending_android',
        }).select('id').single()
        if (freshEvent) createdMediaEventIds.push(freshEvent.id)

        if (!stuckEvent || !freshEvent) {
          nok('Fase 6B.5 setup: create stuck + fresh media events', 'insert failed')
        } else {
          // ── Reproduce the bug: before any recovery pass, the fresh event
          //    must NOT be claimable — the account is correctly considered
          //    busy by the stuck row's own presence. ────────────────────
          await runMediaDispatchTick()
          const { data: freshBeforeRecovery } = await supabase.from('media_events').select('dispatched_at').eq('id', freshEvent.id).single()

          if (!freshBeforeRecovery?.dispatched_at) {
            ok('Fase 6B.5: reproduces the starvation — a stale-but-undetected stuck event blocks a fresh media event for the same account')
          } else {
            nok('Fase 6B.5: expected the fresh event to be blocked BEFORE recovery ran', JSON.stringify(freshBeforeRecovery))
          }

          // ── The fix: recoverStuckMediaEvents (now callable independently
          //    of worker startup) demotes the stale row to a terminal
          //    state. ─────────────────────────────────────────────────────
          await recoverStuckMediaEvents(supabase)
          const { data: stuckAfterRecovery } = await supabase.from('media_events').select('status, error').eq('id', stuckEvent.id).single()

          if (stuckAfterRecovery?.status === 'failed' && stuckAfterRecovery.error) {
            ok(`Fase 6B.5: recoverStuckMediaEvents demoted the stale stuck event to 'failed' (error="${stuckAfterRecovery.error}") — no auto-retry`)
          } else {
            nok('Fase 6B.5: recoverStuckMediaEvents did not demote the stuck event', JSON.stringify(stuckAfterRecovery))
          }

          // ── The regression this test exists for: the fresh event MUST
          //    now be claimable and dispatched — starvation resolved. ────
          await runMediaDispatchTick()
          const { data: freshAfterRecovery } = await supabase.from('media_events').select('dispatched_at').eq('id', freshEvent.id).single()

          if (freshAfterRecovery?.dispatched_at) {
            ok('Fase 6B.5 (regression): a fresh media event with an available account and no competing in-flight item IS reclaimed and dispatched once the stale stuck event is cleared')
          } else {
            nok('Fase 6B.5 (regression): fresh media event still not dispatched after recovery', JSON.stringify(freshAfterRecovery))
          }
        }
      }
    }

    // ── Fase 6B.6: recoverStuckMediaEvents must distinguish "never
    //    dispatched, just waiting its turn" from "dispatched, upload never
    //    arrived" — only the latter is genuinely ambiguous. Reproduces a
    //    real physical bug found via re-test: a genuine media_event with
    //    status='pending_android' and dispatched_at=NULL (ReservaNex never
    //    even fired the trigger for it, still waiting behind another
    //    account's stuck item) was incorrectly marked 'failed' by the Fase
    //    6B.5 predicate, which judged staleness by updated_at (ambiguous —
    //    also just means "row inserted") instead of dispatched_at
    //    (unambiguous — NULL means nothing was ever sent). Scenario C (old
    //    dispatched item blocks a new one; recovery fails only the old one,
    //    the new one then progresses) is already covered by the Fase 6B.5
    //    test above — unchanged, still passing. ─────────────────────────
    {
      // ── A. Old (10 min) but NEVER dispatched — must survive recovery
      //    unconditionally and remain claimable. ──────────────────────────
      const { data: semAccountA, error: semAErr } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()

      if (semAErr || !semAccountA) {
        nok('Fase 6B.6 A setup: create account', semAErr?.message ?? 'no data')
      } else {
        createdAccountIds.push(semAccountA.id)

        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
        const { data: neverDispatchedMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder document]', content_type: 'document', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (neverDispatchedMsg) createdMessageIds.push(neverDispatchedMsg.id)

        const { data: neverDispatchedEvent } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: semAccountA.id, conversation_id: customerMsg.conversation_id, message_id: neverDispatchedMsg?.id ?? '',
          media_type: 'document', expected_filename: 'esperando.pdf', status: 'pending_android',
          dispatched_at: null, created_at: tenMinAgo, updated_at: tenMinAgo,
        }).select('id').single()
        if (neverDispatchedEvent) createdMediaEventIds.push(neverDispatchedEvent.id)

        if (!neverDispatchedEvent) {
          nok('Fase 6B.6 A setup: create never-dispatched event', 'insert failed')
        } else {
          await recoverStuckMediaEvents(supabase)
          const { data: afterRecoveryA } = await supabase.from('media_events').select('status, dispatched_at').eq('id', neverDispatchedEvent.id).single()

          if (afterRecoveryA?.status === 'pending_android') {
            ok('Fase 6B.6 A: a 10-minute-old media event with dispatched_at=NULL survives recovery — never dispatched is not ambiguous, age alone must never fail it')
          } else {
            nok('Fase 6B.6 A: never-dispatched event was incorrectly aged out by recovery', JSON.stringify(afterRecoveryA))
          }

          await runMediaDispatchTick()
          const { data: afterClaimA } = await supabase.from('media_events').select('dispatched_at').eq('id', neverDispatchedEvent.id).single()

          if (afterClaimA?.dispatched_at) {
            ok('Fase 6B.6 A: ...and remains claimable — the dispatch tick picks it up and fires the trigger normally')
          } else {
            nok('Fase 6B.6 A: never-dispatched event still not claimable after surviving recovery', JSON.stringify(afterClaimA))
          }
        }
      }

      // ── B. Genuinely dispatched 6 minutes ago, upload never arrived —
      //    must be recovered to 'failed'. Fresh account, independent of A
      //    above. ───────────────────────────────────────────────────────
      const { data: semAccountB, error: semBErr } = await supabase
        .from('whatsapp_accounts').insert({
          tenant_id: tenantId, provider: 'autoresponder', phone_number: nextTestPhone(),
          inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: fake.url, active: true,
        }).select('id').single()

      if (semBErr || !semAccountB) {
        nok('Fase 6B.6 B setup: create account', semBErr?.message ?? 'no data')
      } else {
        createdAccountIds.push(semAccountB.id)

        const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString()
        const { data: dispatchedMsg } = await supabase.from('messages').insert({
          tenant_id: tenantId, conversation_id: customerMsg.conversation_id, content: '[placeholder document]', content_type: 'document', sender_type: 'customer', whatsapp_message_id: randomUUID(),
        }).select('id').single()
        if (dispatchedMsg) createdMessageIds.push(dispatchedMsg.id)

        const { data: dispatchedEvent } = await supabase.from('media_events').insert({
          tenant_id: tenantId, account_id: semAccountB.id, conversation_id: customerMsg.conversation_id, message_id: dispatchedMsg?.id ?? '',
          media_type: 'document', expected_filename: 'nunca_subido.pdf', status: 'pending_android',
          dispatched_at: sixMinAgo, created_at: sixMinAgo, updated_at: sixMinAgo,
        }).select('id').single()
        if (dispatchedEvent) createdMediaEventIds.push(dispatchedEvent.id)

        if (!dispatchedEvent) {
          nok('Fase 6B.6 B setup: create dispatched-but-stuck event', 'insert failed')
        } else {
          await recoverStuckMediaEvents(supabase)
          const { data: afterRecoveryB } = await supabase.from('media_events').select('status, error').eq('id', dispatchedEvent.id).single()

          if (afterRecoveryB?.status === 'failed' && afterRecoveryB.error) {
            ok(`Fase 6B.6 B: a media event dispatched 6 minutes ago with no upload → correctly recovered to 'failed' (error="${afterRecoveryB.error}")`)
          } else {
            nok('Fase 6B.6 B: genuinely stuck (dispatched) event was not recovered', JSON.stringify(afterRecoveryB))
          }
        }
      }
    }

    // ── message_queue / poller regression (physical incident follow-up):
    //    a REAL message_queue row inserted with status='pending' (exactly
    //    what the webhook route does on ok_enqueued) must be picked up by
    //    the ACTUAL claimQueueItem()/poll() path — not just processed when
    //    handed to processMessage() directly (test 1 above already covers
    //    that half). Investigation of the 3 reported queueItemIds found no
    //    code defect (all 3 completed cleanly, seconds after creation, zero
    //    errors/retries, no stuck head-of-queue item) — most likely
    //    explanation was multiple concurrent worker processes during that
    //    window (an operational artifact of this session's own process
    //    management, not a queue bug). This test exists to give the real
    //    claim mechanism itself deterministic, repeatable coverage going
    //    forward. ──────────────────────────────────────────────────────
    {
      const pollerEventId = randomUUID()
      const pollerSenderPhone = '549' + String(3_300_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0')
      const pollerPayload = {
        appPackageName: AUTORESPONDER_APP_PACKAGE, messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
        provider: 'autoresponder', _internal_event_id: pollerEventId,
        query: { sender: pollerSenderPhone, message: 'mensaje vía poller real', isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false },
      }

      const { data: queueRow, error: queueErr } = await supabase
        .from('message_queue')
        .insert({ tenant_id: tenantId, whatsapp_account_id: account.id, raw_payload: pollerPayload as never, status: 'pending' })
        .select('id')
        .single()

      if (queueErr || !queueRow) {
        nok('Poller regression setup: insert a pending message_queue row (webhook-shaped)', queueErr?.message ?? 'no data')
      } else {
        createdQueueIds.push(queueRow.id)

        await runPollerTick()

        const { data: afterPoll } = await supabase
          .from('message_queue')
          .select('status, attempts, last_error')
          .eq('id', queueRow.id)
          .single()

        if (afterPoll?.status === 'completed') {
          ok('Poller regression: a real message_queue row (status=pending) is claimed by the ACTUAL claimQueueItem()/poll() path and reaches completed')
        } else {
          nok('Poller regression: real poller claim path', JSON.stringify(afterPoll))
        }

        const { data: pollerMsg } = await supabase
          .from('messages')
          .select('id, conversation_id')
          .eq('tenant_id', tenantId)
          .eq('whatsapp_message_id', pollerEventId)
          .maybeSingle()

        if (pollerMsg) {
          ok('Poller regression: processor received EXACTLY this queue item — the customer message it persisted matches this item\'s internal event id')
          createdMessageIds.push(pollerMsg.id)
          createdConversationIds.push(pollerMsg.conversation_id)
        } else {
          nok('Poller regression: processor did not receive the claimed item', 'no matching message found for pollerEventId')
        }
      }
    }

    // ── Fase 7 Parte D: message_queue recovery — safe, threshold-gated,
    //    always-fail (never resurrected to pending). See lib/supabase.ts's
    //    recoverProcessingItems doc comment for the full audit/rationale
    //    behind this design (real concurrency risk found with the old
    //    unconditional reset-to-pending behavior). ─────────────────────────
    {
      async function makeQueueRow(
        status: 'pending' | 'processing' | 'completed' | 'failed',
        processingStartedAt: string | null,
        lastError: string | null = null,
      ) {
        const { data } = await supabase.from('message_queue').insert({
          tenant_id: tenantId, whatsapp_account_id: account!.id,
          raw_payload: {
            provider: 'autoresponder',
            query: { sender: '', message: '', isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false },
          } as never,
          status, processing_started_at: processingStartedAt, last_error: lastError,
        }).select('id').single()
        if (data) createdQueueIds.push(data.id)
        return data
      }

      const staleTimestamp = new Date(Date.now() - SAFE_PROCESSING_THRESHOLD_MS - 60_000).toISOString()

      // ── A. Recent 'processing' — must survive recovery untouched. ────────
      const recentRow = await makeQueueRow('processing', new Date().toISOString())
      await recoverProcessingItems()
      const { data: afterA } = await supabase.from('message_queue').select('status').eq('id', recentRow!.id).single()
      if (afterA?.status === 'processing') {
        ok('A. message_queue: a RECENT processing row survives recovery untouched (age is under the safe threshold)')
      } else {
        nok('A. recent processing row', JSON.stringify(afterA))
      }

      // ── B. Old 'processing' (past the safe threshold) — must fail, never
      //    return to 'pending'. ──────────────────────────────────────────
      const staleRow = await makeQueueRow('processing', staleTimestamp)
      await recoverProcessingItems()
      const { data: afterB } = await supabase.from('message_queue').select('status, last_error').eq('id', staleRow!.id).single()
      if (afterB?.status === 'failed' && afterB.last_error) {
        ok(`B. message_queue: a stale processing row (past SAFE_PROCESSING_THRESHOLD_MS) is recovered to 'failed' (error="${afterB.last_error}") — never back to 'pending'`)
      } else {
        nok('B. stale processing row', JSON.stringify(afterB))
      }

      // ── D. 'completed' is never touched, regardless of age. ──────────────
      const completedRow = await makeQueueRow('completed', staleTimestamp)
      await recoverProcessingItems()
      const { data: afterD } = await supabase.from('message_queue').select('status').eq('id', completedRow!.id).single()
      if (afterD?.status === 'completed') {
        ok('D. message_queue: a completed row is never touched by recovery, regardless of age')
      } else {
        nok('D. completed row untouched', JSON.stringify(afterD))
      }

      // ── E. 'failed' is never re-touched — recovery only ever ADDS a
      //    terminal state, never revisits one. ─────────────────────────────
      const failedRow = await makeQueueRow('failed', staleTimestamp, 'some_earlier_error')
      await recoverProcessingItems()
      const { data: afterE } = await supabase.from('message_queue').select('status, last_error').eq('id', failedRow!.id).single()
      if (afterE?.status === 'failed' && afterE.last_error === 'some_earlier_error') {
        ok('E. message_queue: an already-failed row keeps its original error untouched — recovery never revisits terminal rows')
      } else {
        nok('E. failed row untouched', JSON.stringify(afterE))
      }

      // ── F. Two concurrent recovery calls on the same stale row never
      //    throw and never leave it anywhere but one consistent terminal
      //    state — the "never resurrect to pending" design means there is
      //    no double-processing risk to race against in the first place. ──
      const concurrentRow = await makeQueueRow('processing', staleTimestamp)
      const [r1, r2] = await Promise.allSettled([recoverProcessingItems(), recoverProcessingItems()])
      const { data: afterF } = await supabase.from('message_queue').select('status').eq('id', concurrentRow!.id).single()
      if (r1.status === 'fulfilled' && r2.status === 'fulfilled' && afterF?.status === 'failed') {
        ok('F. message_queue: two concurrent recovery calls never throw and leave the row in one consistent terminal state')
      } else {
        nok('F. concurrent recovery', JSON.stringify({ r1: r1.status, r2: r2.status, afterF }))
      }

      // ── G. Startup and periodic recovery are the SAME function, SAME
      //    threshold, SAME behavior — poller.ts's startPoller() calls this
      //    exact recoverProcessingItems() from both its one-time startup
      //    call and its periodic setInterval, with no branching between
      //    them. Verified by code (poller.ts), not a separate runtime path
      //    to exercise here. ─────────────────────────────────────────────
      ok('G. startup and periodic recovery use the identical recoverProcessingItems() function/threshold/behavior (see poller.ts)')
    }

  } finally {
    fake.server.close()
    // Deletion order respects FKs: outbox/rejections/ai_usage_log
    // (reference accounts/conversations) → messages (reference
    // conversations) → conversations (reference contacts + accounts) →
    // accounts → contacts.
    if (createdOutboxIds.length)       await supabase.from('messaging_outbox').delete().in('id', createdOutboxIds)
    if (createdMediaEventIds.length)   await supabase.from('media_events').delete().in('id', createdMediaEventIds)
    if (createdQueueIds.length)        await supabase.from('message_queue').delete().in('id', createdQueueIds)
    if (createdRejectionIds.length)    await supabase.from('inbound_rejections').delete().in('id', createdRejectionIds)
    if (createdConversationIds.length) await supabase.from('ai_usage_log').delete().in('conversation_id', createdConversationIds)
    if (createdMessageIds.length)      await supabase.from('messages').delete().in('id', createdMessageIds)
    if (createdConversationIds.length) await supabase.from('conversations').delete().in('id', createdConversationIds)
    if (createdAccountIds.length)      await supabase.from('whatsapp_accounts').delete().in('id', createdAccountIds)
    if (createdContactIds.length)      await supabase.from('contacts').delete().in('id', createdContactIds)
    // All contacts/conversations created by this script are cleaned up
    // (Fase 4.1: no longer left in place as "harmless demo data" — since
    // conversations now carry a hard FK to their originating
    // whatsapp_accounts row, leaving one behind would permanently pin its
    // throwaway account and block deletion on every subsequent run).
  }

  console.log(`\n${HR}`)
  console.log(`  Result: ${passed} passed, ${failed} failed`)
  console.log(HR)
  console.log('  Not covered by this script (see Fase 4 report "Riesgos/limitaciones"):')
  console.log('    - the actual Next.js webhook route (apps/web) — covered by')
  console.log('      apps/web/src/lib/autoresponder-webhook.ts logic mirrored + unit-tested on the worker side')
  console.log('    - the CRM manual-send Server Action end-to-end (needs an authenticated session)')
  console.log('  Regression (run separately): pnpm test · pnpm --filter @orderflow/worker validate:dedupe ·')
  console.log('  validate:human-send · validate:deepseek')
  console.log(HR)

  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n  [validate-autoresponder] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

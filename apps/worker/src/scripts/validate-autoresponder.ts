/**
 * Fase 2A (AUTORESPONDER-ONLY) integration validation.
 *
 * Replaces the previous Fase 4-9 script, which was mostly a harness for the
 * MacroDroid transports (messaging_outbox dispatcher, media_events
 * dispatcher, outbound ACK, per-device leases, cross-queue serialization).
 * All of that code was deleted in Fase 2A, so those scenarios no longer
 * exist to test. What remains here is the flow that IS the product now:
 *
 *   webhook-shaped message_queue row
 *     → processMessage(item, { timeoutMs })      (the real pipeline)
 *     → buildContext → DeepSeek → deliverAIReply
 *     → reply captured synchronously (replies[])
 *
 * Runs against the REAL Supabase target (guarded by assertSafeSupabaseTarget)
 * and the REAL DeepSeek API. Creates only throwaway rows and deletes them in
 * `finally`.
 *
 * Usage:  pnpm --filter @orderflow/worker validate:autoresponder
 * Env:    DEMO_TENANT_ID (required — run `pnpm seed:demo` first)
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { randomUUID, randomBytes } from 'node:crypto'
import { createClient } from '../lib/supabase'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import { hashDeviceToken } from '../lib/device-token'
import { processMessage } from '../processor'
import { AUTORESPONDER_APP_PACKAGE, WHATSAPP_BUSINESS_PACKAGE } from '../providers/autoresponder/inbound'
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

const SYNC_TIMEOUT_MS = Number(process.env.AUTORESPONDER_SYNC_TIMEOUT_MS ?? 20_000)

function queueRowFor(tenantId: string, accountId: string, payload: unknown): QueueRow {
  const now = new Date().toISOString()
  return {
    id: randomUUID(), tenant_id: tenantId, whatsapp_account_id: accountId,
    raw_payload: payload as QueueRow['raw_payload'], status: 'processing', attempts: 0,
    last_error: null, processed_at: null, processing_started_at: now, scheduled_at: now,
    created_at: now, updated_at: now,
  }
}

function autoResponderPayload(sender: string, message: string) {
  return {
    appPackageName:       AUTORESPONDER_APP_PACKAGE,
    messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
    provider:             'autoresponder' as const,
    _internal_event_id:   randomUUID(),
    query: {
      sender, message, isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false,
    },
  }
}

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — AutoResponder-only integration validation (real DB, real DeepSeek)')
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

  const createdAccountIds:      string[] = []
  const createdConversationIds: string[] = []
  const createdContactIds:      string[] = []

  try {
    // ── Setup: a throwaway AutoResponder account WITHOUT macrodroid_webhook_url ──
    let phoneCounter = 0
    const phoneBase = 4_000_000_000 + Math.floor(Math.random() * 900_000_000)
    const nextPhone = () => '549' + String(phoneBase + (++phoneCounter)).padStart(10, '0')

    const { data: account, error: acctErr } = await supabase
      .from('whatsapp_accounts')
      .insert({
        tenant_id:          tenantId,
        provider:           'autoresponder',
        phone_number:       nextPhone(),
        inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')),
        active:             true,
        // macrodroid_webhook_url deliberately omitted — Fase 2A §J
      })
      .select('id, macrodroid_webhook_url')
      .single()

    if (acctErr || !account) {
      nok('Setup: create throwaway autoresponder account', acctErr?.message ?? 'no data')
      throw new Error('cannot continue without an account')
    }
    createdAccountIds.push(account.id)

    if (account.macrodroid_webhook_url === null) {
      ok('J. Setup: an AutoResponder account is created with NO macrodroid_webhook_url (constraint allows it)')
    } else {
      nok('J. Setup: macrodroid_webhook_url must not be required', String(account.macrodroid_webhook_url))
    }

    // ── C. Normal text message → synchronous reply ────────────────────────────
    const senderPhone = '549' + String(3_200_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0')
    const textPayload = autoResponderPayload(senderPhone, 'Hola, busco un depto en Buenos Aires para 2 personas')
    const textResult  = await processMessage(
      queueRowFor(tenantId, account.id, textPayload),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )

    const replyText = textResult?.replyText ?? null
    if (replyText && replyText.trim().length > 0) {
      ok(`C. Normal message → synchronous replies[] text ("${replyText.slice(0, 60)}...")`)
    } else {
      nok('C. Normal message → synchronous reply', `got: ${JSON.stringify(textResult)}`)
    }

    // ── F. Persistence: inbound + AI message ──────────────────────────────────
    const { data: customerMsg } = await supabase
      .from('messages')
      .select('id, conversation_id')
      .eq('tenant_id', tenantId)
      .eq('whatsapp_message_id', textPayload._internal_event_id)
      .maybeSingle()

    if (!customerMsg) {
      nok('F. Inbound customer message persisted', 'not found')
      throw new Error('cannot continue without the customer message')
    }
    ok('F. Inbound customer message persisted')
    createdConversationIds.push(customerMsg.conversation_id)

    const { data: contact } = await supabase
      .from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', senderPhone).maybeSingle()
    if (contact) createdContactIds.push(contact.id)

    const { data: aiMsgs } = await supabase
      .from('messages').select('id, content')
      .eq('conversation_id', customerMsg.conversation_id).eq('sender_type', 'ai')
    if (aiMsgs?.length === 1) {
      ok('F. Exactly one AI message persisted for the delivered reply')
    } else {
      nok('F. AI message persistence', `expected 1, got ${aiMsgs?.length}`)
    }

    // ── E. NEVER messaging_outbox ─────────────────────────────────────────────
    const { data: outboxRows } = await supabase
      .from('messaging_outbox').select('id').eq('conversation_id', customerMsg.conversation_id)
    if (outboxRows?.length === 0) {
      ok('E. Zero messaging_outbox rows for the conversation (MacroDroid transport is gone)')
    } else {
      nok('E. messaging_outbox must stay empty', `got ${outboxRows?.length} row(s)`)
    }

    // ── H. Media (audio) → fixed fallback, no media_events, no outbox ─────────
    // The literal placeholder AutoResponder sends for a voice note — see
    // providers/autoresponder/media-parser.ts's VOICE_RE. Using anything
    // else here would be classified as plain text and silently exercise the
    // wrong path.
    const audioPayload = autoResponderPayload(senderPhone, '🎤 Voice message (0:07)')
    const audioResult  = await processMessage(
      queueRowFor(tenantId, account.id, audioPayload),
      { timeoutMs: SYNC_TIMEOUT_MS },
    )
    const audioReply = audioResult?.replyText ?? ''
    if (/audio/i.test(audioReply) && /texto/i.test(audioReply)) {
      ok(`H. Audio → fixed "send it as text" reply, delivered synchronously ("${audioReply.slice(0, 50)}...")`)
    } else {
      nok('H. Audio fallback reply', `got: ${JSON.stringify(audioReply)}`)
    }

    const { data: mediaEvents } = await supabase
      .from('media_events').select('id').eq('conversation_id', customerMsg.conversation_id)
    if (mediaEvents?.length === 0) {
      ok('F/H. Zero media_events rows created (MacroDroid media extraction is gone)')
    } else {
      nok('F/H. media_events must stay empty', `got ${mediaEvents?.length} row(s)`)
    }

    // ── D. Timeout → no reply, no ghost AI message, no outbox ─────────────────
    const timeoutPayload = autoResponderPayload(senderPhone, '¿Cuál es la dirección exacta y cómo llego en auto?')
    const timeoutResult  = await processMessage(
      queueRowFor(tenantId, account.id, timeoutPayload),
      { timeoutMs: 1 }, // guaranteed to expire before DeepSeek can answer
    )
    if ((timeoutResult?.replyText ?? null) === null) {
      ok('D. Sync budget exceeded → replyText null (webhook answers {"replies":[]})')
    } else {
      nok('D. Timeout must produce no reply', JSON.stringify(timeoutResult))
    }

    const { data: ghostMsg } = await supabase
      .from('messages').select('id')
      .eq('tenant_id', tenantId).eq('sender_type', 'ai')
      .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', timeoutPayload._internal_event_id)
      .maybeSingle()
    if (!ghostMsg) {
      ok('D. No "ghost" AI message persisted for the undelivered reply')
    } else {
      nok('D. Undelivered reply must not be persisted', `message ${ghostMsg.id}`)
    }

    const { data: outboxAfterTimeout } = await supabase
      .from('messaging_outbox').select('id').eq('conversation_id', customerMsg.conversation_id)
    if (outboxAfterTimeout?.length === 0) {
      ok('E/D. Still zero messaging_outbox rows after a timeout (no fallback transport)')
    } else {
      nok('E/D. Timeout must not enqueue outbox', `got ${outboxAfterTimeout?.length} row(s)`)
    }

    // ── I. Meta regression: a Meta-shaped inbound never uses the sync capture ──
    const { data: metaAccount, error: metaErr } = await supabase
      .from('whatsapp_accounts')
      .insert({
        tenant_id: tenantId, provider: 'meta', phone_number: nextPhone(),
        business_account_id: `test-baid-${randomUUID()}`,
        access_token_encrypted: 'test-dummy-token-never-used-for-real-send',
        webhook_secret: 'test-dummy-secret', active: true,
      })
      .select('id')
      .single()

    if (metaErr || !metaAccount) {
      nok('I. Meta setup', metaErr?.message ?? 'no data')
    } else {
      createdAccountIds.push(metaAccount.id)
      const metaPhone = '549' + String(3_100_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0')
      const metaWamid = `wamid.test-${randomUUID()}`
      const metaPayload = {
        entry: [{ changes: [{ value: { messages: [{
          from: metaPhone, id: metaWamid, type: 'text', text: { body: 'Hola, consulta por Meta' },
        }] } }] }],
      }
      // syncOptions passed deliberately: a Meta conversation must IGNORE the
      // sync capture (its delivery is the Graph API call) and therefore
      // return no captured text, even when a sync window is open.
      const metaResult = await processMessage(
        queueRowFor(tenantId, metaAccount.id, metaPayload),
        { timeoutMs: SYNC_TIMEOUT_MS },
      )

      if ((metaResult?.replyText ?? null) === null) {
        ok('I. Meta inbound never captures into replies[] — it routes through the Graph API path')
      } else {
        nok('I. Meta must not use the AutoResponder sync capture', JSON.stringify(metaResult))
      }

      const { data: metaMsg } = await supabase
        .from('messages').select('id, conversation_id')
        .eq('tenant_id', tenantId).eq('whatsapp_message_id', metaWamid).maybeSingle()
      if (metaMsg) {
        createdConversationIds.push(metaMsg.conversation_id)
        const { data: metaContact } = await supabase
          .from('contacts').select('id').eq('tenant_id', tenantId).eq('phone', metaPhone).maybeSingle()
        if (metaContact) createdContactIds.push(metaContact.id)

        const { data: metaOutbox } = await supabase
          .from('messaging_outbox').select('id').eq('conversation_id', metaMsg.conversation_id)
        if (metaOutbox?.length === 0) {
          ok('I. Meta conversation creates no messaging_outbox rows either')
        } else {
          nok('I. Meta outbox', `got ${metaOutbox?.length} row(s)`)
        }
      }
    }
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────────
    const supa = createClient()
    for (const convId of createdConversationIds) {
      await supa.from('messages').delete().eq('conversation_id', convId)
      await supa.from('conversations').delete().eq('id', convId)
    }
    for (const contactId of createdContactIds) {
      await supa.from('contacts').delete().eq('id', contactId)
    }
    for (const accountId of createdAccountIds) {
      await supa.from('whatsapp_accounts').delete().eq('id', accountId)
    }
    console.log(`\n${HR}`)
    console.log(`  passed: ${passed}   failed: ${failed}`)
    console.log(HR)
    if (failed > 0) process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('\n  [validate-autoresponder] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

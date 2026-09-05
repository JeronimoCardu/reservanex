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
import { executeEscalateToHuman } from '../tools/escalate-to-human'
import { handoffModeForProvider } from '../lib/human-handoff'
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

    // ═══ Fase 2B — AI → HUMAN → AI handoff ═══════════════════════════════════
    // Uses a short window so the whole lifecycle runs in seconds instead of
    // an hour. This is exactly what HUMAN_HANDOFF_TIMEOUT_MS exists for (§5).
    const previousTimeout = process.env.HUMAN_HANDOFF_TIMEOUT_MS
    process.env.HUMAN_HANDOFF_TIMEOUT_MS = '4000'
    try {
      const convId = customerMsg.conversation_id

      // ── 2B-A. Handoff: force it deterministically through the same
      //    structured mechanism the AI uses (escalate_to_human).
      await executeEscalateToHuman(tenantId, convId, 'human_requested', handoffModeForProvider('autoresponder'))

      const { data: afterHandoff } = await supabase
        .from('conversations').select('ai_mode, human_until').eq('id', convId).single()
      const untilMs = afterHandoff?.human_until ? new Date(afterHandoff.human_until).getTime() : 0
      if (afterHandoff?.ai_mode !== 'autonomous' && untilMs > Date.now()) {
        ok('2B-A. Handoff → ai_mode non-autonomous and human_until set in the future')
      } else {
        nok('2B-A. Handoff state', JSON.stringify(afterHandoff))
      }

      // ── 2B-B. Inbound during HUMAN: persisted, window slid, silent, no LLM.
      const duringPayload = autoResponderPayload(senderPhone, '¿Hay alguien ahí? Sigo esperando')
      const beforeAiCount = (await supabase.from('messages').select('id')
        .eq('conversation_id', convId).eq('sender_type', 'ai')).data?.length ?? 0

      const duringResult = await processMessage(
        queueRowFor(tenantId, account.id, duringPayload),
        { timeoutMs: SYNC_TIMEOUT_MS },
      )

      if ((duringResult?.replyText ?? null) === null) {
        ok('2B-B. Inbound during HUMAN → replies[] empty (silence)')
      } else {
        nok('2B-B. Must stay silent during HUMAN', JSON.stringify(duringResult))
      }

      const { data: duringInbound } = await supabase
        .from('messages').select('id, created_at')
        .eq('tenant_id', tenantId).eq('whatsapp_message_id', duringPayload._internal_event_id).maybeSingle()
      if (duringInbound) {
        ok('2B-B. The inbound sent during HUMAN is still persisted (audit/metrics)')
      } else {
        nok('2B-B. Inbound during HUMAN must be persisted', 'not found')
      }

      const afterAiCount = (await supabase.from('messages').select('id')
        .eq('conversation_id', convId).eq('sender_type', 'ai')).data?.length ?? 0
      if (afterAiCount === beforeAiCount) {
        ok('2B-B. No AI message was created during HUMAN (DeepSeek not called)')
      } else {
        nok('2B-B. AI message count changed during HUMAN', `${beforeAiCount} → ${afterAiCount}`)
      }

      // ── 2B-C. The window slid forward on that inbound.
      const { data: afterSlide } = await supabase
        .from('conversations').select('human_until').eq('id', convId).single()
      const slidMs = afterSlide?.human_until ? new Date(afterSlide.human_until).getTime() : 0
      if (slidMs > untilMs) {
        ok('2B-C. Each inbound during HUMAN extends the sliding window')
      } else {
        nok('2B-C. Sliding window did not extend', `before=${untilMs} after=${slidMs}`)
      }

      // ── 2B-G. Media during HUMAN → silence, NOT the media fallback (§18).
      const mediaDuringPayload = autoResponderPayload(senderPhone, '🎤 Voice message (0:05)')
      const mediaDuringResult  = await processMessage(
        queueRowFor(tenantId, account.id, mediaDuringPayload),
        { timeoutMs: SYNC_TIMEOUT_MS },
      )
      if ((mediaDuringResult?.replyText ?? null) === null) {
        ok('2B-G. Media during HUMAN → silence, never the "send it as text" fallback')
      } else {
        nok('2B-G. Media during HUMAN must be silent', JSON.stringify(mediaDuringResult))
      }

      // ── 2B-D/E/F. Let the window lapse, then the next inbound reactivates
      //    the AI, is answered, and the context is bounded at that message.
      await new Promise((r) => setTimeout(r, 4500))

      const reactivatePayload = autoResponderPayload(senderPhone, '¿Seguimos? Quiero avanzar con la reserva')
      const reactivateResult  = await processMessage(
        queueRowFor(tenantId, account.id, reactivatePayload),
        { timeoutMs: SYNC_TIMEOUT_MS },
      )

      if ((reactivateResult?.replyText ?? '').trim().length > 0) {
        ok(`2B-D. Expired window → THIS same inbound is answered by the AI ("${(reactivateResult?.replyText ?? '').slice(0, 45)}...")`)
      } else {
        nok('2B-D. Expired window must reactivate the AI for this inbound', JSON.stringify(reactivateResult))
      }

      const { data: afterReactivate } = await supabase
        .from('conversations').select('ai_mode, human_until, ai_context_reset_at').eq('id', convId).single()
      if (afterReactivate?.ai_mode === 'autonomous' && afterReactivate.human_until === null) {
        ok('2B-D. Conversation is back to autonomous with the window cleared')
      } else {
        nok('2B-D. Post-expiry conversation state', JSON.stringify(afterReactivate))
      }

      const { data: reactivateInbound } = await supabase
        .from('messages').select('created_at')
        .eq('tenant_id', tenantId).eq('whatsapp_message_id', reactivatePayload._internal_event_id).maybeSingle()

      if (afterReactivate?.ai_context_reset_at && reactivateInbound?.created_at
          && new Date(afterReactivate.ai_context_reset_at).getTime() === new Date(reactivateInbound.created_at).getTime()) {
        ok('2B-E/F. ai_context_reset_at == the reactivating inbound\'s own timestamp (it is IN context; everything before is OUT)')
      } else {
        nok('2B-E/F. Context boundary', `reset=${afterReactivate?.ai_context_reset_at} inbound=${reactivateInbound?.created_at}`)
      }

      // ── 2B-E (effect, not just the stamp): the boundary really does cut the
      //    transcript. Same filter context/responder.ts applies to build the
      //    prompt — everything from before the human stretch is excluded,
      //    the reactivating inbound is included.
      if (afterReactivate?.ai_context_reset_at) {
        const allMsgs = (await supabase.from('messages').select('id')
          .eq('conversation_id', convId)).data?.length ?? 0
        const visibleMsgs = (await supabase.from('messages').select('id, whatsapp_message_id')
          .eq('conversation_id', convId)
          .gte('created_at', afterReactivate.ai_context_reset_at)).data ?? []

        const includesReactivator = visibleMsgs.some(
          (m) => m.whatsapp_message_id === reactivatePayload._internal_event_id,
        )
        if (visibleMsgs.length < allMsgs && includesReactivator) {
          ok(`2B-E. Context filter excludes the pre-handoff transcript (${allMsgs} total → ${visibleMsgs.length} visible) and keeps the reactivating message`)
        } else {
          nok('2B-E. Context filter effect', `all=${allMsgs} visible=${visibleMsgs.length} includesReactivator=${includesReactivator}`)
        }
      }

      // ── 2B-J. Concurrency (§14 C): two inbounds racing on the SAME expiry
      //    must not both perform the reactivation. Re-arm a window, let it
      //    lapse, then fire two processMessage calls at once. timeoutMs=1
      //    aborts the LLM immediately — the handoff gate runs before it, so
      //    the race is exercised without burning two DeepSeek turns.
      await executeEscalateToHuman(tenantId, convId, 'human_requested', handoffModeForProvider('autoresponder'))
      await supabase
        .from('conversations')
        .update({ human_until: new Date(Date.now() - 1000).toISOString() })
        .eq('id', convId)

      const raceA = autoResponderPayload(senderPhone, 'carrera A')
      const raceB = autoResponderPayload(senderPhone, 'carrera B')
      await Promise.all([
        processMessage(queueRowFor(tenantId, account.id, raceA), { timeoutMs: 1 }).catch(() => undefined),
        processMessage(queueRowFor(tenantId, account.id, raceB), { timeoutMs: 1 }).catch(() => undefined),
      ])

      const { data: afterRace } = await supabase
        .from('conversations').select('ai_mode, human_until, ai_context_reset_at').eq('id', convId).single()
      const { data: raceInbounds } = await supabase
        .from('messages').select('created_at, whatsapp_message_id')
        .eq('tenant_id', tenantId)
        .in('whatsapp_message_id', [raceA._internal_event_id, raceB._internal_event_id])

      const resetMatchesOneInbound = (raceInbounds ?? []).some(
        (m) => afterRace?.ai_context_reset_at
          && new Date(m.created_at).getTime() === new Date(afterRace.ai_context_reset_at).getTime(),
      )
      if (afterRace?.ai_mode === 'autonomous' && afterRace.human_until === null && resetMatchesOneInbound) {
        ok('2B-J. Two inbounds racing on the same expiry → exactly one coherent reactivation (guarded UPDATE)')
      } else {
        nok('2B-J. Concurrent reactivation', JSON.stringify(afterRace))
      }

      const { data: outboxAfter2B } = await supabase
        .from('messaging_outbox').select('id').eq('conversation_id', convId)
      if (outboxAfter2B?.length === 0) {
        ok('2B-L. The whole handoff lifecycle created zero messaging_outbox rows')
      } else {
        nok('2B-L. Handoff must not touch outbox', `got ${outboxAfter2B?.length}`)
      }
    } finally {
      if (previousTimeout === undefined) delete process.env.HUMAN_HANDOFF_TIMEOUT_MS
      else process.env.HUMAN_HANDOFF_TIMEOUT_MS = previousTimeout
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

        // ── 2B-K. Meta handoff semantics must NOT have changed. Before Fase
        //    2B a Meta escalation left the conversation manual FOREVER, until
        //    someone reactivated the AI from the CRM. Reusing
        //    executeEscalateToHuman() must not have given Meta the sliding
        //    window: human_until stays NULL and the conversation stays manual
        //    even far past any timeout.
        await executeEscalateToHuman(
          tenantId, metaMsg.conversation_id, 'human_requested', handoffModeForProvider('meta'),
        )
        const { data: metaAfterHandoff } = await supabase
          .from('conversations').select('ai_mode, human_until')
          .eq('id', metaMsg.conversation_id).single()

        if (metaAfterHandoff?.ai_mode !== 'autonomous' && metaAfterHandoff?.human_until === null) {
          ok('2B-K. Meta handoff stays PERMANENT — manual with human_until NULL (pre-Fase-2B semantics preserved)')
        } else {
          nok('2B-K. Meta must not inherit the sliding window', JSON.stringify(metaAfterHandoff))
        }

        // And a later customer inbound must NOT auto-reactivate it.
        const metaFollowUp = `wamid.test-${randomUUID()}`
        await processMessage(
          queueRowFor(tenantId, metaAccount.id, {
            entry: [{ changes: [{ value: { messages: [{
              from: metaPhone, id: metaFollowUp, type: 'text', text: { body: 'sigo ahi?' },
            }] } }] }],
          }),
          { timeoutMs: SYNC_TIMEOUT_MS },
        )
        const { data: metaAfterFollowUp } = await supabase
          .from('conversations').select('ai_mode, human_until, ai_context_reset_at')
          .eq('id', metaMsg.conversation_id).single()

        if (metaAfterFollowUp?.ai_mode !== 'autonomous'
            && metaAfterFollowUp?.human_until === null
            && metaAfterFollowUp?.ai_context_reset_at === null) {
          ok('2B-K. A later Meta inbound does not auto-reactivate the AI and never stamps a context reset')
        } else {
          nok('2B-K. Meta auto-reactivation regression', JSON.stringify(metaAfterFollowUp))
        }
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

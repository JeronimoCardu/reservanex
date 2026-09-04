/**
 * Validation script: verifies the ping-pong dedupe guarantee.
 *
 * Tests (no real OpenRouter or Meta calls):
 *
 *   1. Duplicate wamid → unique index blocks second AI insert (23505)
 *   2. Processor dedupe query → finds existing AI reply for that wamid
 *   3. Invariant audit → no existing customer message has > 1 AI reply
 *   4. Manual mode → customer message saved, generateAIReply returns null,
 *                    no AI message inserted, no LLM call
 *   5. New distinct message → first run: dedupe query empty (allowed);
 *                             after write: dedupe query finds reply (skip);
 *                             DB index blocks a second insert (23505)
 *   6. Assisted mode → like Test 4 but ai_mode='assisted':
 *                      generateAIReply returns null, no AI message inserted
 *
 * Cleanup: all test rows are deleted in the finally block even on failure.
 * ai_mode is restored to its original value after tests 4 and 6.
 *
 * Usage:  pnpm validate:dedupe
 * Env:    DEMO_TENANT_ID (required — no fallback to "first active tenant").
 */

import path from 'path'
import { config } from 'dotenv'

// Load .env.local before any module that reads env vars (supabase client, responder)
config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createClient } from '../lib/supabase'
import { generateAIReply } from '../context/responder'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import type { MessageContext } from '../context/builder'

const HR   = '─'.repeat(64)
const PASS = '  ✓'
const FAIL = '  ✗'

let passed = 0
let failed = 0

function ok(label: string): void   { console.log(`${PASS} ${label}`);  passed++ }
function nok(label: string, detail?: string): void {
  console.error(`${FAIL} ${label}`)
  if (detail) console.error(`       ${detail}`)
  failed++
}

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Dedupe Validation  (6 tests, 0 LLM/Meta calls)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const supabase = createClient()

  // ── Resolve tenant ───────────────────────────────────────────────────────
  // DEMO_TENANT_ID is mandatory — no fallback to "first active tenant".
  // Run `pnpm seed:demo` first to create/print a dedicated demo tenant.
  const tenantId = process.env.DEMO_TENANT_ID ?? ''

  if (!tenantId) {
    nok(
      'Tenant resolution',
      'DEMO_TENANT_ID is required (no fallback). Run `pnpm --filter @orderflow/worker seed:demo` first.',
    )
    process.exitCode = 1
    return
  }

  const { data: tenantExists } = await supabase
    .from('tenants')
    .select('id')
    .eq('id', tenantId)
    .maybeSingle()

  if (!tenantExists) {
    nok('Tenant resolution', `DEMO_TENANT_ID=${tenantId} does not exist in this Supabase project`)
    process.exitCode = 1
    return
  }

  console.log(`\n  Tenant: ${tenantId}\n`)

  // ── Find an open conversation — used as anchor for all test rows ──────────
  // Also fetches ai_mode so we can restore it after test 4 temporarily sets
  // it to 'manual'.
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, ai_mode')
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle()

  if (!conv) {
    nok('Conversation lookup', 'No open conversation found — run pnpm demo first to create one')
    process.exitCode = 1
    return
  }

  const conversationId = conv.id
  const originalAiMode = conv.ai_mode   // saved for test 4 cleanup

  // All test message rows are tracked here; deleted in the finally block.
  const insertedIds: string[] = []
  // Set to true when test 4 updates ai_mode; cleared when it restores it.
  let aiModeNeedsReset = false

  const testWamid = `wamid.VALIDATION_TEST_${Date.now()}`

  try {
    // ────────────────────────────────────────────────────────────────────────
    // Test 1 — DB unique index blocks a duplicate AI insert
    // ────────────────────────────────────────────────────────────────────────
    console.log('  Test 1: unique index blocks second AI reply for the same inbound wamid')

    const { data: first, error: e1 } = await supabase
      .from('messages')
      .insert({
        tenant_id:       tenantId,
        conversation_id: conversationId,
        content:         '[validation] first AI reply',
        content_type:    'text',
        sender_type:     'ai',
        metadata:        { in_reply_to_whatsapp_message_id: testWamid, reply_mode: 'autonomous' } as never,
      })
      .select('id')
      .single()

    if (e1 || !first) {
      nok('Insert first AI message', e1?.message ?? 'no data')
      return
    }
    insertedIds.push(first.id)
    ok(`First AI message inserted (${first.id})`)

    const { data: dup, error: e2 } = await supabase
      .from('messages')
      .insert({
        tenant_id:       tenantId,
        conversation_id: conversationId,
        content:         '[validation] duplicate — should be blocked',
        content_type:    'text',
        sender_type:     'ai',
        metadata:        { in_reply_to_whatsapp_message_id: testWamid, reply_mode: 'autonomous' } as never,
      })
      .select('id')
      .single()

    if (e2?.code === '23505') {
      ok('Second insert blocked by unique index (23505 unique_violation)')
    } else if (!e2 && dup) {
      // Index missing — track the rogue row for cleanup
      insertedIds.push(dup.id)
      nok('Second AI insert should have been blocked by unique index',
        'Got no error — apply migration 20260701000000_messages_dedupe_indexes.sql first')
    } else {
      nok('Second AI insert returned unexpected error', `code=${e2?.code} msg=${e2?.message}`)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Test 2 — Processor dedupe query finds the existing reply
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n  Test 2: processor dedupe query finds existing AI reply')

    const { data: found, error: e3 } = await supabase
      .from('messages')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('sender_type', 'ai')
      .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', testWamid)
      .maybeSingle()

    if (e3) {
      nok('Dedupe query failed', e3.message)
    } else if (!found) {
      nok('Dedupe query returned no row — processor would not skip the LLM call')
    } else if (found.id === first.id) {
      ok(`Dedupe query returns correct AI message id (${found.id})`)
    } else {
      nok('Dedupe query returned unexpected row id', `expected ${first.id}, got ${found.id}`)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Test 3 — Invariant audit: no customer message has > 1 AI reply
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n  Test 3: invariant audit — no customer message has > 1 AI reply in DB')

    const { data: customers } = await supabase
      .from('messages')
      .select('whatsapp_message_id')
      .eq('tenant_id', tenantId)
      .eq('sender_type', 'customer')
      .not('whatsapp_message_id', 'is', null)

    const wamids = (customers ?? []).map((m) => m.whatsapp_message_id as string)
    let violations = 0

    for (const wamid of wamids) {
      const { data: replies } = await supabase
        .from('messages')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('sender_type', 'ai')
        .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', wamid)

      if ((replies?.length ?? 0) > 1) {
        violations++
        console.error(`       violation: wamid ${wamid} has ${replies!.length} AI replies`)
      }
    }

    if (violations === 0) {
      ok(`No violations across ${wamids.length} customer message(s)`)
    } else {
      nok(`Found ${violations} violation(s) — multiple AI replies for the same inbound wamid`)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Test 4 — Manual mode: customer msg saved, no LLM call, no AI message
    //
    // Strategy: insert the customer message directly (as buildContext does),
    // then temporarily set ai_mode='manual' on the conversation and call
    // generateAIReply(). The responder reads ai_mode fresh from the DB at
    // step 0 and returns null immediately — no OpenRouter call is made.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n  Test 4: manual mode — customer message saved, no AI reply, no LLM call')

    const manualWamid = `wamid.VALIDATION_MANUAL_${Date.now()}`

    // a) Insert the customer message (simulates buildContext)
    const { data: custMsg, error: eCust } = await supabase
      .from('messages')
      .insert({
        tenant_id:           tenantId,
        conversation_id:     conversationId,
        content:             '[validation] manual mode test',
        content_type:        'text',
        sender_type:         'customer',
        whatsapp_message_id: manualWamid,
      })
      .select('id')
      .single()

    if (eCust || !custMsg) {
      nok('Test 4: insert customer message', eCust?.message ?? 'no data')
    } else {
      insertedIds.push(custMsg.id)
      ok('Customer message stored')
    }

    // b) Set conversation to manual mode
    const { error: eModeSet } = await supabase
      .from('conversations')
      .update({ ai_mode: 'manual' })
      .eq('id', conversationId)

    if (eModeSet) {
      nok('Test 4: set ai_mode=manual', eModeSet.message)
    } else {
      aiModeNeedsReset = true   // restored in finally even on failure

      // c) Call generateAIReply — reads ai_mode from DB, returns null immediately
      const manualCtx: MessageContext = {
        tenantId,
        conversationId,
        contactId:         'validation-stub-contact',
        contactPhone:      '5490000000000',
        contactName:       null,
        messageText:       '[validation] manual mode test',
        whatsappMessageId: manualWamid,
        whatsappAccountId: null,
        provider:          'meta',
        messageId:         'validation-stub-message-id',
        mediaType:         null,
        mediaId:           null,
        mediaMimeType:     null,
        mediaFilename:     null,
        mediaCaption:      null,
        mediaSha256:       null,
        mediaDurationSeconds: null,
        mediaPages:        null,
        propertyId:        null,
        propertyTitle:     null,
        propertySlug:      null,
        leadContext:       {},
      }

      const result = await generateAIReply(manualCtx)

      if (result === null) {
        ok('generateAIReply returned null — no LLM call for manual mode conversation')
      } else {
        nok('generateAIReply should return null for manual mode',
          `got response: "${result.text.slice(0, 80)}"`)
      }

      // d) Verify no AI message was inserted for this wamid
      const { data: spuriousAI } = await supabase
        .from('messages')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('sender_type', 'ai')
        .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', manualWamid)
        .maybeSingle()

      if (!spuriousAI) {
        ok('No AI message inserted for manual mode conversation')
      } else {
        nok('AI message was inserted despite ai_mode=manual — responder bug', spuriousAI.id)
        insertedIds.push(spuriousAI.id)
      }

      // e) Restore ai_mode immediately so test 5 runs with the original mode
      const { error: eModeRestore } = await supabase
        .from('conversations')
        .update({ ai_mode: originalAiMode })
        .eq('id', conversationId)

      if (!eModeRestore) aiModeNeedsReset = false
    }

    // ────────────────────────────────────────────────────────────────────────
    // Test 5 — New distinct message: first run allowed, second run skipped
    //
    // Strategy (no LLM/Meta calls):
    //   A. Dedupe query on brand-new wamid → null (processor would proceed)
    //   B. Simulate writeMemory by inserting AI message with correct metadata
    //   C. Dedupe query again → finds the AI reply (processor would skip)
    //   D. Second DB insert for same wamid → 23505 (DB-level enforcement)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n  Test 5: new distinct message — first run allowed, second run skipped')

    const newWamid = `wamid.VALIDATION_NEW_${Date.now()}`

    // A — dedupe query must return null for a wamid nobody has replied to yet
    const { data: beforeInsert, error: eBeforeQ } = await supabase
      .from('messages')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('sender_type', 'ai')
      .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', newWamid)
      .maybeSingle()

    if (eBeforeQ) {
      nok('Test 5A: dedupe query (before first write)', eBeforeQ.message)
    } else if (!beforeInsert) {
      ok('First run: dedupe query returns null — processor would call LLM')
    } else {
      nok('Dedupe query found a row for a brand-new wamid', `unexpected id: ${beforeInsert.id}`)
    }

    // B — simulate writeMemory for the first (and only valid) AI reply
    const { data: newAI, error: eNewAI } = await supabase
      .from('messages')
      .insert({
        tenant_id:       tenantId,
        conversation_id: conversationId,
        content:         '[validation] AI reply for new distinct message',
        content_type:    'text',
        sender_type:     'ai',
        metadata:        { in_reply_to_whatsapp_message_id: newWamid, reply_mode: 'autonomous' } as never,
      })
      .select('id')
      .single()

    if (eNewAI || !newAI) {
      nok('Test 5B: insert AI reply for new distinct wamid', eNewAI?.message ?? 'no data')
    } else {
      insertedIds.push(newAI.id)
      ok(`First run: AI reply written (${newAI.id})`)
    }

    // C — dedupe query now finds the AI reply; second run would skip LLM + sender
    const { data: afterInsert, error: eAfterQ } = await supabase
      .from('messages')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('sender_type', 'ai')
      .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', newWamid)
      .maybeSingle()

    if (eAfterQ) {
      nok('Test 5C: dedupe query (after first write)', eAfterQ.message)
    } else if (afterInsert?.id === newAI?.id) {
      ok('Second run: dedupe query finds existing reply — LLM + sender would be skipped')
    } else {
      nok('Dedupe query should find the AI reply after first write',
        `expected ${newAI?.id}, got ${afterInsert?.id}`)
    }

    // D — DB index must block a second insert, providing the deepest safety net
    const { data: blocked, error: eDup } = await supabase
      .from('messages')
      .insert({
        tenant_id:       tenantId,
        conversation_id: conversationId,
        content:         '[validation] should be blocked at DB level',
        content_type:    'text',
        sender_type:     'ai',
        metadata:        { in_reply_to_whatsapp_message_id: newWamid, reply_mode: 'autonomous' } as never,
      })
      .select('id')
      .single()

    if (eDup?.code === '23505') {
      ok('DB unique index blocks second writeMemory for same wamid (23505)')
    } else if (!eDup && blocked) {
      insertedIds.push(blocked.id)
      nok('Second insert should have been blocked by unique index',
        'Got no error — apply migration 20260701000000_messages_dedupe_indexes.sql')
    } else {
      nok('Second insert returned unexpected error', `code=${eDup?.code} msg=${eDup?.message}`)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Test 6 — Assisted mode: like Test 4 but with ai_mode='assisted'
    //
    // The responder must now skip the LLM for any mode that is not 'autonomous'.
    // This test verifies 'assisted' is treated the same as 'manual'.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n  Test 6: assisted mode — no AI reply, no LLM call')

    const assistedWamid = `wamid.VALIDATION_ASSISTED_${Date.now()}`

    // a) Insert the customer message
    const { data: assistedCust, error: eAssistedCust } = await supabase
      .from('messages')
      .insert({
        tenant_id:           tenantId,
        conversation_id:     conversationId,
        content:             '[validation] assisted mode test',
        content_type:        'text',
        sender_type:         'customer',
        whatsapp_message_id: assistedWamid,
      })
      .select('id')
      .single()

    if (eAssistedCust || !assistedCust) {
      nok('Test 6: insert customer message', eAssistedCust?.message ?? 'no data')
    } else {
      insertedIds.push(assistedCust.id)
      ok('Assisted: customer message stored')
    }

    // b) Set conversation to assisted mode
    const { error: eAssistedMode } = await supabase
      .from('conversations')
      .update({ ai_mode: 'assisted' })
      .eq('id', conversationId)

    if (eAssistedMode) {
      nok('Test 6: set ai_mode=assisted', eAssistedMode.message)
    } else {
      aiModeNeedsReset = true

      // c) Call generateAIReply — must return null for 'assisted' mode
      const assistedCtx: MessageContext = {
        tenantId,
        conversationId,
        contactId:         'validation-stub-contact',
        contactPhone:      '5490000000000',
        contactName:       null,
        messageText:       '[validation] assisted mode test',
        whatsappMessageId: assistedWamid,
        whatsappAccountId: null,
        provider:          'meta',
        messageId:         'validation-stub-message-id',
        mediaType:         null,
        mediaId:           null,
        mediaMimeType:     null,
        mediaFilename:     null,
        mediaCaption:      null,
        mediaSha256:       null,
        mediaDurationSeconds: null,
        mediaPages:        null,
        propertyId:        null,
        propertyTitle:     null,
        propertySlug:      null,
        leadContext:       {},
      }

      const assistedResult = await generateAIReply(assistedCtx)

      if (assistedResult === null) {
        ok('Assisted: generateAIReply returned null — no LLM call for assisted mode')
      } else {
        nok('generateAIReply should return null for assisted mode',
          `got response: "${assistedResult.text.slice(0, 80)}"`)
      }

      // d) Verify no AI message was inserted for this wamid
      const { data: assistedAI } = await supabase
        .from('messages')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('sender_type', 'ai')
        .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', assistedWamid)
        .maybeSingle()

      if (!assistedAI) {
        ok('Assisted: no AI message inserted for assisted mode conversation')
      } else {
        nok('AI message was inserted despite ai_mode=assisted — responder bug', assistedAI.id)
        insertedIds.push(assistedAI.id)
      }

      // e) Restore ai_mode to original
      const { error: eAssistedRestore } = await supabase
        .from('conversations')
        .update({ ai_mode: originalAiMode })
        .eq('id', conversationId)

      if (!eAssistedRestore) aiModeNeedsReset = false
    }

  } finally {
    // Restore ai_mode if test 4 set it to 'manual' and the explicit restore
    // did not run (e.g. the test was interrupted by an exception)
    if (aiModeNeedsReset) {
      await supabase
        .from('conversations')
        .update({ ai_mode: originalAiMode })
        .eq('id', conversationId)
    }
    // Delete every row inserted during this run
    if (insertedIds.length > 0) {
      await supabase.from('messages').delete().in('id', insertedIds)
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log()
  console.log(HR)
  console.log(`  Result: ${passed} passed, ${failed} failed`)
  console.log()

  if (failed > 0) {
    console.log('  Troubleshooting:')
    console.log('    · Tests 1 or 5 fail "no error on second insert":')
    console.log('      supabase db push  (applies 20260701000000_messages_dedupe_indexes.sql)')
    console.log()
    console.log('    · Tests 4 or 6 fail with a real AI response:')
    console.log('      Check step 0 of apps/worker/src/context/responder.ts —')
    console.log('      generateAIReply must skip for any mode that is not autonomous.')
    console.log(HR)
    process.exitCode = 1
  } else {
    console.log('  All automated tests passed. Manual end-to-end tests:')
    console.log()
    console.log('    pnpm demo')
    console.log('      → one inbound message → exactly one AI reply')
    console.log()
    console.log('    # Real manual-mode test against the live pipeline:')
    console.log("    UPDATE conversations SET ai_mode = 'manual' WHERE id = '<conv_id>';")
    console.log('    # Send a real WhatsApp message → customer row saved, no AI reply.')
    console.log(HR)
  }
}

main().catch((err) => {
  console.error('\n  [validate] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

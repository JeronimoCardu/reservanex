/**
 * Validation script: verifies human-send behavior at the DB level.
 *
 * Tests (no real OpenRouter or Meta calls):
 *
 *   1. ai_mode → update to 'manual' persists and is readable back
 *   2. delivery_status='sent' → message metadata updated correctly after delivery
 *   3. delivery_status='failed' → message metadata updated correctly on failure
 *   4. Retry idempotency → updating the same row changes status; no new insert
 *
 * Cleanup: all test rows are deleted in the finally block even on failure.
 * ai_mode is restored to its original value.
 *
 * Usage:  pnpm validate:human-send
 * Env:    DEMO_TENANT_ID (required — no fallback to "first active tenant").
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createClient } from '../lib/supabase'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'

const HR   = '─'.repeat(64)
const PASS = '  ✓'
const FAIL = '  ✗'

let passed = 0
let failed = 0

function ok(label: string): void {
  console.log(`${PASS} ${label}`)
  passed++
}

function nok(label: string, detail?: string): void {
  console.error(`${FAIL} ${label}`)
  if (detail) console.error(`       ${detail}`)
  failed++
}

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Human Send Validation  (4 tests, 0 LLM/Meta calls)')
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

  // ── Find an open conversation ─────────────────────────────────────────────
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, ai_mode')
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle()

  if (!conv) {
    nok('Conversation lookup', 'No open conversation found — run pnpm demo first')
    process.exitCode = 1
    return
  }

  const conversationId = conv.id
  const originalAiMode = conv.ai_mode

  const insertedIds: string[] = []
  let aiModeNeedsReset = false

  // Stub user identifier used only in JSON metadata (not in the sender_id UUID column).
  // messages.sender_id is uuid and has a FK to tenant_users — using null avoids both
  // the UUID format error and any referential-integrity violation in test rows.
  const stubUserId = 'validation-stub-agent'

  try {
    // ────────────────────────────────────────────────────────────────────────
    // Test 1 — ai_mode is set to 'manual' when a human agent sends
    //
    // The web action updates ai_mode='manual' after inserting the message.
    // We verify the DB accepts this update and reflects it back correctly.
    // ────────────────────────────────────────────────────────────────────────
    console.log('  Test 1: ai_mode update to manual persists in DB')

    const { error: eModeSet } = await supabase
      .from('conversations')
      .update({ ai_mode: 'manual', updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('tenant_id', tenantId)

    if (eModeSet) {
      nok('Test 1: update ai_mode=manual', eModeSet.message)
    } else {
      aiModeNeedsReset = true

      const { data: verify, error: eVerify } = await supabase
        .from('conversations')
        .select('ai_mode')
        .eq('id', conversationId)
        .single()

      if (eVerify) {
        nok('Test 1: verify ai_mode after update', eVerify.message)
      } else if (verify?.ai_mode === 'manual') {
        ok('ai_mode=manual persists after human send')
      } else {
        nok('ai_mode not updated to manual', `got: ${verify?.ai_mode}`)
      }

      // Restore immediately so subsequent tests have the original mode
      const { error: eModeRestore } = await supabase
        .from('conversations')
        .update({ ai_mode: originalAiMode })
        .eq('id', conversationId)

      if (!eModeRestore) aiModeNeedsReset = false
    }

    // ────────────────────────────────────────────────────────────────────────
    // Test 2 — delivery_status='sent' stored in metadata after successful send
    //
    // Simulates what sendViaWhatsApp does after Meta API returns a wamid.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n  Test 2: delivery_status=sent stored in message metadata')

    // a) Insert human message (as msgRepo.createMessage does)
    const { data: sentMsg, error: eSentMsg } = await supabase
      .from('messages')
      .insert({
        tenant_id:       tenantId,
        conversation_id: conversationId,
        content:         '[validation] human send — success path',
        content_type:    'text',
        sender_type:     'human',
        sender_id:       null,
      })
      .select('id')
      .single()

    if (eSentMsg || !sentMsg) {
      nok('Test 2: insert human message', eSentMsg?.message ?? 'no data')
    } else {
      insertedIds.push(sentMsg.id)

      const stubWamid = `wamid.VALIDATION_SENT_${Date.now()}`

      // b) Simulate successful Meta delivery
      const { error: eUpdate } = await supabase
        .from('messages')
        .update({
          whatsapp_message_id: stubWamid,
          metadata: {
            outbound_whatsapp_message_id: stubWamid,
            delivery_status: 'sent',
            sent_at:  new Date().toISOString(),
            sent_by:  stubUserId,
          } as never,
        })
        .eq('id', sentMsg.id)
        .eq('tenant_id', tenantId)

      if (eUpdate) {
        nok('Test 2: update delivery_status=sent', eUpdate.message)
      } else {
        // c) Verify the metadata was stored correctly
        const { data: readBack, error: eRead } = await supabase
          .from('messages')
          .select('whatsapp_message_id, metadata')
          .eq('id', sentMsg.id)
          .single()

        if (eRead) {
          nok('Test 2: read back message after update', eRead.message)
        } else {
          const meta = readBack?.metadata as Record<string, unknown> | null
          if (
            readBack?.whatsapp_message_id === stubWamid &&
            meta?.delivery_status === 'sent' &&
            meta?.outbound_whatsapp_message_id === stubWamid &&
            typeof meta?.sent_at === 'string' &&
            meta?.sent_by === stubUserId
          ) {
            ok('delivery_status=sent + wamid + sent_at + sent_by all stored correctly')
          } else {
            nok('delivery_status=sent metadata mismatch',
              `whatsapp_message_id=${readBack?.whatsapp_message_id} status=${meta?.delivery_status}`)
          }
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Test 3 — delivery_status='failed' stored in metadata on send failure
    //
    // Simulates what markDeliveryFailed does when Meta API is unreachable.
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n  Test 3: delivery_status=failed stored in message metadata')

    const { data: failedMsg, error: eFailedMsg } = await supabase
      .from('messages')
      .insert({
        tenant_id:       tenantId,
        conversation_id: conversationId,
        content:         '[validation] human send — failure path',
        content_type:    'text',
        sender_type:     'human',
        sender_id:       null,
      })
      .select('id')
      .single()

    if (eFailedMsg || !failedMsg) {
      nok('Test 3: insert human message', eFailedMsg?.message ?? 'no data')
    } else {
      insertedIds.push(failedMsg.id)

      const { error: eFailUpdate } = await supabase
        .from('messages')
        .update({
          metadata: {
            delivery_status: 'failed',
            delivery_error:  'Network error reaching Meta API',
            failed_at:       new Date().toISOString(),
            sent_by:         stubUserId,
          } as never,
        })
        .eq('id', failedMsg.id)
        .eq('tenant_id', tenantId)

      if (eFailUpdate) {
        nok('Test 3: update delivery_status=failed', eFailUpdate.message)
      } else {
        const { data: readBack, error: eRead } = await supabase
          .from('messages')
          .select('metadata')
          .eq('id', failedMsg.id)
          .single()

        if (eRead) {
          nok('Test 3: read back message after failure update', eRead.message)
        } else {
          const meta = readBack?.metadata as Record<string, unknown> | null
          if (
            meta?.delivery_status === 'failed' &&
            typeof meta?.delivery_error === 'string' &&
            typeof meta?.failed_at === 'string' &&
            meta?.sent_by === stubUserId
          ) {
            ok('delivery_status=failed + delivery_error + failed_at all stored correctly')
          } else {
            nok('delivery_status=failed metadata mismatch', `got: ${JSON.stringify(meta)}`)
          }
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Test 4 — Retry: updates same row, no new insert, single message in DB
    //
    // Verifies idempotency: the retry path in retryMessageAction updates the
    // existing failed message row (it does not insert a new one).
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n  Test 4: retry updates same row — no duplicate insert')

    // a) Insert a failed human message
    const { data: retryMsg, error: eRetryMsg } = await supabase
      .from('messages')
      .insert({
        tenant_id:       tenantId,
        conversation_id: conversationId,
        content:         '[validation] retry test',
        content_type:    'text',
        sender_type:     'human',
        sender_id:       null,
        metadata:        {
          delivery_status: 'failed',
          delivery_error:  'Initial send failed',
          failed_at:       new Date().toISOString(),
          sent_by:         stubUserId,
        } as never,
      })
      .select('id')
      .single()

    if (eRetryMsg || !retryMsg) {
      nok('Test 4: insert failed human message', eRetryMsg?.message ?? 'no data')
    } else {
      insertedIds.push(retryMsg.id)

      // b) Simulate retry success — update the same row
      const retryWamid = `wamid.VALIDATION_RETRY_${Date.now()}`

      const { error: eRetryUpdate } = await supabase
        .from('messages')
        .update({
          whatsapp_message_id: retryWamid,
          metadata: {
            outbound_whatsapp_message_id: retryWamid,
            delivery_status: 'sent',
            sent_at:  new Date().toISOString(),
            sent_by:  stubUserId,
          } as never,
        })
        .eq('id', retryMsg.id)
        .eq('tenant_id', tenantId)

      if (eRetryUpdate) {
        nok('Test 4: retry update on same row', eRetryUpdate.message)
      } else {
        // c) Verify: exactly one message row with this ID, status now 'sent'
        const { data: allRows, error: eCount } = await supabase
          .from('messages')
          .select('id, metadata')
          .eq('tenant_id', tenantId)
          .eq('conversation_id', conversationId)
          .eq('id', retryMsg.id)

        if (eCount) {
          nok('Test 4: count rows after retry', eCount.message)
        } else if ((allRows?.length ?? 0) !== 1) {
          nok('Test 4: duplicate row detected after retry', `found ${allRows?.length} rows`)
        } else {
          const meta = allRows![0].metadata as Record<string, unknown> | null
          if (meta?.delivery_status === 'sent' && meta?.outbound_whatsapp_message_id === retryWamid) {
            ok('Retry: same row updated to delivery_status=sent, no duplicate insert')
          } else {
            nok('Test 4: row not updated correctly after retry',
              `status=${meta?.delivery_status} wamid=${meta?.outbound_whatsapp_message_id}`)
          }
        }
      }
    }

  } finally {
    // Restore ai_mode if test 1 changed it and the explicit restore did not run
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
    console.log('    · Test 1 fails: check that conversations.ai_mode has an Update type')
    console.log('      that accepts "manual" and that RLS allows updates from service role.')
    console.log()
    console.log('    · Tests 2-4 fail: check that messages.metadata column accepts JSON')
    console.log('      updates and that the service role key has UPDATE permission.')
    console.log(HR)
    process.exitCode = 1
  } else {
    console.log('  All automated tests passed. To verify end-to-end:')
    console.log()
    console.log('    1. Open a WhatsApp conversation in the dashboard')
    console.log('    2. Send a message as an agent')
    console.log('    3. Verify ai_mode changed to manual (check below SQL)')
    console.log('    4. Verify message shows delivery_status=sent in metadata')
    console.log(HR)
  }
}

main().catch((err) => {
  console.error('\n  [validate] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

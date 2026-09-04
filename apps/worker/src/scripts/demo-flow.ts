/**
 * Demo script: simulates a full WhatsApp → Context Builder → OpenRouter →
 * search_properties → Memory Writer flow without the Meta webhook.
 *
 * Usage:  pnpm demo
 * Env:    DEMO_TENANT_ID   (required — no fallback to "first active tenant".
 *                           Run `pnpm seed:demo` first to create/print one.)
 *         DEMO_MESSAGE     (optional — defaults to a property-search question)
 *         DEMO_PHONE       (optional — simulated sender phone, default 5491100000000)
 */

import path from 'path'
import { config } from 'dotenv'

// __dirname = apps/worker/src/scripts  →  ../../../../ = monorepo root
config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createClient } from '../lib/supabase'
import { processMessage } from '../processor'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import type { Database } from '@orderflow/types'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

const HR = '─'.repeat(64)

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Demo Flow   (M3: search_properties + tool use)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const supabase = createClient()

  // ── 1. Resolve tenant ────────────────────────────────────────────────────
  // DEMO_TENANT_ID is mandatory — no "first active tenant" fallback. This
  // script writes real rows via the full pipeline; picking an arbitrary
  // tenant is not acceptable. Run `pnpm seed:demo` first.
  const tenantId = process.env.DEMO_TENANT_ID ?? ''

  if (!tenantId) {
    console.error(
      '\n  [demo] DEMO_TENANT_ID is required — no fallback to "first active tenant".\n' +
      '  Run `pnpm --filter @orderflow/worker seed:demo` first, then export the printed id:\n' +
      '    export DEMO_TENANT_ID=<id>',
    )
    process.exitCode = 1
    return
  }

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, status')
    .eq('id', tenantId)
    .maybeSingle()

  if (!tenant) {
    console.error(`\n  [demo] DEMO_TENANT_ID=${tenantId} does not exist in this Supabase project.`)
    process.exitCode = 1
    return
  }

  const tenantLabel = `${tenant.name} — ${tenant.status} (${tenant.id})`
  console.log(`\n  Tenant : ${tenantLabel}`)

  // ── 2. Build fake Meta Cloud API payload ─────────────────────────────────
  const customerPhone = process.env.DEMO_PHONE ?? '5491100000000'
  const customerText  = process.env.DEMO_MESSAGE ??
    'Hola! Busco departamentos en Buenos Aires para 2 personas, ' +
    'presupuesto máximo $100 la noche. ¿Qué tienen disponible?'

  // Unique fake wamid so the idempotency check in builder never collides
  const wamid = `wamid.DEMO${Date.now()}`

  const fakePayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'DEMO_WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '1234567890', phone_number_id: 'DEMO_PHONE_ID' },
          contacts: [{ profile: { name: 'Demo Customer' }, wa_id: customerPhone }],
          messages: [{
            from:      customerPhone,
            id:        wamid,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            type:      'text',
            text:      { body: customerText },
          }],
        },
      }],
    }],
  }

  console.log(`\n  Customer (${customerPhone}):`)
  console.log(`  "${customerText}"`)
  console.log()

  // ── 3. Construct in-memory QueueRow (no DB write needed) ─────────────────
  //    whatsapp_account_id = null  →  sender.ts logs a warning and skips send,
  //    which is the expected behaviour for a local demo without a real WA account.
  const now = new Date().toISOString()

  const queueRow: QueueRow = {
    id:                    `demo-${Date.now()}`,
    tenant_id:             tenantId,
    whatsapp_account_id:   null,
    raw_payload:           fakePayload as unknown as QueueRow['raw_payload'],
    status:                'processing',
    attempts:              0,
    last_error:            null,
    processed_at:          null,
    processing_started_at: now,
    scheduled_at:          now,
    created_at:            now,
    updated_at:            now,
  }

  // ── 4. Run the full pipeline ──────────────────────────────────────────────
  console.log(HR)
  const runStartedAt = new Date().toISOString()
  const t0           = Date.now()

  await processMessage(queueRow)

  const elapsed = Date.now() - t0
  console.log(HR)

  // ── 5. Fetch and display the stored conversation ──────────────────────────
  const { data: anchor } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('whatsapp_message_id', wamid)
    .maybeSingle()

  if (!anchor) {
    console.error('\n  [demo] Customer message not found in DB — check for errors above.')
    process.exitCode = 1
    return
  }

  const { data: thread } = await supabase
    .from('messages')
    .select('sender_type, content')
    .eq('conversation_id', anchor.conversation_id)
    .order('created_at', { ascending: true })

  if (thread && thread.length > 0) {
    console.log('\n  Stored conversation:')
    console.log()
    for (const m of thread) {
      const label   = `[${m.sender_type}]`.padEnd(12)
      const body    = m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content
      const wrapped = body.replace(/\n/g, '\n    ')
      console.log(`    ${label} ${wrapped}`)
      console.log()
    }
  }

  // ── 6. Usage log ─────────────────────────────────────────────────────────
  // Filter by created_at >= runStartedAt so we never display usage from a
  // previous run (e.g. when generateAIReply returned null due to manual mode).
  const { data: usageLog } = await supabase
    .from('ai_usage_log')
    .select('model, input_tokens, output_tokens')
    .eq('conversation_id', anchor.conversation_id)
    .gte('created_at', runStartedAt)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (usageLog) {
    const total = usageLog.input_tokens + usageLog.output_tokens
    console.log(
      `  Usage  : ${usageLog.model}` +
      `  in=${usageLog.input_tokens}  out=${usageLog.output_tokens}  total=${total}`,
    )
  } else {
    console.log('  Usage  : no AI call in this run')
  }

  console.log(`  Elapsed: ${elapsed}ms`)
  console.log(HR)
}

main().catch((err) => {
  console.error('\n  [demo] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

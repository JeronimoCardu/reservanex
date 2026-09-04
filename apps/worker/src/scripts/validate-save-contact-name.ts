/**
 * Fase 3.5: repeatable characterization of the single FAIL found in Fase 3
 * (save_contact_name not called for a bare-name reply). Runs N independent,
 * clean conversations against the demo tenant. Each conversation:
 *
 *   Turn 1 — a reservation-intent message (property + concrete dates + guests).
 *            This pattern reliably made the agent ask for the customer's name
 *            in Fase 3 (scenario E1) — REGLA DE NOMBRE only asks once real
 *            interest is shown, so this turn establishes that precondition
 *            instead of assuming it.
 *   Turn 2 — the customer replies with a BARE name ("Juan Pérez", no "mi
 *            nombre es" prefix). That prefix matches builder.ts's
 *            deterministic detectContactName() regex and would test the
 *            WRONG code path — this isolates the save_contact_name TOOL path.
 *
 * Never touches Meta/WhatsApp (whatsapp_account_id stays null). Never
 * connects the LLM to real customer data — demo tenant only.
 *
 * Usage:  pnpm --filter @orderflow/worker validate:save-contact-name
 * Env:    .env.local (DeepSeek + demo Supabase project)
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createClient } from '../lib/supabase'
import { processMessage } from '../processor'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import type { Database } from '@orderflow/types'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

const HR  = '─'.repeat(78)
const RUNS = 10
const DEMO_TENANT_SLUG = 'demo-autoresponder'

// Distinguishes this script's phones from validate-agent-scenarios.ts's, AND
// varies per process so re-running this script never reuses a contact from a
// previous invocation (which would carry over a saved name / open conversation
// and silently turn a "clean run" into a continuation of an old one).
const PROCESS_SALT = Date.now() % 100_000

function runPhone(seed: number): string {
  return '549' + String(2_000_000_000 + PROCESS_SALT * 10 + seed).padStart(10, '0')
}

interface RunOutcome {
  run:            number
  askedForName:   boolean
  toolCalled:     boolean
  toolArgs:       Record<string, unknown> | null
  toolResult:     string | null
  finalText:      string | null
  contactName:    string | null
  llmCalls:       number
  inputTokens:    number
  outputTokens:   number
  verdict:        'PASS' | 'FAIL'
  failReason?:    string
}

async function runOnce(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  runNumber: number,
): Promise<RunOutcome> {
  const phone = runPhone(runNumber)
  const now   = new Date()
  // Widely spaced per run (30 days apart) — some runs may complete the
  // REGLA 10 flow and actually call create_pending_reservation right after
  // the name is saved (following the prompt's literal wording), so distinct
  // non-overlapping ranges keep runs from blocking each other's availability.
  const d1    = new Date(now.getTime() + (60 + runNumber * 30) * 86400000)
  const d2    = new Date(now.getTime() + (62 + runNumber * 30) * 86400000)
  const fmt   = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`

  async function sendTurn(label: string, text: string) {
    const wamid = `wamid.SCN_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const nowIso = new Date().toISOString()
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'DEMO_WABA_ID', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '1234567890', phone_number_id: 'DEMO_PHONE_ID' },
        contacts: [{ profile: { name: 'Demo Customer' }, wa_id: phone }],
        messages: [{ from: phone, id: wamid, timestamp: Math.floor(Date.now() / 1000).toString(), type: 'text', text: { body: text } }],
      } }] }],
    }
    const queueRow: QueueRow = {
      id: `save-name-${runNumber}-${label}-${Date.now()}`, tenant_id: tenantId, whatsapp_account_id: null,
      raw_payload: payload as unknown as QueueRow['raw_payload'], status: 'processing', attempts: 0,
      last_error: null, processed_at: null, processing_started_at: nowIso, scheduled_at: nowIso,
      created_at: nowIso, updated_at: nowIso,
    }
    await processMessage(queueRow)
    const { data: anchor } = await supabase.from('messages').select('conversation_id').eq('whatsapp_message_id', wamid).maybeSingle()
    return anchor!.conversation_id as string
  }

  console.log(`\n${HR}`)
  console.log(`  RUN ${runNumber}/${RUNS} — phone ${phone}`)
  console.log(HR)

  // Turn 1 — establish "bot just asked for the name"
  const turn1Text = `Hola, quiero reservar el depto de Palermo del ${fmt(d1)} al ${fmt(d2)} para 2 personas`
  console.log(`  [run ${runNumber}] T1 cliente: "${turn1Text}"`)
  const conversationId = await sendTurn('T1', turn1Text)

  const { data: t1Ai } = await supabase
    .from('messages').select('content').eq('conversation_id', conversationId).eq('sender_type', 'ai')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()

  const t1Text = t1Ai?.content ?? ''
  const askedForName = /nombre y apellido|tu nombre|te llam[aá]s/i.test(t1Text)
  console.log(`  [run ${runNumber}] T1 Sofía: "${t1Text.slice(0, 200)}${t1Text.length > 200 ? '…' : ''}"`)
  console.log(`  [run ${runNumber}] askedForName=${askedForName}`)

  // Turn 2 — the isolated test: bare name reply
  console.log(`  [run ${runNumber}] T2 cliente: "Juan Pérez"`)
  await sendTurn('T2', 'Juan Pérez')

  const { data: t2Ai } = await supabase
    .from('messages').select('content').eq('conversation_id', conversationId).eq('sender_type', 'ai')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()

  const { data: usageRow } = await supabase
    .from('ai_usage_log').select('input_tokens, output_tokens')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(1).maybeSingle()

  const { data: contact } = await supabase.from('contacts').select('name').eq('tenant_id', tenantId).eq('phone', phone).maybeSingle()

  // Tool call detection: query the DB, not console-scraping — the responder
  // does not persist "which tools ran" anywhere except in messages the tool
  // itself writes as side effects, so we rely on the definitive signal: did
  // contacts.name end up populated? Combined with the console log (captured
  // by whoever reads this script's stdout) for args/result detail.
  const contactName = contact?.name ?? null
  const toolCalled  = contactName !== null

  let verdict: 'PASS' | 'FAIL' = 'FAIL'
  let failReason: string | undefined

  if (toolCalled && contactName === 'Juan Pérez') {
    verdict = 'PASS'
  } else if (toolCalled) {
    failReason = `contacts.name saved but unexpected value: "${contactName}"`
  } else {
    failReason = 'save_contact_name was not called (or failed) — contacts.name is still null'
  }

  console.log(`  [run ${runNumber}] T2 Sofía: "${(t2Ai?.content ?? '').slice(0, 200)}"`)
  console.log(`  [run ${runNumber}] contacts.name = ${JSON.stringify(contactName)}`)
  console.log(`  [run ${runNumber}] VERDICT: ${verdict}${failReason ? ' — ' + failReason : ''}`)

  return {
    run: runNumber,
    askedForName,
    toolCalled,
    toolArgs:     null, // see stdout above (responder.ts logs args/result per tool call)
    toolResult:   null,
    finalText:    t2Ai?.content ?? null,
    contactName,
    llmCalls:     0, // not tracked separately here; see stdout [responder] logs
    inputTokens:  usageRow?.input_tokens ?? 0,
    outputTokens: usageRow?.output_tokens ?? 0,
    verdict,
    failReason,
  }
}

async function main(): Promise<void> {
  console.log(HR)
  console.log(`  ReservaNex — save_contact_name characterization (${RUNS} clean runs)`)
  console.log(HR)

  assertSafeSupabaseTarget()

  const supabase = createClient()
  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('slug', DEMO_TENANT_SLUG).maybeSingle()

  if (!tenant) {
    console.error(`\n  [validate-save-contact-name] Tenant with slug "${DEMO_TENANT_SLUG}" not found. Run \`pnpm seed:demo\` first.`)
    process.exitCode = 1
    return
  }

  console.log(`  tenant: ${tenant.id} (${tenant.name})`)

  const outcomes: RunOutcome[] = []
  for (let i = 1; i <= RUNS; i++) {
    outcomes.push(await runOnce(supabase, tenant.id, i))
  }

  console.log(`\n${HR}`)
  console.log('  SUMMARY')
  console.log(HR)
  for (const o of outcomes) {
    console.log(
      `  run ${String(o.run).padStart(2)}: ${o.verdict}` +
      `  askedForName=${o.askedForName}` +
      `  contacts.name=${JSON.stringify(o.contactName)}` +
      `  tokens(T2, acumulado post-fix)=${o.inputTokens}/${o.outputTokens}` +
      (o.failReason ? `  (${o.failReason})` : ''),
    )
  }

  const passed = outcomes.filter(o => o.verdict === 'PASS').length
  console.log(`\n  Result: ${passed}/${RUNS} PASS`)
  console.log(HR)

  if (passed < RUNS) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n  [validate-save-contact-name] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

/**
 * Phase 3 validation harness: runs the REAL agent (builder → responder →
 * DeepSeek → tools → memory writer) through a fixed set of controlled
 * conversational scenarios against the dedicated demo tenant. Never touches
 * Meta or WhatsApp (whatsapp_account_id is left null on every queue row, same
 * as demo-flow.ts, so sender.ts skips the send and only logs a warning).
 *
 * Each scenario uses a distinct fake phone number so conversations never
 * collide with each other or with real data. All writes land on the demo
 * tenant only — this is a one-shot diagnostic script (transcript is meant to
 * be read from stdout), not a repeatable assertion-based test. The offline,
 * assertion-based regression suite lives under Vitest instead (unit tests in
 * packages/validators and apps/worker, run via `pnpm test` from the repo root).
 *
 * Usage:  pnpm --filter @orderflow/worker validate:agent-scenarios
 * Env:    DEMO_TENANT_ID       (required — run `pnpm seed:demo` first)
 *         NEXT_PUBLIC_SITE_URL (optional — only affects scenario I's links;
 *                               if unset, defaults to http://localhost:3000
 *                               for THIS run only — never falls back to a
 *                               production domain, and nothing is written to
 *                               .env.local)
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
const SEP = '·'.repeat(78)

function demoPhone(seed: number): string {
  // 549 + exactly 10 digits, matches normalizePhoneForWhatsApp's canonical AR format.
  return '549' + String(1_000_000_000 + seed).padStart(10, '0')
}

interface TurnResult {
  conversationId: string
  aiMode:         string
  needsAttention: boolean
  propertyId:     string | null
  lastAiText:     string | null
  usage:          { model: string; input: number; output: number } | null
  elapsedMs:      number
}

async function sendTurn(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  scenario: string,
  phone:    string,
  text:     string,
): Promise<TurnResult> {
  const wamid = `wamid.SCN_${scenario}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const now   = new Date().toISOString()

  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'DEMO_WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '1234567890', phone_number_id: 'DEMO_PHONE_ID' },
          contacts: [{ profile: { name: 'Demo Customer' }, wa_id: phone }],
          messages: [{
            from: phone, id: wamid,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            type: 'text', text: { body: text },
          }],
        },
      }],
    }],
  }

  const queueRow: QueueRow = {
    id:                    `scn-${scenario}-${Date.now()}`,
    tenant_id:             tenantId,
    whatsapp_account_id:   null,
    raw_payload:           payload as unknown as QueueRow['raw_payload'],
    status:                'processing',
    attempts:              0,
    last_error:            null,
    processed_at:          null,
    processing_started_at: now,
    scheduled_at:          now,
    created_at:            now,
    updated_at:            now,
  }

  console.log(`\n${SEP}`)
  console.log(`  [${scenario}] Cliente (${phone}): "${text}"`)
  console.log(SEP)

  const t0 = Date.now()
  await processMessage(queueRow)
  const elapsedMs = Date.now() - t0

  const { data: anchor } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('whatsapp_message_id', wamid)
    .maybeSingle()

  if (!anchor) throw new Error(`[${scenario}] customer message not found after processMessage`)

  const conversationId = anchor.conversation_id

  const { data: conv } = await supabase
    .from('conversations')
    .select('ai_mode, needs_human_attention, property_id')
    .eq('id', conversationId)
    .single()

  const { data: lastAi } = await supabase
    .from('messages')
    .select('content, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'ai')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: usageRow } = await supabase
    .from('ai_usage_log')
    .select('model, input_tokens, output_tokens')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const result: TurnResult = {
    conversationId,
    aiMode:         conv?.ai_mode ?? 'unknown',
    needsAttention: conv?.needs_human_attention ?? false,
    propertyId:     conv?.property_id ?? null,
    lastAiText:     lastAi?.content ?? null,
    usage:          usageRow ? { model: usageRow.model, input: usageRow.input_tokens, output: usageRow.output_tokens } : null,
    elapsedMs,
  }

  console.log(`  [${scenario}] Sofía: "${result.lastAiText ?? '(sin nueva respuesta de IA — ver ai_mode)'}"`)
  console.log(`  [${scenario}] ai_mode=${result.aiMode} needs_human_attention=${result.needsAttention} property_id=${result.propertyId ?? '-'}`)
  if (result.usage) {
    console.log(`  [${scenario}] usage model=${result.usage.model} in=${result.usage.input} out=${result.usage.output}`)
  }
  console.log(`  [${scenario}] elapsed=${elapsedMs}ms`)

  return result
}

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Agent Scenario Validation  (Fase 3 — DeepSeek real, tenant demo)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const tenantId = process.env.DEMO_TENANT_ID ?? ''
  if (!tenantId) {
    console.error(
      '\n  [validate-agent-scenarios] DEMO_TENANT_ID is required — no fallback.\n' +
      '  Run `pnpm --filter @orderflow/worker seed:demo` first, then export the printed id.',
    )
    process.exitCode = 1
    return
  }

  const supabase = createClient()

  const { data: tenant } = await supabase
    .from('tenants').select('id, name').eq('id', tenantId).maybeSingle()
  if (!tenant) {
    console.error(`\n  [validate-agent-scenarios] DEMO_TENANT_ID=${tenantId} does not exist.`)
    process.exitCode = 1
    return
  }
  console.log(`  tenant_id : ${tenantId} (${tenant.name})`)

  const now = new Date()
  const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`

  // ── A — Simple conversation ────────────────────────────────────────────────
  await sendTurn(supabase, tenantId, 'A', demoPhone(1), 'Hola')

  // ── B — Property search ────────────────────────────────────────────────────
  await sendTurn(supabase, tenantId, 'B', demoPhone(2), 'Hola, busco un depto en Palermo para 2 personas')

  // ── C — Availability (same phone as B — property context should carry over) ─
  const cStart = new Date(now.getTime() + 30 * 86400000)
  const cEnd   = new Date(now.getTime() + 33 * 86400000)
  await sendTurn(supabase, tenantId, 'C', demoPhone(2), `Del ${fmt(cStart)} al ${fmt(cEnd)} para 2 personas, ¿tienen disponibilidad?`)

  // ── D — Relative dates (fresh conversation, 3 turns) ─────────────────────────
  const phoneD = demoPhone(4)
  await sendTurn(supabase, tenantId, 'D1', phoneD, 'Hola, busco el depto de Palermo para mañana, somos 2 personas')
  await sendTurn(supabase, tenantId, 'D2', phoneD, '¿Y tienen para este fin de semana?')
  await sendTurn(supabase, tenantId, 'D3', phoneD, '¿Y el próximo lunes?')

  // ── E — Reservation flow (fresh conversation, 3 turns) ────────────────────────
  const phoneE = demoPhone(5)
  const eStart = new Date(now.getTime() + 40 * 86400000)
  const eEnd   = new Date(now.getTime() + 42 * 86400000)
  await sendTurn(supabase, tenantId, 'E1', phoneE, `Quiero reservar el depto de Palermo del ${fmt(eStart)} al ${fmt(eEnd)} para 2 personas`)
  // Matches builder.ts's deterministic detectContactName() regex ("mi nombre es X") —
  // exercises the FAST PATH, not the save_contact_name tool (see scenario H for the
  // tool path with a bare-name reply that does NOT match that regex).
  await sendTurn(supabase, tenantId, 'E2', phoneE, 'Mi nombre es Juan Pérez')
  await sendTurn(supabase, tenantId, 'E3', phoneE, 'Sí, dale, confirmalo')

  // ── F — Cancellation (same conversation as E, right after the reservation) ──
  await sendTurn(supabase, tenantId, 'F', phoneE, 'Me equivoqué de fecha, cancelá esa reserva por favor')

  // ── G1 — Deterministic escalation keyword (no LLM call expected) ────────────
  await sendTurn(supabase, tenantId, 'G1', demoPhone(7), 'Hola, quiero hablar con un humano')

  // ── G2 — Tool-based escalation (LLM judgment, no keyword match) ─────────────
  const phoneG2 = demoPhone(8)
  await sendTurn(supabase, tenantId, 'G2a', phoneG2,
    'Tengo una consulta legal compleja sobre un contrato de alquiler que no entiendo, necesito que me contacte un asesor especializado')
  // Confirms the agent does NOT keep answering autonomously after escalation.
  await sendTurn(supabase, tenantId, 'G2b', phoneG2, '¿Hola? ¿Siguen ahí?')

  // ── H — Contact name via the LLM tool path + no-overwrite guard ─────────────
  const phoneH = demoPhone(9)
  await sendTurn(supabase, tenantId, 'H1', phoneH, 'Hola, quiero info sobre el depto de Palermo')
  // Bare name, no "soy"/"me llamo" prefix — does NOT match builder.ts's regex,
  // so this exercises the save_contact_name TOOL specifically.
  await sendTurn(supabase, tenantId, 'H2', phoneH, 'Juan Pérez')
  // Mentions a third-party name — must NOT overwrite the contact's real name.
  await sendTurn(supabase, tenantId, 'H3', phoneH, 'Mi amigo Pedro Gómez también está interesado en alquilar')

  // ── I — Links (explicit non-production URL for this run only) ───────────────
  if (!process.env.NEXT_PUBLIC_SITE_URL) {
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000'
    console.log(`\n  [I] NEXT_PUBLIC_SITE_URL no estaba seteada — usando explícitamente http://localhost:3000 solo para este run.`)
  } else {
    console.log(`\n  [I] NEXT_PUBLIC_SITE_URL ya seteada: ${process.env.NEXT_PUBLIC_SITE_URL}`)
  }
  await sendTurn(supabase, tenantId, 'I', demoPhone(10), 'Mostrame el catálogo completo de propiedades')

  // ── J — Unknown information (must not hallucinate) ───────────────────────────
  await sendTurn(supabase, tenantId, 'J', demoPhone(11), '¿Tienen alguna propiedad en Machu Picchu?')

  console.log(`\n${HR}`)
  console.log('  Done. Revisar transcript arriba + estado DB por escenario.')
  console.log(HR)
}

main().catch((err) => {
  console.error('\n  [validate-agent-scenarios] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

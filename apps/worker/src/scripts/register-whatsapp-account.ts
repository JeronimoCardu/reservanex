/**
 * Dev script: registers or updates a WhatsApp Cloud API account in whatsapp_accounts.
 *
 * Idempotent — keyed on (tenant_id, business_account_id, phone_number):
 *   · exact match → updates the row in place
 *   · new number  → deactivates any other active account for this tenant, then inserts
 *
 * Usage:  pnpm register:whatsapp
 * Env:    DEMO_TENANT_ID              (required)
 *         META_PHONE_NUMBER_ID        (required — Meta Phone Number ID, not the display number)
 *         META_CLOUD_API_TOKEN        (required — permanent or temporary system user token)
 *         META_WEBHOOK_VERIFY_TOKEN   (required — the verify token you set in the Meta dashboard)
 *         META_WABA_ID                (required — WhatsApp Business Account ID)
 *         META_DISPLAY_PHONE_NUMBER   (optional — E.164 number shown in the dashboard)
 *         SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL  (required)
 *         SUPABASE_SERVICE_ROLE_KEY   (required)
 *
 * How to find META_WABA_ID:
 *   Option A — from the ngrok inspector:
 *     Open https://dashboard.ngrok.com → Inspect → pick any POST to /api/webhooks/whatsapp
 *     → look at the JSON body → entry[0].id
 *   Option B — from the worker logs:
 *     After a real message arrives you will see:
 *       [webhook] incoming payload { entryIds: ['1234567890'] ... }
 *     That array value is your WABA ID.
 *   Option C — Meta dashboard:
 *     business.facebook.com → WhatsApp Manager → the "Account ID" column.
 */

import path from 'path'
import { config } from 'dotenv'

// __dirname = apps/worker/src/scripts  →  ../../../../ = monorepo root
config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createClient } from '@supabase/supabase-js'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import type { Database } from '@orderflow/types'

const HR = '─'.repeat(64)

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Register WhatsApp Account')
  console.log(HR)

  assertSafeSupabaseTarget()

  // Read env vars lazily (after dotenv.config)
  const tenantId          = process.env.DEMO_TENANT_ID              ?? ''
  const phoneNumberId     = process.env.META_PHONE_NUMBER_ID        ?? ''
  const cloudApiToken     = process.env.META_CLOUD_API_TOKEN        ?? ''
  const verifyToken       = process.env.META_WEBHOOK_VERIFY_TOKEN   ?? ''
  const wabaId            = process.env.META_WABA_ID                ?? ''
  const displayPhoneNumber = process.env.META_DISPLAY_PHONE_NUMBER  ?? null
  const supabaseUrl       = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const serviceRoleKey    = process.env.SUPABASE_SERVICE_ROLE_KEY   ?? ''

  // META_WABA_ID is the trickiest to find — give a dedicated error with guidance
  if (!wabaId) {
    console.error(
      '\n  [register] META_WABA_ID is required.\n\n' +
      '  How to find it:\n' +
      '    · ngrok inspector → POST /api/webhooks/whatsapp → body → entry[0].id\n' +
      '    · worker logs     → "[webhook] incoming payload { entryIds: [\'...\'] }"\n' +
      '    · Meta dashboard  → business.facebook.com → WhatsApp Manager → Account ID',
    )
    process.exitCode = 1
    return
  }

  const missing: string[] = []
  if (!tenantId)       missing.push('DEMO_TENANT_ID')
  if (!phoneNumberId)  missing.push('META_PHONE_NUMBER_ID')
  if (!cloudApiToken)  missing.push('META_CLOUD_API_TOKEN')
  if (!verifyToken)    missing.push('META_WEBHOOK_VERIFY_TOKEN')
  if (!supabaseUrl)    missing.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)')
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')

  if (missing.length > 0) {
    console.error('\n  [register] Missing required env vars:\n   ', missing.join('\n    '))
    process.exitCode = 1
    return
  }

  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Exact lookup: (tenant_id, business_account_id, phone_number) — same 3-way key as the
  // unique partial index. Returns at most 1 row even without the index applied yet.
  const { data: exactMatch, error: lookupError } = await supabase
    .from('whatsapp_accounts')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('business_account_id', wabaId)
    .eq('phone_number', phoneNumberId)
    .maybeSingle()

  if (lookupError) {
    console.error('\n  [register] Lookup failed:', lookupError.message)
    process.exitCode = 1
    return
  }

  const payload = {
    display_phone_number:   displayPhoneNumber || null,
    phone_number:           phoneNumberId,
    business_account_id:    wabaId,
    access_token_encrypted: cloudApiToken,
    webhook_secret:         verifyToken,
    active:                 true,
    last_verified_at:       new Date().toISOString(),
  }

  if (exactMatch) {
    const { error } = await supabase
      .from('whatsapp_accounts')
      .update(payload)
      .eq('id', exactMatch.id)

    if (error) {
      console.error('\n  [register] Update failed:', error.message)
      process.exitCode = 1
      return
    }

    console.log(`\n  WhatsApp account updated : ${exactMatch.id}`)
  } else {
    // New (tenant, WABA, phone) combination — deactivate any other active accounts
    // for this tenant to keep the invariant: at most 1 active account per tenant.
    const { error: deactivateErr } = await supabase
      .from('whatsapp_accounts')
      .update({ active: false })
      .eq('tenant_id', tenantId)
      .eq('active', true)

    if (deactivateErr) {
      console.warn('\n  [register] Could not deactivate old accounts:', deactivateErr.message)
      // Non-fatal — proceed with insert; the unique index will protect against duplication.
    }

    const { data: created, error } = await supabase
      .from('whatsapp_accounts')
      .insert({ tenant_id: tenantId, ...payload })
      .select('id')
      .single()

    if (error || !created) {
      console.error('\n  [register] Insert failed:', error?.message ?? 'no data returned')
      process.exitCode = 1
      return
    }

    console.log(`\n  WhatsApp account created : ${created.id}`)
  }

  console.log()
  console.log(`  tenant_id            : ${tenantId}`)
  console.log(`  display_phone_number : ${displayPhoneNumber ?? '(not set)'}`)
  console.log(`  phone_number_id      : ${phoneNumberId}`)
  console.log(`  business_account_id  : ${wabaId}`)
  console.log(`  active               : true`)
  console.log()
  console.log('  Next steps:')
  console.log('    1. Start the worker:  pnpm dev  (in apps/worker)')
  console.log('    2. Send a WhatsApp message to your test number')
  console.log('    3. Check worker logs for [processor] / [responder] output')
  console.log(HR)
}

main().catch((err) => {
  console.error('\n  [register] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

/**
 * Dev script: registers or updates the AutoResponder (Android) channel
 * account for a tenant. Idempotent — keyed on
 * (tenant_id, provider='autoresponder', phone_number).
 *
 * NEVER hardcodes secrets — everything comes from env vars, set locally in
 * .env.local (gitignored), never committed. Never prints the MacroDroid
 * webhook URL or the raw device token, before or after hashing — only an
 * account id, tenant id, last 4 phone digits, provider and active flag.
 *
 * Fase 1B — AUTORESPONDER_MACRODROID_WEBHOOK_URL is now OPTIONAL. This
 * version's active AutoResponder flow (inbound webhook → synchronous
 * internal-server.ts → replies[]) never reads macrodroid_webhook_url — it
 * is only consulted by the legacy messaging_outbox/dispatcher.ts path,
 * which no longer participates in any active flow (see Fase 1B report §B).
 * An account can be fully functional for this version with it left null.
 *
 * Usage:  pnpm --filter @orderflow/worker seed:autoresponder
 * Env:    AUTORESPONDER_TENANT_ID              (required)
 *         AUTORESPONDER_PHONE_NUMBER            (required — WhatsApp Business
 *                                                number active on the Android)
 *         AUTORESPONDER_MACRODROID_WEBHOOK_URL  (optional — legacy, SECRET.
 *                                                Only needed for the retired
 *                                                messaging_outbox/dispatcher
 *                                                fallback, not for normal use)
 *         AUTORESPONDER_DEVICE_TOKEN            (required — SECRET, only its
 *                                                SHA-256 hash is ever stored)
 *         AUTORESPONDER_DEVICE_NAME             (optional — e.g. "Android Palermo #1")
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createClient } from '../lib/supabase'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import { hashDeviceToken } from '../lib/device-token'
import { normalizePhoneForWhatsApp } from '../lib/phone'

const HR = '─'.repeat(64)

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Register AutoResponder Account')
  console.log(HR)

  assertSafeSupabaseTarget()

  const tenantId    = process.env.AUTORESPONDER_TENANT_ID             ?? ''
  const rawPhone    = process.env.AUTORESPONDER_PHONE_NUMBER          ?? ''
  const webhookUrl  = process.env.AUTORESPONDER_MACRODROID_WEBHOOK_URL ?? ''
  const deviceToken = process.env.AUTORESPONDER_DEVICE_TOKEN          ?? ''
  const deviceName  = process.env.AUTORESPONDER_DEVICE_NAME || null

  const missing: string[] = []
  if (!tenantId)    missing.push('AUTORESPONDER_TENANT_ID')
  if (!rawPhone)     missing.push('AUTORESPONDER_PHONE_NUMBER')
  if (!deviceToken)  missing.push('AUTORESPONDER_DEVICE_TOKEN')
  // AUTORESPONDER_MACRODROID_WEBHOOK_URL is intentionally NOT required —
  // see the file header. A missing value just leaves the column null.

  if (missing.length > 0) {
    console.error('\n  [seed-autoresponder] Missing required env vars:\n    ', missing.join('\n    '))
    console.error('  Set them in .env.local (never commit real secrets) and re-run.')
    process.exitCode = 1
    return
  }

  if (deviceToken.length < 20) {
    console.error(
      '\n  [seed-autoresponder] AUTORESPONDER_DEVICE_TOKEN looks too short. ' +
      'Use a long random secret (32+ chars — e.g. `openssl rand -hex 32`).',
    )
    process.exitCode = 1
    return
  }

  const supabase = createClient()

  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('id', tenantId).maybeSingle()
  if (!tenant) {
    console.error(`\n  [seed-autoresponder] Tenant ${tenantId} not found in this Supabase project.`)
    process.exitCode = 1
    return
  }

  const normalized  = normalizePhoneForWhatsApp(rawPhone)
  const phoneNumber = normalized.replace(/\D/g, '') || rawPhone.replace(/\D/g, '')
  const tokenHash   = hashDeviceToken(deviceToken)

  // Informational only — does NOT auto-deactivate. Multiple active accounts
  // across providers are not forbidden at the DB level (see Fase 4 report §2);
  // deciding to switch a tenant's active channel is a deliberate action, not
  // something this seed script should do silently.
  const { data: otherActive } = await supabase
    .from('whatsapp_accounts')
    .select('id, provider')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .neq('provider', 'autoresponder')

  if (otherActive && otherActive.length > 0) {
    console.warn(
      `\n  [seed-autoresponder] WARNING: tenant already has ${otherActive.length} other active ` +
      `account(s) (provider=${otherActive.map(a => a.provider).join(', ')}). Not touching them — ` +
      'both may end up active simultaneously. Deactivate manually if that is not intended.',
    )
  }

  const { data: existing } = await supabase
    .from('whatsapp_accounts')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('provider', 'autoresponder')
    .eq('phone_number', phoneNumber)
    .maybeSingle()

  const payload = {
    provider:               'autoresponder' as const,
    phone_number:            phoneNumber,
    device_name:             deviceName,
    inbound_token_hash:      tokenHash,
    // Legacy-only (see file header) — null is fine and expected for a
    // MacroDroid-less setup; only set when explicitly provided.
    macrodroid_webhook_url:  webhookUrl || null,
    active:                  true,
  }

  let accountId: string

  if (existing) {
    const { data, error } = await supabase
      .from('whatsapp_accounts')
      .update(payload)
      .eq('id', existing.id)
      .select('id')
      .single()

    if (error || !data) {
      console.error('\n  [seed-autoresponder] Update failed:', error?.message ?? 'no data')
      process.exitCode = 1
      return
    }
    accountId = data.id
    console.log(`\n  Account updated: ${accountId}`)
  } else {
    const { data, error } = await supabase
      .from('whatsapp_accounts')
      .insert({ tenant_id: tenantId, ...payload })
      .select('id')
      .single()

    if (error || !data) {
      console.error('\n  [seed-autoresponder] Insert failed:', error?.message ?? 'no data')
      process.exitCode = 1
      return
    }
    accountId = data.id
    console.log(`\n  Account created: ${accountId}`)
  }

  const last4 = phoneNumber.slice(-4)

  console.log()
  console.log(`  account_id : ${accountId}`)
  console.log(`  tenant_id  : ${tenantId} (${tenant.name})`)
  console.log(`  provider   : autoresponder`)
  console.log(`  phone      : ...${last4}`)
  console.log(`  device     : ${deviceName ?? '(sin nombre)'}`)
  console.log(`  active     : true`)
  console.log()
  console.log('  (El token crudo y la URL de MacroDroid no se muestran — ya quedaron guardados.)')
  console.log(HR)
}

main().catch((err) => {
  console.error('\n  [seed-autoresponder] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

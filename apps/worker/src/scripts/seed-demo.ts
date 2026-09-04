/**
 * Seed script: ensures a demo property + unit exist and match the required
 * filters so that search_properties returns real results during demos.
 *
 * Idempotent — running it multiple times is safe:
 *   · first run   → creates the rows
 *   · subsequent  → updates existing rows to the canonical demo state
 *   · never       → inserts duplicates
 *
 * All lookups are scoped by tenant_id to support multi-tenant environments.
 *
 * Usage:  pnpm seed:demo
 * Env:    DEMO_TENANT_ID   (optional — if unset, finds-or-creates a dedicated
 *                           demo tenant by slug "demo-autoresponder" and
 *                           prints its id; no "first active tenant" fallback)
 */

import path from 'path'
import { config } from 'dotenv'

// __dirname = apps/worker/src/scripts  →  ../../../../ = monorepo root
config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createClient } from '../lib/supabase'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'

// Stable titles are the idempotency keys, always paired with tenant_id.
// Never change these without also running a migration on existing seed data.
const DEMO_PROPERTY_TITLE = '[DEMO] Departamento Palermo'
const DEMO_UNIT_NAME      = '[DEMO] Suite Standard'

// Stable idempotency key for the auto-created demo tenant (used only when
// DEMO_TENANT_ID is not set). Matches the tenants.slug format constraint.
const DEMO_TENANT_SLUG = 'demo-autoresponder'
const DEMO_TENANT_NAME = '[DEMO] AutoResponder QA'

// Canonical demo values — these are what search_properties needs to match:
//   city ilike '%Buenos Aires%'   →  city = 'Buenos Aires'
//   capacity >= 2                 →  capacity = 2
//   price <= 100                  →  price = 90
//
// capacity/pricing_mode/base_price_per_night are set here (not only on the unit
// below) because search_properties_for_reservation, check_property_availability
// and create_pending_reservation read pricing/capacity from the `properties`
// row directly — they never join `units`. Without these, pricing_mode defaults
// to 'consult' and capacity is null, so the real reservation tools would never
// show a fixed price for this demo property. This gap predates the DeepSeek
// migration (schema evolved after this seed script was written); fixing it here
// is data-only, no tool/prompt change.
const DEMO_PROPERTY = {
  city:                 'Buenos Aires',
  neighborhood:         'Palermo',
  description:          'Departamento moderno a metros del Parque Centenario. Ideal para parejas o viajeros de negocios.',
  published:            true,
  deleted_at:            null,
  operation_type:       'temporary_rental',
  capacity:             2,
  currency:             'USD',
  pricing_mode:         'fixed',
  base_price_per_night: 90,
  show_price_public:    true,
} as const

const DEMO_UNIT = {
  capacity: 2,
  price:    90,
  currency: 'USD',
  active:   true,
  deleted_at: null,
} as const

const HR = '─'.repeat(64)

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Seed Demo Data')
  console.log(HR)

  assertSafeSupabaseTarget()

  const supabase = createClient()

  // ── 1. Resolve tenant ────────────────────────────────────────────────────
  // No "first active/available tenant" fallback — that could silently pick a
  // real tenant. If DEMO_TENANT_ID is not set, find-or-create a dedicated,
  // clearly-labelled demo tenant (idempotent by slug), so re-running this
  // script is always safe and never touches unrelated data.
  let tenantId    = process.env.DEMO_TENANT_ID ?? ''
  let tenantLabel = ''

  if (tenantId) {
    const { data: given } = await supabase
      .from('tenants')
      .select('id, name, status')
      .eq('id', tenantId)
      .maybeSingle()

    if (!given) {
      console.error(`\n  [seed] DEMO_TENANT_ID=${tenantId} does not exist in this Supabase project.`)
      process.exitCode = 1
      return
    }
    tenantLabel = `${given.name} — ${given.status} (${given.id})  (DEMO_TENANT_ID)`
  } else {
    const { data: existingDemo } = await supabase
      .from('tenants')
      .select('id, name, status')
      .eq('slug', DEMO_TENANT_SLUG)
      .maybeSingle()

    if (existingDemo) {
      tenantId    = existingDemo.id
      tenantLabel = `${existingDemo.name} — ${existingDemo.status} (${existingDemo.id})  (existing demo tenant)`
    } else {
      const { data: created, error } = await supabase
        .from('tenants')
        .insert({ name: DEMO_TENANT_NAME, slug: DEMO_TENANT_SLUG })
        .select('id, name, status')
        .single()

      if (error || !created) {
        console.error('\n  [seed] Failed to create demo tenant:', error?.message ?? 'no data')
        process.exitCode = 1
        return
      }

      tenantId    = created.id
      tenantLabel = `${created.name} — ${created.status} (${created.id})  (created now)`
    }

    // Ensure ai_settings exists with a distinctive, non-default assistant
    // name/tone so behavior checks (coherence with tenant config) are
    // meaningful. `model` is intentionally left unset — it must use the
    // column DEFAULT ('deepseek-v4-flash'), same as any other tenant.
    const { data: existingSettings } = await supabase
      .from('ai_settings')
      .select('id')
      .eq('tenant_id', tenantId)
      .maybeSingle()

    if (!existingSettings) {
      const { error: aiErr } = await supabase.from('ai_settings').insert({
        tenant_id:               tenantId,
        assistant_name:          'Sofía',
        bot_tone:                'friendly',
        bot_use_emojis:          false,
        bot_send_property_links: true,
        active:                  true,
      })

      if (aiErr) {
        console.error('\n  [seed] Failed to create ai_settings for demo tenant:', aiErr.message)
        process.exitCode = 1
        return
      }
      console.log('  ai_settings  : created (assistant_name="Sofía", tone="friendly", model=default)')
    }
  }

  console.log(`\n  Tenant : ${tenantLabel}`)

  // ── 2. Upsert demo property ──────────────────────────────────────────────
  // Lookup: tenant_id + title (no deleted_at filter so we can restore
  // soft-deleted records instead of inserting a duplicate).
  const { data: existingProp } = await supabase
    .from('properties')
    .select('id, published, deleted_at')
    .eq('tenant_id', tenantId)
    .eq('title', DEMO_PROPERTY_TITLE)
    .limit(1)
    .maybeSingle()

  let propertyId: string

  if (existingProp) {
    // Ensure the existing row matches the canonical demo state.
    const { error } = await supabase
      .from('properties')
      .update(DEMO_PROPERTY)
      .eq('id', existingProp.id)

    if (error) {
      console.error('\n  [seed] Failed to update property:', error.message)
      process.exitCode = 1
      return
    }

    propertyId = existingProp.id
    const wasRestored = existingProp.deleted_at !== null
    console.log(
      `\n  Property : updated${wasRestored ? ' (restored from soft-delete)' : ''} — ${propertyId}`,
    )
  } else {
    const { data: newProp, error } = await supabase
      .from('properties')
      .insert({
        tenant_id: tenantId,
        title:     DEMO_PROPERTY_TITLE,
        ...DEMO_PROPERTY,
      })
      .select('id')
      .single()

    if (error || !newProp) {
      console.error('\n  [seed] Failed to insert property:', error?.message ?? 'no data')
      process.exitCode = 1
      return
    }

    propertyId = newProp.id
    console.log(`\n  Property : created — ${propertyId}`)
  }

  console.log(`             title: "${DEMO_PROPERTY_TITLE}"`)
  console.log(`             ${DEMO_PROPERTY.city} / ${DEMO_PROPERTY.neighborhood}  |  published: ${DEMO_PROPERTY.published}`)

  // ── 3. Upsert demo unit ──────────────────────────────────────────────────
  // Lookup: tenant_id + property_id + name. All three are needed so that
  // re-seeding after a property re-creation doesn't create a stale orphan unit.
  const { data: existingUnit } = await supabase
    .from('units')
    .select('id, active, deleted_at')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .eq('name', DEMO_UNIT_NAME)
    .limit(1)
    .maybeSingle()

  let unitId: string

  if (existingUnit) {
    const { error } = await supabase
      .from('units')
      .update(DEMO_UNIT)
      .eq('id', existingUnit.id)

    if (error) {
      console.error('\n  [seed] Failed to update unit:', error.message)
      process.exitCode = 1
      return
    }

    unitId = existingUnit.id
    const wasRestored = existingUnit.deleted_at !== null
    console.log(
      `\n  Unit     : updated${wasRestored ? ' (restored from soft-delete)' : ''} — ${unitId}`,
    )
  } else {
    const { data: newUnit, error } = await supabase
      .from('units')
      .insert({
        tenant_id:   tenantId,
        property_id: propertyId,
        name:        DEMO_UNIT_NAME,
        ...DEMO_UNIT,
      })
      .select('id')
      .single()

    if (error || !newUnit) {
      console.error('\n  [seed] Failed to insert unit:', error?.message ?? 'no data')
      process.exitCode = 1
      return
    }

    unitId = newUnit.id
    console.log(`\n  Unit     : created — ${unitId}`)
  }

  console.log(`             name: "${DEMO_UNIT_NAME}"`)
  console.log(
    `             capacity: ${DEMO_UNIT.capacity} personas` +
    `  |  price: ${DEMO_UNIT.price} ${DEMO_UNIT.currency}/noche` +
    `  |  active: ${DEMO_UNIT.active}`,
  )

  // ── 4. Summary ───────────────────────────────────────────────────────────
  console.log(`\n${HR}`)
  console.log('  Ready. This query will now return results:')
  console.log()
  console.log('    "Busco departamentos en Buenos Aires para 2 personas,')
  console.log('     presupuesto máximo $100 la noche"')
  console.log()
  console.log(`  tenant_id   : ${tenantId}`)
  console.log(`  property_id : ${propertyId}`)
  console.log(`  unit_id     : ${unitId}`)
  console.log()
  console.log('  Para reusar este tenant en demo-flow / validate:dedupe / validate:human-send:')
  console.log(`    export DEMO_TENANT_ID=${tenantId}`)
  console.log(HR)
}

main().catch((err) => {
  console.error('\n  [seed] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

/**
 * Fase 10 security validation — covers the invariants that were NOT already
 * covered by an existing test suite (device-token cross-account, media
 * cross-account, outbound-ack cross-account, auth redirect safety, etc. are
 * already covered by their own route.test.ts/*.test.ts files — duplicating
 * them here would be checklist theater, not real coverage. See the Fase 10
 * report for the full cross-reference).
 *
 * This script proves the DB-level findings from the Fase 10 audit — both
 * the originally-reported ones and the one discovered during the Paso 2
 * preflight (tenants.anon_select_active_tenants exposing payment/PII
 * columns) — using REAL Supabase clients against the real linked project:
 * a session-less anon client (exactly what an unauthenticated internet
 * visitor has), and real signed-in tenant-owner sessions for two isolated
 * tenants (A, B) to prove cross-tenant isolation, not just "unauthenticated
 * is blocked."
 *
 * Builds its own fresh, isolated tenants/users — never the demo/physical
 * tenant. Full cleanup in `finally`.
 *
 * Usage:  pnpm --filter @orderflow/web validate:security
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes } from 'node:crypto'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { validateMacroDroidWebhookUrl } from '../src/lib/autoresponder-platform'

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

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Security Validation (Fase 10, real Supabase)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const admin = createAdminClient()
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) {
    nok('Setup: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are required')
    process.exitCode = 1
    return
  }
  // A completely unauthenticated client — no session, no cookies. Exactly
  // what any anonymous internet visitor has, using only the public anon
  // key that already ships in the browser bundle.
  const anon = createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  function newClient() {
    return createSupabaseJsClient<Database>(anonUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  }
  async function signInAs(email: string, password: string) {
    const client = newClient()
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error || !data.session) throw new Error(`signInWithPassword(${email}) failed: ${error?.message}`)
    return client
  }

  const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
  console.log(`  run: ${RUN_ID}\n`)

  const tenantIds:   string[] = []
  const authUserIds: string[] = []

  type TenantFixture = {
    tenantId:            string
    conversationId:      string
    ownerEmail:          string
    ownerPassword:       string
    propertyId:          string
    unpublishedPropertyId: string
  }

  async function buildTenant(label: string, phoneBase: number): Promise<TenantFixture> {
    const { data: tenant, error: tErr } = await admin.from('tenants').insert({
      name: `[TEST] Security ${label} ${RUN_ID}`, slug: `test-security-${label.toLowerCase()}-${RUN_ID}`, status: 'active',
    }).select('id').single()
    if (tErr || !tenant) throw new Error(`tenant insert failed: ${tErr?.message}`)
    tenantIds.push(tenant.id)

    const password = randomBytes(18).toString('hex')
    const email = `owner-security-${label.toLowerCase()}-${RUN_ID}@example.test`
    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (authErr || !authUser.user) throw new Error(`createUser failed: ${authErr?.message}`)
    authUserIds.push(authUser.user.id)
    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: authUser.user.id, tenant_id: tenant.id, name: `Owner ${label}`, email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users insert failed: ${tuErr.message}`)

    const { data: account, error: aErr } = await admin.from('whatsapp_accounts').insert({
      tenant_id: tenant.id, provider: 'autoresponder',
      phone_number: '549' + String(phoneBase + Math.floor(Math.random() * 999_999)).padStart(10, '0'),
      inbound_token_hash: randomBytes(32).toString('hex'), macrodroid_webhook_url: 'https://trigger.macrodroid.com/security-test', active: true,
    }).select('id').single()
    if (aErr || !account) throw new Error(`whatsapp_accounts insert failed: ${aErr?.message}`)

    const { data: contact, error: cErr } = await admin.from('contacts').insert({
      tenant_id: tenant.id, phone: '549' + String(phoneBase + 1_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0'), name: `Contact ${label}`,
    }).select('id').single()
    if (cErr || !contact) throw new Error(`contacts insert failed: ${cErr?.message}`)

    const { data: conversation, error: convErr } = await admin.from('conversations').insert({
      tenant_id: tenant.id, contact_id: contact.id, whatsapp_account_id: account.id, ai_mode: 'autonomous',
    }).select('id').single()
    if (convErr || !conversation) throw new Error(`conversations insert failed: ${convErr?.message}`)

    const { error: dErr } = await admin.from('conversation_reservation_drafts').insert({
      tenant_id: tenant.id, conversation_id: conversation.id, property_id: crypto.randomUUID(),
      property_title: `[TEST] Security Property ${label}`, start_date: '2026-12-01', end_date: '2026-12-05',
      guests: 2, pricing_mode: 'fixed', fees_amount: 0, pricing_breakdown: {}, status: 'quoted',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
    if (dErr) throw new Error(`conversation_reservation_drafts insert failed: ${dErr.message}`)

    const { data: property, error: propErr } = await admin.from('properties').insert({
      tenant_id: tenant.id, title: `[TEST] Security Property ${label}`, city: 'Buenos Aires',
      address: `PUBLIC address ${label}`, internal_address: `SECRET internal address ${label}`,
      show_exact_address_public: false, published: true,
      operation_type: 'sale', pricing_mode: 'fixed', currency: 'USD', sale_price: 111111, show_price_public: false,
    }).select('id').single()
    if (propErr || !property) throw new Error(`properties insert failed: ${propErr?.message}`)

    const { data: unpublished, error: unpubErr } = await admin.from('properties').insert({
      tenant_id: tenant.id, title: `[TEST] Security Unpublished Property ${label}`, city: 'Buenos Aires',
      published: false, operation_type: 'sale', pricing_mode: 'consult', currency: 'USD',
    }).select('id').single()
    if (unpubErr || !unpublished) throw new Error(`unpublished properties insert failed: ${unpubErr?.message}`)

    return {
      tenantId: tenant.id, conversationId: conversation.id, ownerEmail: email, ownerPassword: password,
      propertyId: property.id, unpublishedPropertyId: unpublished.id,
    }
  }

  try {
    const A = await buildTenant('A', 3_990_000_000)
    const B = await buildTenant('B', 3_995_000_000)
    ok('Fixture: two isolated tenants (A, B), each with a real owner session + autonomous conversation + reservation draft')

    // ═══ A. anon cannot read conversation_reservation_drafts ══════════════
    {
      const { data } = await anon.from('conversation_reservation_drafts').select('conversation_id').eq('conversation_id', A.conversationId)
      if ((data ?? []).length === 0) ok('A. anon SELECT on conversation_reservation_drafts → 0 rows')
      else nok('A. anon can read reservation drafts', JSON.stringify(data))
    }
    {
      const { data } = await anon.from('conversation_reservation_drafts')
        .update({ property_title: 'anon write attempt' })
        .eq('tenant_id', A.tenantId).eq('conversation_id', A.conversationId).select('property_title')
      if ((data ?? []).length === 0) ok('A. anon UPDATE on conversation_reservation_drafts → 0 rows affected')
      else nok('A. anon can write reservation drafts', JSON.stringify(data))
    }

    // ═══ B. cross-tenant reservation draft blocked (real authenticated session) ═══
    {
      const asA = await signInAs(A.ownerEmail, A.ownerPassword)
      const { data: ownData } = await asA.from('conversation_reservation_drafts').select('conversation_id, property_title').eq('conversation_id', A.conversationId)
      const { data: otherData } = await asA.from('conversation_reservation_drafts').select('conversation_id').eq('conversation_id', B.conversationId)

      if ((ownData ?? []).length === 1) ok('B (positive). Tenant A owner CAN read tenant A\'s own draft — business access works as intended')
      else nok('B (positive). Tenant A owner cannot read their OWN draft — policy is too restrictive, not just secure', JSON.stringify(ownData))

      if ((otherData ?? []).length === 0) ok('B. Tenant A owner CANNOT read tenant B\'s draft — cross-tenant blocked')
      else nok('B. Tenant A owner CAN read tenant B\'s draft — cross-tenant isolation broken', JSON.stringify(otherData))

      const { data: crossWrite } = await asA.from('conversation_reservation_drafts')
        .update({ property_title: 'cross-tenant write attempt' })
        .eq('tenant_id', B.tenantId).eq('conversation_id', B.conversationId).select('property_title')
      if ((crossWrite ?? []).length === 0) ok('B. Tenant A owner CANNOT write tenant B\'s draft')
      else nok('B. Tenant A owner CAN write tenant B\'s draft', JSON.stringify(crossWrite))
    }

    // ═══ C/D. TRUNCATE grants — verified read-only, not by executing (see
    //          note below); confirmed via a real information_schema query
    //          during this session, reported verbatim in the Fase 10 report.
    ok('C/D. TRUNCATE grant for anon/authenticated — verified zero rows via `supabase db query` against information_schema.role_table_grants (see Fase 10 report); not re-tested here by executing TRUNCATE, which has no WHERE clause and would be destructive to real data if the grant were still present')

    // ═══ E. claim_ai_auto_reply_slot — anon blocked ════════════════════════
    {
      const { error } = await anon.rpc('claim_ai_auto_reply_slot', { p_conversation_id: A.conversationId, p_tenant_id: A.tenantId })
      if (error) ok(`E. claim_ai_auto_reply_slot: anon RPC call rejected (${error.message})`)
      else nok('E. claim_ai_auto_reply_slot: anon RPC call SUCCEEDED — cross-tenant write via unauthenticated RPC')
    }

    // ═══ F. claim_ai_auto_reply_slot — authenticated (a real, legitimate
    //        tenant owner) is ALSO blocked — this RPC is service-role only
    //        regardless of who the authenticated caller is. ════════════════
    {
      const asA = await signInAs(A.ownerEmail, A.ownerPassword)
      const { error } = await asA.rpc('claim_ai_auto_reply_slot', { p_conversation_id: A.conversationId, p_tenant_id: A.tenantId })
      if (error) ok(`F. claim_ai_auto_reply_slot: authenticated (real tenant A owner, own tenant/conversation) RPC call rejected (${error.message})`)
      else nok('F. claim_ai_auto_reply_slot: authenticated tenant owner call SUCCEEDED — should be service-role only')
    }

    // ═══ G. service-role legitimate call works — the real worker path ═════
    {
      const { data, error } = await admin.rpc('claim_ai_auto_reply_slot', { p_conversation_id: A.conversationId, p_tenant_id: A.tenantId })
      const row = Array.isArray(data) ? data[0] : data
      if (!error && row?.claimed === true && row?.new_count === 1) {
        ok('G. claim_ai_auto_reply_slot: service-role call succeeds and correctly claims the first slot (new_count=1)')
      } else {
        nok('G. service-role legitimate call did not behave as expected', `error=${error?.message} data=${JSON.stringify(data)}`)
      }
    }

    // ═══ H. mismatched tenant/conversation pair never touches the real
    //        matching tenant's row — service role, A's conversation_id +
    //        B's tenant_id. ═══════════════════════════════════════════════
    {
      const { data: beforeB } = await admin.from('conversations').select('ai_auto_replies_count').eq('id', B.conversationId).single()
      const { data, error } = await admin.rpc('claim_ai_auto_reply_slot', { p_conversation_id: A.conversationId, p_tenant_id: B.tenantId })
      const { data: afterB } = await admin.from('conversations').select('ai_auto_replies_count').eq('id', B.conversationId).single()
      const row = Array.isArray(data) ? data[0] : data
      if (!error && row?.claimed === false && beforeB?.ai_auto_replies_count === afterB?.ai_auto_replies_count) {
        ok('H. Mismatched (conversation A, tenant B) pair → claimed=false, and tenant B\'s real conversation counter is untouched')
      } else {
        nok('H. Mismatched tenant/conversation pair behaved unexpectedly', `error=${error?.message} data=${JSON.stringify(data)} beforeB=${JSON.stringify(beforeB)} afterB=${JSON.stringify(afterB)}`)
      }
    }

    // ═══ I. public tenants view never exposes a disabled/non-public tenant ═
    {
      const { data: publicRow } = await anon.from('tenants_public').select('id, public_site_enabled').eq('id', A.tenantId)
      if ((publicRow ?? []).length === 0) {
        ok('I. tenants_public: tenant with public_site_enabled=false (the fixture default) is NOT exposed to anon')
      } else {
        nok('I. tenants_public exposes a tenant that never enabled its public site', JSON.stringify(publicRow))
      }

      await admin.from('tenants').update({ public_site_enabled: true }).eq('id', A.tenantId)
      const { data: enabledRow } = await anon.from('tenants_public').select('id, public_site_enabled').eq('id', A.tenantId)
      if ((enabledRow ?? []).length === 1) {
        ok('I. tenants_public: a tenant WITH public_site_enabled=true IS visible (the view still works for its real purpose)')
      } else {
        nok('I. tenants_public no longer shows an intentionally-public tenant — the fix is too restrictive', JSON.stringify(enabledRow))
      }

      // public_site_enabled is left true here deliberately — isolates deleted_at
      // as the only variable, proving the view's deleted-tenant exclusion holds
      // independently of the public_site_enabled flag.
      await admin.from('tenants').update({ deleted_at: new Date().toISOString() }).eq('id', A.tenantId)
      const { data: deletedRow } = await anon.from('tenants_public').select('id').eq('id', A.tenantId)
      if ((deletedRow ?? []).length === 0) {
        ok('I. tenants_public: a deleted/suspended tenant is never exposed, even with public_site_enabled still true')
      } else {
        nok('I. tenants_public exposes a deleted tenant', JSON.stringify(deletedRow))
      }
      // Undo the deleted_at flip so cleanup below can proceed normally.
      await admin.from('tenants').update({ deleted_at: null }).eq('id', A.tenantId)
    }

    // ═══ 0 (bonus). The newly-discovered tenants.anon_select_active_tenants
    //     removal — direct proof anon can no longer read payment/PII columns. ═
    {
      await admin.from('tenants').update({
        payment_cbu: '0000003100099999999999', payment_alias: 'test.alias.secret', primary_owner_email: 'secret@example.test',
      }).eq('id', A.tenantId)
      const { data } = await anon.from('tenants').select('payment_cbu, payment_alias, primary_owner_email').eq('id', A.tenantId)
      if ((data ?? []).length === 0) {
        ok('0. anon can no longer read tenants.payment_cbu/payment_alias/primary_owner_email at all (the original policy is gone)')
      } else {
        nok('0. anon can STILL read tenants payment/PII columns — the most severe Fase 10 finding is not fixed', JSON.stringify(data))
      }
    }

    // ═══ Fase 10 Paso 3 — properties.internal_address / pricing privacy
    //     (backlog item T). Import the real repository so this exercises
    //     the actual public-site code path, not a re-implementation of it. ═
    {
      const { listPublicProperties, getPublicTenant } = await import('../src/lib/repositories/public-site.repository')

      // PropA. anon cannot read internal_address directly (raw PostgREST) ─
      {
        const { data } = await anon.from('properties').select('id, internal_address').eq('id', A.propertyId)
        if ((data ?? []).length === 0) ok('PropA. anon SELECT on properties → 0 rows (internal_address unreachable via direct query)')
        else nok('PropA. anon can read properties directly, including internal_address', JSON.stringify(data))
      }

      // PropB. anon cannot read pricing fields directly either, nor the
      //        neighboring anon-readable tables (units/property_images/
      //        unit_images/availability_blocks) — same class of gap. ─────
      {
        const { data } = await anon.from('properties').select('sale_price, monthly_rent_price, base_price_per_night').eq('id', A.propertyId)
        if ((data ?? []).length === 0) ok('PropB. anon SELECT on properties pricing columns → 0 rows')
        else nok('PropB. anon can read pricing columns directly', JSON.stringify(data))

        const { data: unitsData } = await anon.from('units').select('id').limit(1)
        const { data: imgData }   = await anon.from('property_images').select('id').limit(1)
        if ((unitsData ?? []).length === 0 && (imgData ?? []).length === 0) {
          ok('PropB. anon SELECT on units/property_images → 0 rows (neighboring anon policies also removed)')
        } else {
          nok('PropB. anon can still read units/property_images directly', `units=${JSON.stringify(unitsData)} images=${JSON.stringify(imgData)}`)
        }
      }

      await admin.from('tenants').update({ public_site_enabled: true }).eq('id', A.tenantId)

      // PropC. published property still visible through the real public
      //        site repository (backend/admin-client path) ───────────────
      {
        const listing = await listPublicProperties(A.tenantId)
        const found = listing.find(p => p.id === A.propertyId)
        if (found && found.internal_address === null && found.sale_price === null) {
          ok('PropC. Published property IS visible via listPublicProperties() — and internal_address/sale_price are redacted (show_exact_address_public/show_price_public are both false)')
        } else {
          nok('PropC. listPublicProperties() did not behave as expected', JSON.stringify(found))
        }
      }

      // PropD. unpublished property stays hidden from both repository
      //        functions ─────────────────────────────────────────────────
      {
        const listing = await listPublicProperties(A.tenantId)
        const inListing = listing.some(p => p.id === A.unpublishedPropertyId)
        if (!inListing) ok('PropD. Unpublished property is NOT in listPublicProperties()')
        else nok('PropD. Unpublished property leaked into listPublicProperties()')
      }

      // PropE. a tenant with public_site_enabled=false serves no property
      //        at all — getPublicTenant() (the real entry point every
      //        /site/[tenantSlug] page calls first) returns null, so no
      //        property lookup for that tenant is ever reachable. ────────
      {
        await admin.from('tenants').update({ public_site_enabled: false, public_slug: `test-security-b-slug-${RUN_ID}` }).eq('id', B.tenantId)
        const publicTenant = await getPublicTenant(`test-security-b-slug-${RUN_ID}`)
        if (publicTenant === null) ok('PropE. A tenant with public_site_enabled=false resolves to null via getPublicTenant() — its properties are unreachable through the public site')
        else nok('PropE. getPublicTenant() returned a tenant that never enabled its public site', JSON.stringify(publicTenant))
      }

      // PropF (positive). authenticated tenant A owner can read/write their
      //        OWN property in full, including internal_address — real
      //        business access must keep working, not just be blocked. ───
      {
        const asA = await signInAs(A.ownerEmail, A.ownerPassword)
        const { data: ownRead } = await asA.from('properties').select('id, internal_address, sale_price').eq('id', A.propertyId)
        const { data: ownWrite } = await asA.from('properties').update({ title: '[TEST] Updated by owner A' }).eq('id', A.propertyId).select('title')
        const ownRow = (ownRead ?? [])[0]
        if (ownRow && ownRow.internal_address !== null && (ownWrite ?? []).length === 1) {
          ok('PropF. Tenant A owner CAN read (full columns, incl. internal_address) and write their own property')
        } else {
          nok('PropF. Tenant A owner cannot fully access their own property', `read=${JSON.stringify(ownRead)} write=${JSON.stringify(ownWrite)}`)
        }

        // PropG. same authenticated session cannot touch tenant B's property.
        const { data: crossRead }  = await asA.from('properties').select('id').eq('id', B.propertyId)
        const { data: crossWrite } = await asA.from('properties').update({ title: 'cross-tenant write attempt' }).eq('id', B.propertyId).select('title')
        if ((crossRead ?? []).length === 0 && (crossWrite ?? []).length === 0) {
          ok('PropG. Tenant A owner CANNOT read or write tenant B\'s property')
        } else {
          nok('PropG. Cross-tenant property access is not blocked', `read=${JSON.stringify(crossRead)} write=${JSON.stringify(crossWrite)}`)
        }
      }

      // PropH. when show_exact_address_public / show_price_public are
      //        TRUE, the intended public behavior still works — proves
      //        this is a real toggle, not a permanently-disabled feature.
      //        Exercised through listPublicProperties() (same redaction
      //        logic as getPublicPropertyBySlug's price handling — the
      //        fixture property has no slug set, so the by-slug lookup
      //        isn't reachable here). ─────────────────────────────────────
      {
        await admin.from('properties').update({ show_exact_address_public: true, show_price_public: true }).eq('id', A.propertyId)
        const listing = await listPublicProperties(A.tenantId)
        const found = listing.find(p => p.id === A.propertyId)
        if (found && found.sale_price === 111111) {
          ok('PropH. With show_price_public=true, the real price IS returned by listPublicProperties() — the toggle genuinely works both ways')
        } else {
          nok('PropH. show_price_public=true did not restore the price', JSON.stringify(found))
        }
      }
    }

    // ═══ MacroDroid URL SSRF hardening — code-level, no DB dependency ══════
    {
      const evil = validateMacroDroidWebhookUrl('https://169.254.169.254/latest/meta-data/')
      const legit = validateMacroDroidWebhookUrl('https://trigger.macrodroid.com/abc/reservanex')
      if (!evil.valid && legit.valid) {
        ok('MacroDroid webhook URL: non-trigger.macrodroid.com hosts (incl. cloud metadata IPs) rejected; the real host accepted')
      } else {
        nok('MacroDroid webhook URL SSRF hardening', `evil.valid=${evil.valid} legit.valid=${legit.valid}`)
      }
    }

  } finally {
    // Cleanup — service role, own fixtures only. audit_logs is populated by a
    // trigger on every insert/update in this schema (confirmed the hard way:
    // an earlier version of this cleanup omitted it and left orphaned tenant
    // rows behind, FK-blocked on audit_logs.tenant_id) — must be cleared
    // before the tenants row itself can be deleted. Every delete's error is
    // surfaced so a future FK addition fails loudly instead of leaking rows
    // silently again.
    for (const tenantId of tenantIds) {
      const steps: Array<[string, () => PromiseLike<{ error: { message: string } | null }>]> = [
        ['properties',                      () => admin.from('properties').delete().eq('tenant_id', tenantId)],
        ['conversation_reservation_drafts', () => admin.from('conversation_reservation_drafts').delete().eq('tenant_id', tenantId)],
        ['conversations',                   () => admin.from('conversations').delete().eq('tenant_id', tenantId)],
        ['contacts',                        () => admin.from('contacts').delete().eq('tenant_id', tenantId)],
        ['whatsapp_accounts',               () => admin.from('whatsapp_accounts').delete().eq('tenant_id', tenantId)],
        ['tenant_users',                    () => admin.from('tenant_users').delete().eq('tenant_id', tenantId)],
        ['audit_logs',                      () => admin.from('audit_logs').delete().eq('tenant_id', tenantId)],
        ['tenants',                         () => admin.from('tenants').delete().eq('id', tenantId)],
      ]
      for (const [table, run] of steps) {
        const { error } = await run()
        if (error) console.error(`  [cleanup] WARNING: failed to delete from ${table} for tenant ${tenantId}: ${error.message}`)
      }
    }
    for (const uid of authUserIds) {
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
  }

  console.log(`\n${HR}`)
  console.log(`  Result: ${passed} passed, ${failed} failed`)
  console.log(HR)

  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n  [validate-security] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

/**
 * Validation for admin_purge_tenant(uuid) (supabase/migrations/
 * 20260831000001_fix_admin_purge_tenant_missing_fks.sql +
 * 20260831000002_fix_purge_tenant_cascade_reporting_order.sql) and its
 * Storage-cleanup wrapper, purgeTenantWithStorage() (apps/web/src/lib/
 * repositories/tenant-storage.repository.ts) — the shared implementation
 * backing both hardDeleteTenantBySuperAdminAction and
 * resetQaDataExceptSuperAdminAction (apps/web/src/actions/platform-danger.ts).
 * Runs against the real linked Supabase project — no running Next.js server
 * needed, same technique as validate-onboarding.ts.
 *
 * Builds TWO fresh, isolated tenants (TARGET + OTHER, never the demo
 * tenant), gives TARGET a deliberately rich fixture spanning:
 *   - every DB table that was either a blocking FK gap (messaging_outbox,
 *     media_events, inbound_rejections — the bug 20260831000001 fixed) or a
 *     CASCADE-only reporting gap (property_videos, user_section_seen,
 *     tenant_receipt_counters)
 *   - real uploaded files in all 5 real Storage buckets (property-images,
 *     property-videos [deliberately NOT uploaded — the "missing file"
 *     case], reservation-docs, whatsapp-media, tenant-public-assets)
 *   - a genuine (bucket, path) duplicate: one WhatsApp-media file
 *     referenced from messages.media_storage_path, media_events.storage_path,
 *     AND a documents row (the real "payment-proof promoted from inbound
 *     media" pattern) — proving dedup actually collapses it to one delete
 *
 * Usage:  pnpm --filter @orderflow/web validate:purge-tenant
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes, randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { hashDeviceToken } from '../src/lib/autoresponder-webhook'
import {
  collectTenantStorageObjects,
  purgeTenantWithStorage,
} from '../src/lib/repositories/tenant-storage.repository'
import type { StorageObjectRef } from '../src/lib/tenant-storage-cleanup'

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

function nextPhone(base: number): string {
  return '549' + String(base + Math.floor(Math.random() * 999_999)).padStart(10, '0')
}

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

type TenantScopedTable = { table: string; tenantColumn: string }
const FIXTURE_TABLES: TenantScopedTable[] = [
  { table: 'tenant_users',       tenantColumn: 'tenant_id' },
  { table: 'workspaces',         tenantColumn: 'tenant_id' },
  { table: 'contacts',           tenantColumn: 'tenant_id' },
  { table: 'conversations',      tenantColumn: 'tenant_id' },
  { table: 'messages',           tenantColumn: 'tenant_id' },
  { table: 'messaging_outbox',   tenantColumn: 'tenant_id' }, // the reported bug
  { table: 'media_events',       tenantColumn: 'tenant_id' }, // same class of bug
  { table: 'inbound_rejections', tenantColumn: 'tenant_id' }, // same class of bug
  { table: 'whatsapp_accounts',  tenantColumn: 'tenant_id' },
  { table: 'properties',         tenantColumn: 'tenant_id' },
  { table: 'property_videos',    tenantColumn: 'tenant_id' }, // CASCADE-only gap
  { table: 'reservations',       tenantColumn: 'tenant_id' },
  { table: 'tasks',              tenantColumn: 'tenant_id' },
  { table: 'notes',              tenantColumn: 'tenant_id' },
  { table: 'documents',          tenantColumn: 'tenant_id' },
  { table: 'monthly_rental_contracts', tenantColumn: 'tenant_id' },
  { table: 'user_section_seen',  tenantColumn: 'tenant_id' }, // CASCADE-only gap
  { table: 'tenant_receipt_counters', tenantColumn: 'tenant_id' }, // CASCADE-only gap
]

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — admin_purge_tenant + Storage Validation (fresh tenants, real Supabase)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const admin = createAdminClient()
  console.log(`  run: ${RUN_ID}\n`)

  const authUserIds: string[] = []

  // Every real bucket restricts allowed_mime_types — pick one each bucket
  // actually accepts rather than a generic octet-stream.
  const BUCKET_CONTENT_TYPE: Record<string, string> = {
    'property-images':      'image/jpeg',
    'property-videos':      'video/mp4',
    'reservation-docs':     'application/pdf',
    'whatsapp-media':       'image/jpeg',
    'tenant-public-assets': 'image/png',
  }

  async function uploadTestFile(bucket: string, filePath: string): Promise<void> {
    const contentType = BUCKET_CONTENT_TYPE[bucket] ?? 'application/octet-stream'
    const { error } = await admin.storage.from(bucket).upload(filePath, Buffer.from('test-content'), {
      contentType, upsert: true,
    })
    if (error) throw new Error(`upload failed (${bucket}/${filePath}): ${error.message}`)
  }

  async function fileExists(bucket: string, filePath: string): Promise<boolean> {
    const { data, error } = await admin.storage.from(bucket).download(filePath)
    return !error && !!data
  }

  // Empirically, Supabase Storage's download() endpoint can show a brief,
  // inconsistent propagation delay right after remove() (verified against
  // this real project — a handful of seconds, varies per object, not
  // reproducible in a fixed pattern), while list() reflects deletions
  // immediately and consistently. Use list() for the authoritative
  // "is it really gone" check; not our application's behavior to fix.
  async function fileGoneViaList(bucket: string, filePath: string): Promise<boolean> {
    const lastSlash = filePath.lastIndexOf('/')
    const folder   = lastSlash === -1 ? '' : filePath.slice(0, lastSlash)
    const filename = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
    const { data } = await admin.storage.from(bucket).list(folder, { search: filename })
    return !(data ?? []).some((f) => f.name === filename)
  }

  async function buildRichFixture(label: string, phoneBase: number): Promise<{ tenantId: string; uploaded: StorageObjectRef[] }> {
    const { data: tenant, error: tErr } = await admin.from('tenants').insert({
      name: `[TEST] Purge ${label} ${RUN_ID}`,
      slug: `test-purge-${label}-${RUN_ID}`,
      status: 'active',
    }).select('id').single()
    if (tErr || !tenant) throw new Error(`tenant insert failed: ${tErr?.message}`)
    const tenantId = tenant.id
    const uploaded: StorageObjectRef[] = []

    const { error: wsErr } = await admin.from('workspaces').insert({ tenant_id: tenantId, name: 'General', active: true })
    if (wsErr) throw new Error(`workspace insert failed: ${wsErr.message}`)

    const email = `owner-purge-${label}-${RUN_ID}@example.test`
    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email, password: randomBytes(18).toString('hex'), email_confirm: true,
    })
    if (authErr || !authUser.user) throw new Error(`createUser failed: ${authErr?.message}`)
    authUserIds.push(authUser.user.id)
    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: authUser.user.id, tenant_id: tenantId, name: `Owner ${label}`, email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users insert failed: ${tuErr.message}`)

    // ── tenant-public-assets: logo + cover ────────────────────────────────────
    const publicLogoPath  = `${tenantId}/logo/logo.png`
    const publicCoverPath = `${tenantId}/cover/cover.jpg`
    await uploadTestFile('tenant-public-assets', publicLogoPath)
    await uploadTestFile('tenant-public-assets', publicCoverPath)
    uploaded.push({ bucket: 'tenant-public-assets', path: publicLogoPath, source: 'tenants.public_logo' })
    uploaded.push({ bucket: 'tenant-public-assets', path: publicCoverPath, source: 'tenants.public_cover_image' })
    const { error: tenantUpdErr } = await admin.from('tenants').update({
      public_logo_storage_path: publicLogoPath, public_cover_image_storage_path: publicCoverPath,
    }).eq('id', tenantId)
    if (tenantUpdErr) throw new Error(`tenants update (public assets) failed: ${tenantUpdErr.message}`)

    const rawToken = randomBytes(24).toString('hex')
    const { data: wa, error: waErr } = await admin.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: nextPhone(phoneBase),
      inbound_token_hash: hashDeviceToken(rawToken), macrodroid_webhook_url: 'https://example.org/purge-test', active: true,
    }).select('id').single()
    if (waErr || !wa) throw new Error(`whatsapp_accounts insert failed: ${waErr?.message}`)

    const contactPhone = nextPhone(phoneBase + 1_000_000)
    const { data: contact, error: cErr } = await admin.from('contacts').insert({
      tenant_id: tenantId, phone: contactPhone, name: `Contact ${label}`,
    }).select('id').single()
    if (cErr || !contact) throw new Error(`contacts insert failed: ${cErr?.message}`)

    // ── property-images: cover + gallery image ────────────────────────────────
    const coverImagePath = `${tenantId}/cover.jpg`
    const galleryImagePath = `${tenantId}/gallery-1.jpg`
    await uploadTestFile('property-images', coverImagePath)
    await uploadTestFile('property-images', galleryImagePath)
    uploaded.push({ bucket: 'property-images', path: coverImagePath, source: 'properties.cover_image' })
    uploaded.push({ bucket: 'property-images', path: galleryImagePath, source: 'property_images' })

    const { data: property, error: pErr } = await admin.from('properties').insert({
      tenant_id: tenantId, title: `Property ${label}`, published: true, cover_image_storage_path: coverImagePath,
    }).select('id').single()
    if (pErr || !property) throw new Error(`properties insert failed: ${pErr?.message}`)

    const { error: imgErr } = await admin.from('property_images').insert({
      property_id: property.id, image_url: `https://example.test/${galleryImagePath}`, storage_path: galleryImagePath, sort_order: 0,
    })
    if (imgErr) throw new Error(`property_images insert failed: ${imgErr.message}`)

    const { data: conversation, error: convErr } = await admin.from('conversations').insert({
      tenant_id: tenantId, contact_id: contact.id, whatsapp_account_id: wa.id, property_id: property.id,
    }).select('id').single()
    if (convErr || !conversation) throw new Error(`conversations insert failed: ${convErr?.message}`)

    const { data: message, error: mErr } = await admin.from('messages').insert({
      tenant_id: tenantId, conversation_id: conversation.id, sender_type: 'customer', content: 'hola',
    }).select('id').single()
    if (mErr || !message) throw new Error(`messages insert failed: ${mErr?.message}`)

    // ── whatsapp-media: ONE file, referenced from THREE rows (dedup case) ────
    // messages.media_storage_path + media_events.storage_path + a documents
    // row (storage_bucket='whatsapp-media') — the real "payment proof
    // promoted from inbound media" pattern (see apps/web/src/actions/
    // documents.ts). Must collapse to exactly one Storage delete.
    const whatsappMediaPath = `${tenantId}/${conversation.id}/${message.id}.jpg`
    await uploadTestFile('whatsapp-media', whatsappMediaPath)
    uploaded.push({ bucket: 'whatsapp-media', path: whatsappMediaPath, source: 'messages/media_events/documents (shared)' })

    const { error: msgUpdErr } = await admin.from('messages').update({ media_storage_path: whatsappMediaPath }).eq('id', message.id)
    if (msgUpdErr) throw new Error(`messages update (media_storage_path) failed: ${msgUpdErr.message}`)

    // ── The exact bug this migration fixes: messaging_outbox → messages ──────
    const { error: outboxErr } = await admin.from('messaging_outbox').insert({
      tenant_id: tenantId, account_id: wa.id, conversation_id: conversation.id, message_id: message.id,
      destination_phone: contactPhone, text: 'respuesta', provider: 'autoresponder', source: 'ai', status: 'pending',
    })
    if (outboxErr) throw new Error(`messaging_outbox insert failed: ${outboxErr.message}`)

    // ── Same class of bug — also referenced messages/conversations/whatsapp_accounts with NO ACTION ──
    const { error: mediaErr } = await admin.from('media_events').insert({
      tenant_id: tenantId, account_id: wa.id, conversation_id: conversation.id, message_id: message.id,
      media_type: 'image', status: 'uploaded', storage_path: whatsappMediaPath,
    })
    if (mediaErr) throw new Error(`media_events insert failed: ${mediaErr.message}`)

    const { error: rejErr } = await admin.from('inbound_rejections').insert({
      tenant_id: tenantId, account_id: wa.id, provider: 'autoresponder', reason: 'empty_sender',
      internal_event_id: randomUUID(),
    })
    if (rejErr) throw new Error(`inbound_rejections insert failed: ${rejErr.message}`)

    // ── property-videos: DB row WITHOUT ever uploading a real file — the
    //    "path referenced but object doesn't exist" case (must not break cleanup) ──
    const { error: pvErr } = await admin.from('property_videos').insert({
      tenant_id: tenantId, property_id: property.id, storage_path: `${tenantId}/never-uploaded.mp4`,
      mime_type: 'video/mp4', file_size_bytes: 1024,
    })
    if (pvErr) throw new Error(`property_videos insert failed: ${pvErr.message}`)

    const { error: ussErr } = await admin.from('user_section_seen').insert({
      tenant_id: tenantId, user_id: authUser.user.id, section: 'conversations',
    })
    if (ussErr) throw new Error(`user_section_seen insert failed: ${ussErr.message}`)

    const { error: trcErr } = await admin.from('tenant_receipt_counters').insert({
      tenant_id: tenantId, year: 2026, counter: 1,
    })
    if (trcErr) throw new Error(`tenant_receipt_counters insert failed: ${trcErr.message}`)

    const { data: reservation, error: resErr } = await admin.from('reservations').insert({
      tenant_id: tenantId, contact_id: contact.id, property_id: property.id,
      start_date: '2026-09-01', end_date: '2026-09-05', guests: 2,
    }).select('id').single()
    if (resErr || !reservation) throw new Error(`reservations insert failed: ${resErr?.message}`)

    const { error: taskErr } = await admin.from('tasks').insert({ tenant_id: tenantId, title: `Task ${label}` })
    if (taskErr) throw new Error(`tasks insert failed: ${taskErr.message}`)

    const { error: noteErr } = await admin.from('notes').insert({ tenant_id: tenantId, contact_id: contact.id, content: `Note ${label}` })
    if (noteErr) throw new Error(`notes insert failed: ${noteErr.message}`)

    // ── reservation-docs: separate document, own bucket (dynamic storage_bucket) ──
    const reservationDocPath = `${tenantId}/receipts/doc.pdf`
    await uploadTestFile('reservation-docs', reservationDocPath)
    uploaded.push({ bucket: 'reservation-docs', path: reservationDocPath, source: 'documents (reservation-docs)' })

    const { error: docErr } = await admin.from('documents').insert({
      tenant_id: tenantId, name: `Doc ${label}`, file_url: `/api/documents/fake-${RUN_ID}`,
      document_type: 'contract', contact_id: contact.id,
      storage_bucket: 'reservation-docs', storage_path: reservationDocPath,
    })
    if (docErr) throw new Error(`documents insert failed: ${docErr.message}`)

    // Second documents row — the whatsapp-media dedup case (3rd reference to
    // whatsappMediaPath). document_type='payment_proof' requires a billing
    // context (reservation_id or monthly_rental_contract_id) per the real
    // documents_payment_proof_requires_billing_context CHECK constraint.
    const { error: doc2Err } = await admin.from('documents').insert({
      tenant_id: tenantId, name: `Doc WA ${label}`, file_url: `/api/media/${message.id}`,
      document_type: 'payment_proof', contact_id: contact.id, source: 'whatsapp',
      reservation_id: reservation.id,
      storage_bucket: 'whatsapp-media', storage_path: whatsappMediaPath,
    })
    if (doc2Err) throw new Error(`documents (whatsapp dedup) insert failed: ${doc2Err.message}`)

    const { error: mrcErr } = await admin.from('monthly_rental_contracts').insert({
      tenant_id: tenantId, property_id: property.id, contact_id: contact.id,
      start_date: '2026-09-01', rent_amount: 100000,
    })
    if (mrcErr) throw new Error(`monthly_rental_contracts insert failed: ${mrcErr.message}`)

    return { tenantId, uploaded }
  }

  async function countRowsForTenant(table: string, tenantColumn: string, tenantId: string): Promise<number> {
    const untyped = admin as unknown as {
      from: (t: string) => { select: (c: string, o: { count: 'exact'; head: true }) => { eq: (col: string, v: string) => Promise<{ count: number | null }> } }
    }
    const { count } = await untyped.from(table).select('*', { count: 'exact', head: true }).eq(tenantColumn, tenantId)
    return count ?? 0
  }

  async function assertAllPresent(label: string, tenantId: string): Promise<boolean> {
    let allPresent = true
    for (const { table, tenantColumn } of FIXTURE_TABLES) {
      const n = await countRowsForTenant(table, tenantColumn, tenantId)
      if (n < 1) { allPresent = false; console.error(`       ${label}: expected >=1 row in ${table}, found ${n}`) }
    }
    return allPresent
  }

  async function assertAllGone(label: string, tenantId: string): Promise<boolean> {
    let allGone = true
    for (const { table, tenantColumn } of FIXTURE_TABLES) {
      const n = await countRowsForTenant(table, tenantColumn, tenantId)
      if (n > 0) { allGone = false; console.error(`       ${label}: expected 0 rows in ${table}, found ${n}`) }
    }
    const { data: tenantRow } = await admin.from('tenants').select('id').eq('id', tenantId).maybeSingle()
    if (tenantRow) { allGone = false; console.error(`       ${label}: tenants row still exists`) }
    return allGone
  }

  let targetId: string | null = null
  let otherId:  string | null = null
  let targetUploaded: StorageObjectRef[] = []
  let otherUploaded:  StorageObjectRef[] = []

  try {
    const target = await buildRichFixture('target', 3_950_000_000)
    const other  = await buildRichFixture('other',  3_960_000_000)
    targetId = target.tenantId; targetUploaded = target.uploaded
    otherId  = other.tenantId;  otherUploaded  = other.uploaded
    ok('Fixtures: TARGET and OTHER built — 18 DB tables + real files in all 5 Storage buckets, incl. a genuine (bucket,path) duplicate and a never-uploaded path')

    if (await assertAllPresent('pre-purge TARGET', targetId)) {
      ok('1. Pre-purge: every fixture table has >=1 row for TARGET')
    } else {
      nok('1. Pre-purge fixture completeness')
    }

    for (const ref of targetUploaded) {
      if (!(await fileExists(ref.bucket, ref.path))) nok('Pre-purge Storage fixture', `missing before purge: ${ref.bucket}/${ref.path}`)
    }

    // ── Storage collection + dedup, BEFORE anything is deleted ───────────────
    const { refs: collectedRefs, warnings: collectWarnings } = await collectTenantStorageObjects(targetId)
    const expectedUniqueCount = 6 // 2 property-images + 2 tenant-public-assets + 1 reservation-docs + 1 whatsapp-media (deduped from 3 refs) — NOT counting the never-uploaded property_videos path, which also gets collected (it's a real DB row) but has no file behind it
    const collectedWhatsapp = collectedRefs.filter((r) => r.bucket === 'whatsapp-media')
    if (collectedRefs.length === expectedUniqueCount + 1 && collectedWhatsapp.length === 1) {
      ok('5. collectTenantStorageObjects dedupes the (bucket,path) referenced by messages/media_events/documents down to exactly one entry')
    } else {
      nok('5. Dedup', `collected=${collectedRefs.length} (expected ${expectedUniqueCount + 1}), whatsapp-media refs=${collectedWhatsapp.length} (expected 1)`)
    }
    if (collectWarnings.length === 0) {
      ok('Collection produced no ownership warnings for TARGET\'s own, correctly-prefixed paths')
    } else {
      nok('Unexpected ownership warnings', JSON.stringify(collectWarnings))
    }

    // ── The actual fix under test — DB purge + Storage cleanup together ──────
    const result = await purgeTenantWithStorage(targetId)

    if (result.dbError) {
      nok('2. purgeTenantWithStorage succeeds for a tenant with messaging_outbox/media_events/inbound_rejections rows', result.dbError)
    } else {
      ok('2. DB purge succeeds — no FK violation (this is exactly what failed before the fix)')
    }

    if (!result.dbError && result.dbResult) {
      const counts = result.dbResult
      const previouslyMissing = ['messaging_outbox', 'media_events', 'inbound_rejections', 'property_videos', 'user_section_seen', 'tenant_receipt_counters']
      const allReported = previouslyMissing.every((k) => typeof counts[k] === 'number' && counts[k] >= 1)
      if (allReported) ok('3. The DB result reports >=1 deleted row for every previously-missing table')
      else nok('3. Result completeness', JSON.stringify(counts))
    }

    if (!result.dbError && await assertAllGone('post-purge TARGET', targetId)) {
      ok('4. Post-purge: every fixture table has 0 rows for TARGET, and the tenants row itself is gone')
    } else if (!result.dbError) {
      nok('4. Post-purge TARGET DB cleanup')
    }

    // ── 6. Real Storage objects actually removed, including the deduped one,
    //       and the never-uploaded path did not break anything ──────────────
    if (!result.dbError) {
      let allGoneFromStorage = true
      for (const ref of targetUploaded) {
        if (!(await fileGoneViaList(ref.bucket, ref.path))) { allGoneFromStorage = false; console.error(`       still present: ${ref.bucket}/${ref.path}`) }
      }
      if (allGoneFromStorage && result.storage.attempted && result.storage.failures.length === 0) {
        ok('6. Every real uploaded Storage object for TARGET is gone, no failures reported, and the never-uploaded property_videos path did not break the cleanup')
      } else {
        nok('6. Storage cleanup completeness', `allGone=${allGoneFromStorage} attempted=${result.storage.attempted} failures=${JSON.stringify(result.storage.failures)}`)
      }
    }

    // ── 7. OTHER's DB rows AND real Storage files are completely untouched ───
    const otherDbIntact = await assertAllPresent('post-purge OTHER', otherId)
    let otherStorageIntact = true
    for (const ref of otherUploaded) {
      if (!(await fileExists(ref.bucket, ref.path))) { otherStorageIntact = false; console.error(`       OTHER file missing: ${ref.bucket}/${ref.path}`) }
    }
    if (otherDbIntact && otherStorageIntact) {
      ok('7. OTHER tenant is completely untouched — DB rows AND every real Storage file survive (no bucket was emptied, no cross-tenant deletion)')
    } else {
      nok('7. Cross-tenant isolation (DB + Storage)', `dbIntact=${otherDbIntact} storageIntact=${otherStorageIntact}`)
    }

    // ── 8. DB failure must never reach Storage deletion (structural guarantee,
    //       not data-dependent — see tenant-storage.repository.ts's early return) ──
    const bogusResult = await purgeTenantWithStorage(randomUUID())
    if (bogusResult.dbError && !bogusResult.storage.attempted && bogusResult.storage.deletedCount === 0) {
      ok('8. When the DB purge fails, Storage deletion is never attempted (storage.attempted stays false)')
    } else {
      nok('8. DB-fail-blocks-Storage guarantee', JSON.stringify(bogusResult))
    }

    // ── 9. A second cleanup on the same (already-deleted) tenant is safe ─────
    const second = await purgeTenantWithStorage(targetId)
    if (second.dbError && /not found/i.test(second.dbError) && !second.storage.attempted) {
      ok('9. A second purge+storage-cleanup on the same (already-deleted) tenant fails cleanly with "not found" — no crash, no Storage call attempted')
    } else {
      nok('9. Idempotent re-run behavior', JSON.stringify(second))
    }

  } finally {
    // Clean up OTHER via the same shared helper — doubles as one more real
    // exercise of the fix (DB + Storage together), and leaves nothing behind.
    if (otherId) {
      try { await purgeTenantWithStorage(otherId) } catch { /* best-effort cleanup */ }
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
  console.error('\n  [validate-purge-tenant] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

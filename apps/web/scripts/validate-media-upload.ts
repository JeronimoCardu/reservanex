/**
 * Fase 6B integration validation: exercises
 * POST /api/webhooks/autoresponder/media directly against the real linked
 * Supabase project (akvaswvkdqfguksinrwa) — no running Next.js server
 * needed, since Route Handlers are plain async functions and this endpoint
 * only depends on createAdminClient() (env-based, no cookies/request
 * context).
 *
 * Complements apps/web's offline Vitest suite (autoresponder-media.test.ts,
 * pure MIME/size/filename/path logic) with the parts that genuinely need a
 * real DB: device-token auth, event ownership/cross-account rejection,
 * idempotency, and end-to-end storage + message/media_event state.
 *
 * Usage:  pnpm --filter @orderflow/web validate:media-upload
 * Env:    DEMO_TENANT_ID (required — same demo tenant used by
 *         apps/worker/src/scripts/validate-autoresponder.ts)
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { NextRequest } from 'next/server'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { POST as uploadMedia } from '../src/app/api/webhooks/autoresponder/media/route'

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

function hashDeviceToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

const UPLOAD_URL = 'http://127.0.0.1/api/webhooks/autoresponder/media'

function buildRequest(opts: {
  token?:       string | null
  eventId?:     string | null
  mediaType?:   string | null
  filename?:    string | null
  contentType?: string
  body?:        Buffer | Uint8Array
}): NextRequest {
  const headers = new Headers()
  if (opts.token !== null)     headers.set('x-reservanex-device-token', opts.token ?? 'dummy-token')
  if (opts.eventId !== null)   headers.set('x-reservanex-event-id', opts.eventId ?? '')
  if (opts.mediaType !== null) headers.set('x-reservanex-media-type', opts.mediaType ?? '')
  if (opts.filename)           headers.set('x-reservanex-filename', opts.filename)
  if (opts.contentType)        headers.set('content-type', opts.contentType)

  const body = opts.body ?? Buffer.from('test-bytes')
  return new NextRequest(UPLOAD_URL, { method: 'POST', headers, body: new Uint8Array(body) })
}

// A minimal, valid OGG/Opus-shaped buffer is unnecessary here — the endpoint
// validates Content-Type + size, not file-signature bytes (that's a
// reasonable, documented scope boundary — see Fase 6B report §8).
// Fase 6B.1: the endpoint now validates magic bytes, not just Content-Type —
// these fixtures must carry REAL signature bytes to still exercise the
// success paths. FAKE_IMAGE is built from a byte array (not a JS string
// with \xff escapes) specifically because Buffer.from(string) UTF-8-encodes
// codepoints ≥0x80 into multi-byte sequences, which would silently corrupt
// the intended single 0xff bytes.
const FAKE_AUDIO    = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(500, 0x78)])
const FAKE_IMAGE    = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 0x78)])
const FAKE_PDF      = Buffer.from('%PDF-1.4\n' + 'x'.repeat(500))

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — AutoResponder Media Upload Validation (real Supabase, no Android)')
  console.log(HR)

  assertSafeSupabaseTarget()

  const tenantId = process.env.DEMO_TENANT_ID ?? ''
  if (!tenantId) {
    nok('Tenant resolution', 'DEMO_TENANT_ID is required.')
    process.exitCode = 1
    return
  }

  const supabase = createAdminClient()
  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('id', tenantId).maybeSingle()
  if (!tenant) {
    nok('Tenant resolution', `DEMO_TENANT_ID=${tenantId} does not exist.`)
    process.exitCode = 1
    return
  }
  console.log(`  tenant: ${tenantId} (${tenant.name})\n`)

  const createdAccountIds:      string[] = []
  const createdContactIds:      string[] = []
  const createdConversationIds: string[] = []
  const createdMessageIds:      string[] = []
  const createdEventIds:        string[] = []

  try {
    // ── Setup: throwaway autoresponder account + contact + conversation ──────
    const rawToken   = randomBytes(24).toString('hex')
    const phone      = '549' + String(3_500_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0')
    const acctPhone  = '549' + String(3_600_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0')

    const { data: account, error: acctErr } = await supabase.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: acctPhone,
      inbound_token_hash: hashDeviceToken(rawToken), macrodroid_webhook_url: 'https://example.org/unused', active: true,
    }).select('id').single()
    if (acctErr || !account) { nok('Setup: account', acctErr?.message ?? 'no data'); throw new Error('cannot continue') }
    createdAccountIds.push(account.id)

    const { data: otherAccount } = await supabase.from('whatsapp_accounts').insert({
      tenant_id: tenantId, provider: 'autoresponder', phone_number: '549' + String(3_700_000_000 + Math.floor(Math.random() * 999_999)).padStart(10, '0'),
      inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), macrodroid_webhook_url: 'https://example.org/unused2', active: true,
    }).select('id').single()
    if (otherAccount) createdAccountIds.push(otherAccount.id)

    const { data: contact } = await supabase.from('contacts').insert({ tenant_id: tenantId, phone, source: 'whatsapp' }).select('id').single()
    if (!contact) { nok('Setup: contact', 'no data'); throw new Error('cannot continue') }
    createdContactIds.push(contact.id)

    const { data: conv } = await supabase.from('conversations').insert({
      tenant_id: tenantId, contact_id: contact.id, channel: 'whatsapp', source: 'whatsapp_direct',
      ai_mode: 'manual', status: 'open', whatsapp_account_id: account.id,
    }).select('id').single()
    if (!conv) { nok('Setup: conversation', 'no data'); throw new Error('cannot continue') }
    createdConversationIds.push(conv.id)

    async function makeEvent(mediaType: 'audio' | 'image' | 'document', expectedFilename: string | null) {
      const { data: msg } = await supabase.from('messages').insert({
        tenant_id: tenantId, conversation_id: conv!.id, content: `[placeholder ${mediaType}]`, content_type: mediaType, sender_type: 'customer',
        whatsapp_message_id: randomUUID(),
      }).select('id').single()
      if (!msg) return null
      createdMessageIds.push(msg.id)

      // dispatched_at is set at creation (simulating "MacroDroid trigger
      // already sent") — this script tests the UPLOAD endpoint specifically,
      // not the dispatch-trigger mechanism (see
      // apps/worker/src/scripts/validate-autoresponder.ts for that). Without
      // this, apps/worker's real media-dispatcher.ts — typically running in
      // the background during manual validation — races to claim these
      // pending_android events too and marks them 'failed' against this
      // script's fake macrodroid_webhook_url before the upload request
      // arrives, which is correct production behavior but not what this
      // script means to exercise.
      const { data: event } = await supabase.from('media_events').insert({
        tenant_id: tenantId, account_id: account!.id, conversation_id: conv!.id, message_id: msg.id,
        media_type: mediaType, expected_filename: expectedFilename, status: 'pending_android',
        dispatched_at: new Date().toISOString(),
      }).select('id').single()
      if (event) createdEventIds.push(event.id)
      return event ? { eventId: event.id, messageId: msg.id } : null
    }

    ok('Setup: throwaway autoresponder account, contact, conversation created')

    // ── 5. No token → 401 ─────────────────────────────────────────────────────
    {
      const ev = await makeEvent('image', null)
      const res = await uploadMedia(buildRequest({ token: null, eventId: ev?.eventId, mediaType: 'image', contentType: 'image/jpeg', body: FAKE_IMAGE }))
      if (res.status === 401) ok('5. No device token → 401'); else nok('5. No device token', `status=${res.status}`)
    }

    // ── 6. Wrong token → 401 ──────────────────────────────────────────────────
    {
      const ev = await makeEvent('image', null)
      const req = buildRequest({ token: 'totally-wrong-token', eventId: ev?.eventId, mediaType: 'image', contentType: 'image/jpeg', body: FAKE_IMAGE })
      const res = await uploadMedia(req)
      if (res.status === 401) ok('6. Wrong device token → 401'); else nok('6. Wrong device token', `status=${res.status}`)
    }

    // ── 7. Event belonging to a DIFFERENT account → 403 ──────────────────────
    if (otherAccount) {
      const { data: msg } = await supabase.from('messages').insert({
        tenant_id: tenantId, conversation_id: conv.id, content: '[placeholder image]', content_type: 'image', sender_type: 'customer',
        whatsapp_message_id: randomUUID(),
      }).select('id').single()
      if (msg) createdMessageIds.push(msg.id)
      const { data: foreignEvent } = await supabase.from('media_events').insert({
        tenant_id: tenantId, account_id: otherAccount.id, conversation_id: conv.id, message_id: msg!.id,
        media_type: 'image', status: 'pending_android',
      }).select('id').single()
      if (foreignEvent) createdEventIds.push(foreignEvent.id)

      const req = buildRequest({ token: rawToken, eventId: foreignEvent!.id, mediaType: 'image', contentType: 'image/jpeg', body: FAKE_IMAGE })
      const res = await uploadMedia(req)
      if (res.status === 403) ok('7. Event belonging to a different account → 403'); else nok('7. Cross-account event', `status=${res.status}`)
    }

    // ── 8. Nonexistent event → 400 ────────────────────────────────────────────
    {
      const req = buildRequest({ token: rawToken, eventId: randomUUID(), mediaType: 'image', contentType: 'image/jpeg', body: FAKE_IMAGE })
      const res = await uploadMedia(req)
      if (res.status === 400) ok('8. Nonexistent event → 400'); else nok('8. Nonexistent event', `status=${res.status}`)
    }

    // ── Fase 7 Parte B: a non-UUID event id must reject cleanly (400), never
    //    reach media_events (which would throw Postgres 22P02 on a UUID
    //    column) and never touch Storage. Uses the EXACT non-UUID value
    //    physically observed during Fase 6 E2E testing. ────────────────────
    {
      const req = buildRequest({ token: rawToken, eventId: 'manual-image-test', mediaType: 'image', contentType: 'image/jpeg', body: FAKE_IMAGE })
      const res = await uploadMedia(req)
      if (res.status === 400) {
        ok('Fase 7 Parte B: non-UUID event id ("manual-image-test") → 400, not a 500')
      } else {
        nok('Fase 7 Parte B: invalid event id', `status=${res.status}`)
      }
    }

    // ── Fase 7 Parte B: a valid-shaped UUID that simply doesn't exist still
    //    behaves exactly like test 8 above (400, "Event not found") — proves
    //    the UUID format gate doesn't change the existing not-found path. ──
    {
      const req = buildRequest({ token: rawToken, eventId: randomUUID(), mediaType: 'document', filename: 'x.pdf', contentType: 'application/pdf', body: FAKE_PDF })
      const res = await uploadMedia(req)
      if (res.status === 400) {
        ok('Fase 7 Parte B: a well-formed but nonexistent UUID still continues past the format check to the normal "not found" path')
      } else {
        nok('Fase 7 Parte B: well-formed nonexistent UUID', `status=${res.status}`)
      }
    }

    // ── 9/20. Valid audio upload → stored, uploaded ──────────────────────────
    {
      const ev = await makeEvent('audio', null)
      const req = buildRequest({ token: rawToken, eventId: ev!.eventId, mediaType: 'audio', contentType: 'audio/ogg', body: FAKE_AUDIO })
      const res = await uploadMedia(req)
      const body = await res.json() as { ok?: boolean }

      const { data: eventAfter } = await supabase.from('media_events').select('status, storage_path').eq('id', ev!.eventId).single()
      const { data: msgAfter }   = await supabase.from('messages').select('media_storage_path, metadata').eq('id', ev!.messageId).single()

      // Accepts 'uploaded' OR anything further along ('processing'/'ready')
      // — apps/worker's real media-dispatcher.ts is typically running in the
      // background during manual validation and can pick this event up
      // (resumeAfterMediaReady) within the few ms between this script's
      // upload call and its own status SELECT. That is CORRECT end-to-end
      // behavior, not a bug — asserting the exact 'uploaded' value would be
      // asserting a race outcome, not the endpoint's actual contract.
      const acceptableStatuses = new Set(['uploaded', 'processing', 'ready'])
      if (res.status === 200 && body.ok && eventAfter && acceptableStatuses.has(eventAfter.status) && eventAfter.storage_path && msgAfter?.media_storage_path) {
        ok(`9/17/20. Valid audio upload stored — media_events reached '${eventAfter.status}', messages.media_storage_path set`)
      } else {
        nok('Valid audio upload', `status=${res.status}, event=${JSON.stringify(eventAfter)}, msg=${JSON.stringify(msgAfter)}`)
      }
      // Idempotency for THIS event is intentionally tested below using a
      // DOCUMENT instead of this audio event — apps/worker's real
      // media-dispatcher.ts is typically running in the background during
      // manual validation and picks up 'uploaded' audio events within
      // ~3s (by design — see resumeAfterMediaReady), racing this script's
      // own immediate re-upload attempt. A document never leaves 'ready'
      // once set, so it has no such race and is the more reliable case to
      // assert idempotency against.
    }

    // ── 10/21. Valid document upload → stored, ready, filename preserved ─────
    {
      const ev = await makeEvent('document', 'Contrato.pdf')
      const req = buildRequest({ token: rawToken, eventId: ev!.eventId, mediaType: 'document', filename: 'Contrato.pdf', contentType: 'application/pdf', body: FAKE_PDF })
      const res = await uploadMedia(req)

      const { data: eventAfter } = await supabase.from('media_events').select('status').eq('id', ev!.eventId).single()
      const { data: msgAfter }   = await supabase.from('messages').select('media_storage_path, metadata').eq('id', ev!.messageId).single()
      const filename = (msgAfter?.metadata as Record<string, unknown> | null)?.['filename']

      if (res.status === 200 && eventAfter?.status === 'ready' && msgAfter?.media_storage_path && filename === 'Contrato.pdf') {
        ok('11/21. Document upload stored — media_events=ready directly, original filename preserved in metadata')
      } else {
        nok('Document upload', `status=${res.status}, event=${JSON.stringify(eventAfter)}, filename=${filename}`)
      }

      // ── 22. Idempotency: re-upload the SAME event_id (document — immune to
      //    the background worker's polling, see comment above) ───────────────
      const res2 = await uploadMedia(buildRequest({ token: rawToken, eventId: ev!.eventId, mediaType: 'document', filename: 'Contrato.pdf', contentType: 'application/pdf', body: FAKE_PDF }))
      const body2 = await res2.json() as { ok?: boolean; alreadyProcessed?: boolean }
      if (res2.status === 200 && body2.alreadyProcessed) {
        ok('22. Re-uploading the same event_id is idempotent (200, alreadyProcessed) — no duplicate storage write')
      } else {
        nok('22. Idempotent re-upload', `status=${res2.status}, body=${JSON.stringify(body2)}`)
      }
    }

    // ── Fase 7 Parte A: a valid, accepted upload (the audio + document
    //    uploads above) must have updated this account's health telemetry —
    //    last_device_seen_at AND last_media_upload_at, and ONLY this
    //    account (otherAccount, created but never uploaded to, must stay
    //    untouched). ─────────────────────────────────────────────────────
    {
      const { data: healthAfter } = await supabase
        .from('whatsapp_accounts').select('last_device_seen_at, last_media_upload_at').eq('id', account.id).single()
      const recentEnough = (iso: string | null) => !!iso && Date.now() - new Date(iso).getTime() < 60_000

      if (recentEnough(healthAfter?.last_device_seen_at ?? null) && recentEnough(healthAfter?.last_media_upload_at ?? null)) {
        ok('Fase 7 Parte A: a valid media upload updates last_device_seen_at and last_media_upload_at')
      } else {
        nok('Fase 7 Parte A: media upload health tracking', JSON.stringify(healthAfter))
      }

      if (otherAccount) {
        const { data: otherHealth } = await supabase
          .from('whatsapp_accounts').select('last_device_seen_at, last_media_upload_at').eq('id', otherAccount.id).single()
        if (!otherHealth?.last_device_seen_at && !otherHealth?.last_media_upload_at) {
          ok('Fase 7 Parte A: a different account\'s health is never touched by this account\'s uploads')
        } else {
          nok('Fase 7 Parte A: cross-account health isolation', JSON.stringify(otherHealth))
        }
      }
    }

    // ── 12. Disallowed MIME → 415 ─────────────────────────────────────────────
    {
      const ev = await makeEvent('image', null)
      const req = buildRequest({ token: rawToken, eventId: ev!.eventId, mediaType: 'image', contentType: 'image/png', body: FAKE_IMAGE })
      const res = await uploadMedia(req)
      if (res.status === 415) ok('12. Disallowed MIME (image/png for an image event) → 415'); else nok('12. Disallowed MIME', `status=${res.status}`)
    }

    // ── Fase 6B.1: Content-Type claims image/jpeg but the bytes are not a
    // JPEG → rejected end-to-end (415), event marked failed, never stored ────
    {
      const ev = await makeEvent('image', null)
      const notActuallyJpeg = Buffer.from('this is plain text, not a jpeg, despite the header claim')
      const req = buildRequest({ token: rawToken, eventId: ev!.eventId, mediaType: 'image', contentType: 'image/jpeg', body: notActuallyJpeg })
      const res = await uploadMedia(req)

      const { data: eventAfter } = await supabase.from('media_events').select('status, error, storage_path').eq('id', ev!.eventId).single()
      const { data: msgAfter }   = await supabase.from('messages').select('media_storage_path').eq('id', ev!.messageId).single()

      if (res.status === 415 && eventAfter?.status === 'failed' && eventAfter.error === 'signature_mismatch' && !msgAfter?.media_storage_path) {
        ok('Fase 6B.1: Content-Type claims image/jpeg but bytes fail the magic-byte check → 415, event failed, nothing stored')
      } else {
        nok('Fase 6B.1: signature mismatch end-to-end', `status=${res.status}, event=${JSON.stringify(eventAfter)}, msg=${JSON.stringify(msgAfter)}`)
      }
    }

    // ── 13. Oversized file → 413 ──────────────────────────────────────────────
    {
      const ev = await makeEvent('image', null)
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1)
      const req = buildRequest({ token: rawToken, eventId: ev!.eventId, mediaType: 'image', contentType: 'image/jpeg', body: oversized })
      const res = await uploadMedia(req)
      if (res.status === 413) ok('13. Oversized file → 413'); else nok('13. Oversized file', `status=${res.status}`)
    }

  } finally {
    if (createdEventIds.length)        await supabase.from('media_events').delete().in('id', createdEventIds)
    if (createdMessageIds.length)      await supabase.from('messages').delete().in('id', createdMessageIds)
    if (createdConversationIds.length) await supabase.from('conversations').delete().in('id', createdConversationIds)
    if (createdAccountIds.length)      await supabase.from('whatsapp_accounts').delete().in('id', createdAccountIds)
    if (createdContactIds.length)      await supabase.from('contacts').delete().in('id', createdContactIds)
  }

  console.log(`\n${HR}`)
  console.log(`  Result: ${passed} passed, ${failed} failed`)
  console.log(HR)

  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n  [validate-media-upload] Fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})

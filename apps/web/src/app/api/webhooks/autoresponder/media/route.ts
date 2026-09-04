import { type NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { hashDeviceToken } from '@/lib/autoresponder-webhook'
import {
  isMediaType,
  isValidEventId,
  isAllowedMimeType,
  isWithinSizeLimit,
  matchesFileSignature,
  buildMediaStoragePath,
  sanitizeUploadFilename,
  type MediaType,
} from '@/lib/autoresponder-media'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEVICE_TOKEN_HEADER = 'x-reservanex-device-token'
const EVENT_ID_HEADER     = 'x-reservanex-event-id'
const MEDIA_TYPE_HEADER   = 'x-reservanex-media-type'
const FILENAME_HEADER     = 'x-reservanex-filename'

// Fase 7 Parte A — a valid, accepted media upload is direct physical
// evidence the Android is alive (unlike a MacroDroid trigger-service ACK,
// which only proves the relay accepted an order — see
// device_dispatch_reserved_until's doc comment for that distinction).
// Best-effort: a health-tracking failure must never fail the upload itself,
// so this never throws.
async function markDeviceMediaSeen(
  admin:     ReturnType<typeof createAdminClient>,
  accountId: string,
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await admin
    .from('whatsapp_accounts')
    .update({ last_device_seen_at: now, last_media_upload_at: now })
    .eq('id', accountId)
  if (error) {
    console.warn('[webhook:autoresponder:media] health update failed (non-fatal)', { code: error.code })
  }
}

// POST /api/webhooks/autoresponder/media
//
// MacroDroid uploads the real bytes of an audio/image/document that
// AutoResponder could only describe with a placeholder in the original
// inbound webhook (Fase 6B — see media_events). Body is the raw file; auth
// and routing travel entirely in headers, never in the URL or body.
//
// Never logs: media bytes, the MacroDroid webhook URL, the device token, or
// full document contents. Only event_id/account_id/tenant_id/
// conversation_id/message_id/media_type/byte-count/status/sanitized error.
export async function POST(req: NextRequest) {
  try {
    const deviceTokenHeader = req.headers.get(DEVICE_TOKEN_HEADER)
    const eventId            = req.headers.get(EVENT_ID_HEADER)
    const mediaTypeHeader    = req.headers.get(MEDIA_TYPE_HEADER)
    const filenameHeader     = req.headers.get(FILENAME_HEADER)

    if (!deviceTokenHeader || !deviceTokenHeader.trim()) {
      return NextResponse.json({ error: 'Missing device token' }, { status: 401 })
    }
    if (!eventId) {
      return NextResponse.json({ error: 'Missing event id' }, { status: 400 })
    }
    // Fase 7 Parte B — must reject a non-UUID event id BEFORE it ever
    // reaches a query against media_events.id (a UUID column) — otherwise
    // Postgres itself throws 22P02 (invalid input syntax for type uuid),
    // surfacing as an unhandled 500 instead of a clean 400. Physically
    // observed during Fase 6 E2E testing with a manual, non-UUID test value.
    if (!isValidEventId(eventId)) {
      return NextResponse.json({ error: 'Invalid event id' }, { status: 400 })
    }
    if (!isMediaType(mediaTypeHeader)) {
      return NextResponse.json({ error: 'Missing or invalid media type' }, { status: 400 })
    }

    const admin = createAdminClient()

    // 1. Authenticate — same hash scheme as the inbound text webhook.
    const tokenHash = hashDeviceToken(deviceTokenHeader)
    const { data: account, error: acctErr } = await admin
      .from('whatsapp_accounts')
      .select('id, tenant_id, active')
      .eq('provider', 'autoresponder')
      .eq('inbound_token_hash', tokenHash)
      .maybeSingle()

    if (acctErr) {
      console.error('[webhook:autoresponder:media] account lookup error', { code: acctErr.code })
      return NextResponse.json({ error: 'Invalid device token' }, { status: 401 })
    }
    if (!account || !account.active) {
      return NextResponse.json({ error: 'Invalid device token' }, { status: 401 })
    }

    // 2. Resolve the event — must exist, and must belong to THIS account.
    // Never trust the headers alone (Fase 6B report §7): media_type and
    // account ownership are re-derived from the DB row, not accepted as-is.
    const { data: event, error: eventErr } = await admin
      .from('media_events')
      .select('id, tenant_id, account_id, conversation_id, message_id, media_type, status, expected_filename')
      .eq('id', eventId)
      .maybeSingle()

    if (eventErr) {
      console.error('[webhook:autoresponder:media] event lookup error', { code: eventErr.code, eventId })
      return NextResponse.json({ error: 'Event lookup failed' }, { status: 500 })
    }
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 400 })
    }
    if (event.account_id !== account.id) {
      console.warn('[webhook:autoresponder:media] event belongs to a different account', {
        eventId, eventAccountId: event.account_id, callerAccountId: account.id,
      })
      return NextResponse.json({ error: 'Event does not belong to this account' }, { status: 403 })
    }
    if (event.media_type !== mediaTypeHeader) {
      return NextResponse.json({ error: 'Media type mismatch' }, { status: 400 })
    }
    if (event.media_type === 'document' && !filenameHeader?.trim()) {
      return NextResponse.json({ error: 'Missing filename for document' }, { status: 400 })
    }

    // 3. Idempotency (Fase 6B report §15) — a retried/duplicate upload for
    // the SAME event_id must never duplicate storage/message/transcription.
    if (event.status === 'ready' || event.status === 'uploaded') {
      console.log('[webhook:autoresponder:media] idempotent — already processed', {
        eventId, tenantId: event.tenant_id, accountId: account.id, status: event.status,
      })
      await markDeviceMediaSeen(admin, account.id)
      return NextResponse.json({ ok: true, alreadyProcessed: true }, { status: 200 })
    }
    if (event.status === 'uploading' || event.status === 'processing') {
      return NextResponse.json({ error: 'Event is already being processed' }, { status: 409 })
    }
    if (event.status !== 'pending_android') {
      return NextResponse.json({ error: `Event is in a terminal state: ${event.status}` }, { status: 409 })
    }

    // 4. Atomically claim the event (pending_android → uploading) — the row-
    // level WHERE guard means a second concurrent request for the same
    // event_id can never win this UPDATE too.
    const { data: claimed } = await admin
      .from('media_events')
      .update({ status: 'uploading', updated_at: new Date().toISOString() })
      .eq('id', eventId)
      .eq('status', 'pending_android')
      .select('id')
      .maybeSingle()

    if (!claimed) {
      return NextResponse.json({ error: 'Event is already being processed' }, { status: 409 })
    }

    const mediaType: MediaType = event.media_type as MediaType

    // 5. Content-Type / size validation.
    const contentType = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!isAllowedMimeType(mediaType, contentType)) {
      await admin.from('media_events').update({
        status: 'failed', error: 'unsupported_mime_type', updated_at: new Date().toISOString(),
      }).eq('id', eventId)
      return NextResponse.json({ error: 'Unsupported media type' }, { status: 415 })
    }

    const buffer = Buffer.from(await req.arrayBuffer())

    if (!isWithinSizeLimit(mediaType, buffer.byteLength)) {
      const reason = buffer.byteLength === 0 ? 'empty_body' : 'file_too_large'
      await admin.from('media_events').update({
        status: 'failed', error: reason, updated_at: new Date().toISOString(),
      }).eq('id', eventId)
      const status = buffer.byteLength === 0 ? 400 : 413
      return NextResponse.json({ error: reason === 'empty_body' ? 'Empty body' : 'File too large' }, { status })
    }

    // 5b. Fase 6B.1 — Content-Type is a claim by the caller, not proof.
    // Reject anything whose actual bytes don't match the signature expected
    // for its declared media type before it ever reaches Storage.
    if (!matchesFileSignature(mediaType, buffer)) {
      await admin.from('media_events').update({
        status: 'failed', error: 'signature_mismatch', updated_at: new Date().toISOString(),
      }).eq('id', eventId)
      console.warn('[webhook:autoresponder:media] file signature does not match declared type', { eventId, mediaType })
      return NextResponse.json({ error: 'File content does not match declared type' }, { status: 415 })
    }

    // 6. Store — same bucket and path convention as Meta's media (see
    // apps/worker/src/whatsapp/media.ts's uploadWhatsAppMediaToStorage):
    // {tenant_id}/{conversation_id}/{message_id}.{ext}. No event_id needed
    // in the path — message_id already uniquely identifies it 1:1.
    const storagePath = buildMediaStoragePath(event.tenant_id, event.conversation_id, event.message_id, contentType)

    const { error: uploadErr } = await admin.storage
      .from('whatsapp-media')
      .upload(storagePath, buffer, { contentType, upsert: true })

    if (uploadErr) {
      console.error('[webhook:autoresponder:media] storage upload failed', { eventId, error: uploadErr.message })
      await admin.from('media_events').update({
        status: 'failed', error: 'storage_upload_failed', updated_at: new Date().toISOString(),
      }).eq('id', eventId)
      return NextResponse.json({ error: 'Storage error' }, { status: 500 })
    }

    // 7. Sanitized filename for documents — display/metadata only, never
    // used to build the storage path (no path-traversal surface at all,
    // since the path is entirely message_id-derived above).
    const rawFilename  = mediaType === 'document' ? (filenameHeader ?? event.expected_filename ?? 'documento.pdf') : null
    const safeFilename = rawFilename ? sanitizeUploadFilename(rawFilename) : null

    const metadata: Record<string, unknown> = {
      mime_type:      contentType,
      original_type:  mediaType,
      storage_bucket: 'whatsapp-media',
      ...(safeFilename ? { filename: safeFilename } : {}),
    }

    const { error: msgUpdateErr } = await admin
      .from('messages')
      .update({ media_storage_path: storagePath, metadata: metadata as never })
      .eq('id', event.message_id)
      .eq('tenant_id', event.tenant_id)

    if (msgUpdateErr) {
      console.error('[webhook:autoresponder:media] message update failed', { eventId, error: msgUpdateErr.message })
    }

    // 8. Terminal status. Audio stops at 'uploaded' — the worker
    // (media-dispatcher.ts's resumeAfterMediaReady) transcribes it and
    // resumes the AI pipeline. Image/document go straight to 'ready' — their
    // AI reply already went out synchronously when the placeholder first
    // arrived (see apps/worker/src/processor.ts), so there is nothing left
    // to resume.
    const finalStatus = mediaType === 'audio' ? 'uploaded' : 'ready'
    await admin
      .from('media_events')
      .update({ status: finalStatus, storage_path: storagePath, uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', eventId)

    console.log('[webhook:autoresponder:media] stored', {
      eventId, tenantId: event.tenant_id, accountId: account.id, conversationId: event.conversation_id,
      messageId: event.message_id, mediaType, bytes: buffer.byteLength, status: finalStatus,
    })

    await markDeviceMediaSeen(admin, account.id)

    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    console.error('[webhook:autoresponder:media] fatal error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Webhook fatal error' }, { status: 500 })
  }
}

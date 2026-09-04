// Pure, DB-independent logic for the AutoResponder media upload endpoint
// (Fase 6B) — MIME/size validation, filename sanitization, storage path
// construction. Kept separate from the route handler so it is directly
// unit-testable, same rationale as autoresponder-platform.ts.

export type MediaType = 'audio' | 'image' | 'document'

// Deliberately narrow — matches only what was PHYSICALLY confirmed on the
// test device (Fase 6B contract), never a generic "accept common media
// types" allowlist. Extending this must be a conscious, one-line change per
// format, never a blanket relaxation.
export const MIME_ALLOWLIST: Record<MediaType, string[]> = {
  // WhatsApp voice notes are always OGG/Opus. application/ogg included
  // defensively for Android/OkHttp stacks that may report the container
  // MIME without the audio/ prefix for .opus files — never observed
  // physically, but cheap to allow given the file's own OggS/OpusHead
  // signature is what actually matters, not this header.
  audio:    ['audio/ogg', 'application/ogg'],
  // WhatsApp Business always saves received photos as .jpg.
  image:    ['image/jpeg'],
  document: ['application/pdf'],
}

export const MAX_BYTES: Record<MediaType, number> = {
  audio:    20 * 1024 * 1024, // voice notes are seconds-to-minutes; headroom under Groq's own 25MB cap
  image:    10 * 1024 * 1024, // a phone camera photo, uncompressed by us
  document: 20 * 1024 * 1024, // PDFs (CVs, contracts) — generous, still bounded
}

export function isMediaType(value: string | null | undefined): value is MediaType {
  return value === 'audio' || value === 'image' || value === 'document'
}

// Fase 7 Parte B — a real x-reservanex-event-id observed during physical E2E
// testing ("manual-image-test") was not a UUID at all. media_events.id is a
// UUID column, so querying it with a non-UUID string makes Postgres itself
// reject the query (22P02 invalid_text_representation) before any WHERE
// clause is even evaluated — surfacing as an unhandled 500, not a clean 400.
// ReservaNex always generates real UUIDs for event ids, so this never
// triggers in normal operation; it only matters for malformed/manual
// requests, which must fail cleanly (400) without ever reaching the DB.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidEventId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function isAllowedMimeType(mediaType: MediaType, contentType: string): boolean {
  const clean = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return MIME_ALLOWLIST[mediaType].includes(clean)
}

export function isWithinSizeLimit(mediaType: MediaType, byteLength: number): boolean {
  return byteLength > 0 && byteLength <= MAX_BYTES[mediaType]
}

// Fase 6B.1 — Content-Type alone is a claim by the caller, not proof. A
// minimal file-signature (magic bytes) check catches a mislabeled/corrupted
// upload before it ever reaches Storage. Deliberately just a handful of
// byte comparisons — no library, no full format parsing (that would be
// scope creep for what this needs to prove: "does the body's first few
// bytes match what its declared MIME type claims to be").
//
// %PDF-        → PDF (ASCII 0x25 0x50 0x44 0x46 0x2D)
// FF D8 FF     → JPEG (SOI marker + first segment marker byte)
// "OggS"       → OGG container (ASCII 0x4F 0x67 0x67 0x53) — covers both
//                audio/ogg and application/ogg, since both are validated
//                against the SAME container signature (Opus is a codec
//                inside the OGG container, not a distinct file signature).
const SIGNATURES: Record<MediaType, (bytes: Uint8Array) => boolean> = {
  document: (bytes) => startsWithAscii(bytes, '%PDF-'),
  image:    (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  audio:    (bytes) => startsWithAscii(bytes, 'OggS'),
}

function startsWithAscii(bytes: Uint8Array, ascii: string): boolean {
  if (bytes.length < ascii.length) return false
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[i] !== ascii.charCodeAt(i)) return false
  }
  return true
}

export function matchesFileSignature(mediaType: MediaType, bytes: Uint8Array): boolean {
  return SIGNATURES[mediaType](bytes)
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg':       'ogg',
  'application/ogg': 'ogg',
  'image/jpeg':      'jpg',
  'application/pdf': 'pdf',
}

export function extFromMime(mimeType: string): string {
  const clean = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return EXT_BY_MIME[clean] ?? 'bin'
}

// Same bucket/path convention as Meta's media (see
// apps/worker/src/whatsapp/media.ts's uploadWhatsAppMediaToStorage):
// {tenant_id}/{conversation_id}/{message_id}.{ext}. No event_id needed —
// message_id already uniquely identifies it 1:1 with its media event, so
// this alone is already collision-free.
export function buildMediaStoragePath(
  tenantId:       string,
  conversationId: string,
  messageId:      string,
  mimeType:       string,
): string {
  return `${tenantId}/${conversationId}/${messageId}.${extFromMime(mimeType)}`
}

// Sanitizes a filename for DISPLAY/METADATA use only — this value is NEVER
// used to construct the storage path (see buildMediaStoragePath above,
// entirely message_id-derived), so there is no path-traversal surface
// regardless, but the value still gets echoed into messages.metadata and (at
// dispatch time) a MacroDroid rn_filename query param, so it is neutralized
// defensively: strips path separators, control characters, and collapses
// traversal sequences.
export function sanitizeUploadFilename(rawFilename: string): string {
  const stripped = rawFilename
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  const withoutTraversal = stripped.replace(/\.\.+/g, '.')
  return withoutTraversal.slice(0, 255) || 'documento'
}

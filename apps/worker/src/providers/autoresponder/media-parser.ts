// Pure classification of AutoResponder's inbound message placeholders for
// non-text WhatsApp content. AutoResponder never gives us bytes or a
// filename for audio/image (only a fixed-format placeholder string); for
// documents it gives us the exact filename and page count but still no
// bytes. No Supabase, no HTTP — synchronous and unit-testable offline.
//
// Formats below are the exact strings physically observed on the Android
// test device (Fase 6B contract) — nothing here is guessed. If AutoResponder
// ever changes its wording, this parser will simply fail to match and the
// message falls back to 'text' (visible to DeepSeek as literal placeholder
// text) rather than silently misclassifying — a safe failure mode, not a
// hidden one.

export type AutoResponderMessageClassification =
  | { type: 'text' }
  | { type: 'audio'; durationSeconds: number | null }
  | { type: 'image' }
  | { type: 'document'; filename: string; pages: number | null }

// "🎤 Voice message (0:03)" — minutes:seconds, no fixed digit count observed
// for minutes (assume 1+ digits to be safe for longer notes).
const VOICE_RE = /^🎤\s*Voice message\s*\((\d+):(\d{2})\)\s*$/u

// "📷 Photo" — no caption, no filename, nothing else observed in the payload.
const PHOTO_RE = /^📷\s*Photo\s*$/u

// "📄 JeronimoCarduCV_2026.pdf (2 pages)" — filename is greedy-but-bounded by
// the trailing " (<N> page[s])" suffix, which AutoResponder appends for real
// paginated documents.
const DOCUMENT_WITH_PAGES_RE = /^📄\s*(.+?)\s*\((\d+)\s*pages?\)\s*$/u

// Fase 7 Parte C — a second, real placeholder shape physically observed
// during Fase 6 E2E testing: "📄 pc.jpeg", with NO page-count suffix at all.
// AutoResponder only omits "(N pages)" for files it doesn't treat as a
// paginated document — the one confirmed real sample was a JPEG shared
// through WhatsApp's "send as document" path. Filename-only, no page count.
const DOCUMENT_NO_PAGES_RE = /^📄\s*(.+)$/u

// Fase 7 Parte C — gates which "📄 <filename>" placeholders actually become
// a media_event. The full round trip (parser → media_event → MacroDroid
// document branch → upload endpoint) is only PHYSICALLY PROVEN end to end
// for real PDFs: the upload endpoint's MIME allowlist and magic-byte check
// (apps/web/src/lib/autoresponder-media.ts) only accept application/pdf +
// the %PDF- signature for media_type='document'. A "📄 pc.jpeg" placeholder
// is a real, confirmed case of a non-PDF file arriving via the document
// path — creating a media_event for it would dispatch a MacroDroid trigger
// for an upload our own server is guaranteed to reject with 415, wasting a
// physical Android action for nothing. Widening the MIME/signature
// allowlist to accept images-as-documents is a real, separate decision
// (broadens what "document" accepts server-side, with its own security
// review) that was NOT made here — see the Fase 7 report for exactly what
// it would take. Until then, a placeholder for an unsupported extension
// safely falls back to 'text' — same "no fingir procesamiento" principle as
// an unrecognized format entirely.
function hasSupportedDocumentExtension(filename: string): boolean {
  return /\.pdf$/i.test(filename.trim())
}

export function classifyAutoResponderMessage(rawMessage: string): AutoResponderMessageClassification {
  const trimmed = rawMessage.trim()

  const voiceMatch = VOICE_RE.exec(trimmed)
  if (voiceMatch) {
    const minutes = parseInt(voiceMatch[1]!, 10)
    const seconds = parseInt(voiceMatch[2]!, 10)
    const total   = minutes * 60 + seconds
    return { type: 'audio', durationSeconds: Number.isFinite(total) ? total : null }
  }

  if (PHOTO_RE.test(trimmed)) {
    return { type: 'image' }
  }

  const withPagesMatch = DOCUMENT_WITH_PAGES_RE.exec(trimmed)
  if (withPagesMatch) {
    const filename = withPagesMatch[1]!.trim()
    const pages    = parseInt(withPagesMatch[2]!, 10)
    // A match with an empty filename is not a real document placeholder —
    // treat as text rather than create a media event with no usable name.
    if (!filename) return { type: 'text' }
    if (!hasSupportedDocumentExtension(filename)) return { type: 'text' }
    return { type: 'document', filename, pages: Number.isFinite(pages) ? pages : null }
  }

  const noPagesMatch = DOCUMENT_NO_PAGES_RE.exec(trimmed)
  if (noPagesMatch) {
    const filename = noPagesMatch[1]!.trim()
    if (!filename) return { type: 'text' }
    if (!hasSupportedDocumentExtension(filename)) return { type: 'text' }
    return { type: 'document', filename, pages: null }
  }

  return { type: 'text' }
}

// Strips characters that have no business in a filename used for display
// (metadata) or as a MacroDroid rn_filename query param — never used to
// build a storage path directly (storage paths are message_id-based, see
// apps/web/src/lib/autoresponder-media.ts's buildMediaStoragePath), but
// still worth neutralizing path separators and control characters
// defensively before persisting/echoing it anywhere.
export function sanitizeDisplayFilename(rawFilename: string): string {
  const stripped = rawFilename
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  const withoutTraversal = stripped.replace(/\.\.+/g, '.')
  return withoutTraversal.slice(0, 255) || 'archivo'
}

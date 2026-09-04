// Fase 9 — WhatsApp Business (com.whatsapp.w4b) media folder paths and the
// shell one-liners MacroDroid uses to locate the latest file in them.
// Purely presentational text generation for the /platform install guide —
// nothing here ever executes a shell command server-side; the output is
// copy-pasted by a human into a MacroDroid "Shell Script" action running ON
// the Android. That does not make injection-safety optional: a superadmin
// pasting an attacker-influenced path (or simply fat-fingering one) must
// never produce a string that does something other than "list the latest
// matching file" when MacroDroid actually runs it.

// Physically-confirmed default folders (Fase 8/9 validated device). Editable
// in the UI for a device with a different WhatsApp Business installation —
// these are the validated starting point, never a guess.
export const DEFAULT_VOICE_NOTES_PATH =
  '/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Voice Notes'
export const DEFAULT_IMAGES_PATH =
  '/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Images'
export const DEFAULT_DOCUMENTS_PATH =
  '/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Documents'

const REQUIRED_PREFIX = '/storage/emulated/0/'

// Strict ALLOWLIST, not a blocklist of "dangerous" characters — a blocklist
// can always miss a shell metacharacter nobody thought of; an allowlist
// cannot. Only letters, digits, spaces, and a small set of path-safe
// punctuation pass. Every shell metacharacter (; & | $ ` ( ) < > ' " \ * ?
// [ ] { } ! ~ # % ^ + = : ,), every newline/carriage-return, and every null
// byte is rejected simply by not appearing in this set — none of them need
// to be enumerated individually.
const SAFE_PATH_PATTERN = /^\/storage\/emulated\/0\/[A-Za-z0-9 _.-]+(?:\/[A-Za-z0-9 _.-]+)*$/

// Returns the trimmed, validated path, or null if it fails any check.
// Trimming incidental leading/trailing whitespace (a common paste artifact)
// is treated as normalization, not silently accepting a different value —
// the trimmed result is what gets validated AND is what every builder below
// actually uses.
export function sanitizeAndroidStoragePath(path: string): string | null {
  if (typeof path !== 'string') return null
  if (/[\n\r\0]/.test(path)) return null

  const trimmed = path.trim()
  if (!trimmed.startsWith(REQUIRED_PREFIX)) return null
  if (trimmed.length <= REQUIRED_PREFIX.length) return null
  if (trimmed.endsWith('/')) return null
  if (trimmed.includes('..')) return null
  if (!SAFE_PATH_PATTERN.test(trimmed)) return null

  return trimmed
}

export function isValidAndroidStoragePath(path: string): boolean {
  return sanitizeAndroidStoragePath(path) !== null
}

// WhatsApp nests voice notes one folder level deeper (by date) than images —
// hence the extra */ segment. Physically validated Fase 8/9 shell one-liner.
export function buildAudioShellCommand(voiceNotesPath: string): string | null {
  const safe = sanitizeAndroidStoragePath(voiceNotesPath)
  return safe ? `ls -t "${safe}"/*/*.opus 2>/dev/null | head -n 1` : null
}

export function buildImageShellCommand(imagesPath: string): string | null {
  const safe = sanitizeAndroidStoragePath(imagesPath)
  return safe ? `ls -t "${safe}"/*.jpg 2>/dev/null | head -n 1` : null
}

// Documents are the one media type AutoResponder gives an exact filename
// for (rn_filename) — no "latest file" heuristic needed, just a direct path.
export function buildDocumentPathTemplate(documentsPath: string): string | null {
  const safe = sanitizeAndroidStoragePath(documentsPath)
  return safe ? `${safe}/[rn_filename]` : null
}

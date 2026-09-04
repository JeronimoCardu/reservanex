const GROQ_API_URL    = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_MODEL      = 'whisper-large-v3-turbo'
const MAX_AUDIO_BYTES = 25 * 1024 * 1024  // 25 MB — Groq's file limit

// Groq accepted types: flac mp3 mp4 mpeg mpga m4a ogg opus wav webm
// Maps clean MIME base (no codec params) to a Groq-accepted file extension.
// WhatsApp voice notes arrive as "audio/ogg; codecs=opus" → "ogg".
const MIME_TO_GROQ_EXT: Record<string, string> = {
  'audio/ogg':   'ogg',
  'audio/opus':  'opus',
  'audio/mpeg':  'mp3',
  'audio/mp3':   'mp3',
  'audio/mp4':   'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac':   'm4a',   // aac not in Groq list; m4a container is closest
  'audio/wav':   'wav',
  'audio/webm':  'webm',
  'audio/flac':  'flac',
  'audio/amr':   'ogg',   // amr not supported; ogg is the WhatsApp default fallback
}

function groqExtFromMime(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return MIME_TO_GROQ_EXT[base] ?? 'ogg'
}

export type TranscriptionResult =
  | { status: 'completed'; text: string }
  | { status: 'failed';    error: string }
  | { status: 'skipped';   reason: string }

// Transcribes an audio buffer using Groq Whisper.
// Requires GROQ_API_KEY env var. Returns 'skipped' if the key is absent.
// Never throws — all failure paths produce { status: 'failed' | 'skipped' }.
// The third argument (_hint) is a caller label used only in logs; the Groq
// filename is always derived from mimeType so the extension is correct.
export async function transcribeAudio(
  buffer:   Buffer,
  mimeType: string,
  _hint:    string,
): Promise<TranscriptionResult> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    console.log('[transcribe] GROQ_API_KEY not configured — skipping transcription')
    return { status: 'skipped', reason: 'GROQ_API_KEY not configured' }
  }

  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    console.warn('[transcribe] audio too large to transcribe', { bytes: buffer.byteLength, limit: MAX_AUDIO_BYTES })
    return { status: 'skipped', reason: `audio exceeds ${MAX_AUDIO_BYTES} bytes` }
  }

  // Strip MIME parameters before sending ("audio/ogg; codecs=opus" → "audio/ogg")
  // and derive a Groq-compatible filename with a supported extension.
  const cleanMime = mimeType.split(';')[0]?.trim().toLowerCase() || 'audio/ogg'
  const ext       = groqExtFromMime(cleanMime)
  const groqFile  = `whatsapp-audio.${ext}`

  console.log('[transcribe] sending to Groq', { filename: groqFile, mimeType: cleanMime, sizeBytes: buffer.byteLength })

  try {
    const form = new FormData()
    // Third arg to form.append sets multipart filename — must have a Groq-supported extension.
    // Do NOT set a manual Content-Type header on the request; let fetch generate it with boundary.
    form.append('file', new Blob([new Uint8Array(buffer)], { type: cleanMime }), groqFile)
    form.append('model', GROQ_MODEL)
    form.append('response_format', 'json')

    const res = await fetch(GROQ_API_URL, {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body:    form,
      signal:  AbortSignal.timeout(60_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText)
      console.error('[transcribe] Groq API error', { status: res.status, body: body.slice(0, 300) })
      return { status: 'failed', error: `HTTP ${res.status}` }
    }

    const data = await res.json() as { text?: string }
    if (typeof data.text !== 'string' || !data.text.trim()) {
      console.error('[transcribe] Groq returned empty text', { data })
      return { status: 'failed', error: 'empty transcription' }
    }

    const text = data.text.trim()
    console.log('[transcribe] completed', { chars: text.length, groqFile })
    return { status: 'completed', text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[transcribe] network error:', msg)
    return { status: 'failed', error: msg }
  }
}

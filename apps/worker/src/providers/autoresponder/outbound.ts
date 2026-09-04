// MacroDroid dispatch for AutoResponder outbound — both outbound text sends
// (rn_phone/rn_message) and media-extraction triggers (rn_event_id/
// rn_media_type/rn_filename, Fase 6B). Both go through the SAME single
// MacroDroid webhook/macro (Fase 6B.1 report §3), so every request ALWAYS
// carries an explicit rn_action discriminator ('outbound' | 'media') that
// the macro must branch on FIRST, before looking at any other param — see
// Fase 6B.1 report §1/§2. This is a hard requirement, not a convenience:
// MacroDroid's webhook trigger updates its variables from the incoming
// query params, and whether those variables reliably reset between
// executions could not be verified from this environment — rn_action being
// ALWAYS present and used as the sole branch discriminator means a stale
// rn_media_type/rn_phone/rn_message from a PREVIOUS execution can never
// cause the wrong branch to run, regardless of MacroDroid's actual variable-
// persistence behavior. The two build DIFFERENT remaining query params
// (different branches of the same macro) but the same GET-and-expect-
// literal-"OK" wire contract, so the fetch/classify logic is shared via
// performMacroDroidDispatch.

const DISPATCH_TIMEOUT_MS = 15_000

// Physically confirmed trigger shape:
// GET <webhookUrl>?rn_action=outbound&rn_phone=...&rn_message=...&rn_outbox_id=...
// URLSearchParams handles percent-encoding of spaces, accents, ñ, newlines and
// punctuation correctly — no manual encoding needed.
//
// rn_outbox_id (Fase 8 "outbound ACK" — added alongside the existing
// rn_phone/rn_message, names of neither changed) is the messaging_outbox
// row's own UUID, echoed back unchanged by the macro in its POST to
// /api/webhooks/autoresponder/outbound-ack after WhatsApp Send runs — see
// that route for how it's used to identify (never trust) which dispatch is
// being confirmed. Never the tenant id or tenant name — identity for that
// callback comes entirely from the device token header, exactly like every
// other AutoResponder webhook.
export function buildMacroDroidUrl(webhookUrl: string, phone: string, message: string, outboxId: string): URL {
  const url = new URL(webhookUrl)
  url.searchParams.set('rn_action', 'outbound')
  url.searchParams.set('rn_phone', phone)
  url.searchParams.set('rn_message', message)
  url.searchParams.set('rn_outbox_id', outboxId)
  return url
}

// Fase 6B: triggers the "go fetch the media file" branch instead of the
// "send this text" branch of the same macro (rn_action=media). rn_filename
// is only ever set for media_type='document' — AutoResponder gives no
// filename for audio/image, so MacroDroid must locate "the most recent
// file" in the matching media folder for those (see Fase 6B report §6 for
// the residual race risk this implies and the serialization mitigation).
export function buildMacroDroidMediaTriggerUrl(
  webhookUrl: string,
  eventId:    string,
  mediaType:  'audio' | 'image' | 'document',
  filename?:  string | null,
): URL {
  const url = new URL(webhookUrl)
  url.searchParams.set('rn_action', 'media')
  url.searchParams.set('rn_event_id', eventId)
  url.searchParams.set('rn_media_type', mediaType)
  if (mediaType === 'document' && filename) {
    url.searchParams.set('rn_filename', filename)
  }
  return url
}

export interface MacroDroidDispatchResult {
  status: 'dispatched' | 'failed'
  // Sanitized, fixed-vocabulary error — NEVER derived from err.message or the
  // response body, both of which can echo back the request URL (observed
  // behavior of Node's fetch/undici on connection failures) or, in the body
  // case, potentially other request-derived content. See "SEGURIDAD" in the
  // Fase 4 report §6 — this function's return value is safe to log as-is.
  error?: 'timeout' | 'network_error' | 'unreadable_response' | 'unexpected_response' | `http_${number}`
  // Observability follow-up (post Fase 8 physical E2E — a real 'network_error'
  // was completely unclassifiable from the worker log alone). ONLY set when
  // error === 'network_error'; a short, allowlisted, structural Node/libuv
  // code (e.g. 'ENOTFOUND', 'ECONNREFUSED') extracted from err.cause?.code —
  // never from err.message/err.cause.message/hostname/stack, any of which can
  // echo back the request URL. Console-log-only: dispatcher.ts logs this
  // alongside its '[dispatcher] failed' summary but NEVER writes it to
  // messaging_outbox.error, which stays exactly 'network_error'.
  networkCode?: string
}

// Fixed allowlist of short, structural Node/libuv error codes. Every one of
// these is a bare enum-like string from the OS/networking layer — none can
// ever contain a hostname, URL, query string, or token. Anything NOT on this
// list is dropped rather than logged, so an unfamiliar err.cause shape can
// never leak something unintended.
const SAFE_NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'EPIPE',
])

function extractSafeNetworkCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const cause = err.cause
  if (!cause || typeof cause !== 'object') return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' && SAFE_NETWORK_ERROR_CODES.has(code) ? code : undefined
}

async function performMacroDroidDispatch(url: URL): Promise<MacroDroidDispatchResult> {
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      signal:  AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    if (isTimeout) return { status: 'failed', error: 'timeout' }
    return { status: 'failed', error: 'network_error', networkCode: extractSafeNetworkCode(err) }
  }

  if (!res.ok) {
    return { status: 'failed', error: `http_${res.status}` }
  }

  let body: string
  try {
    body = (await res.text()).trim()
  } catch {
    return { status: 'failed', error: 'unreadable_response' }
  }

  if (body.toUpperCase() !== 'OK') {
    return { status: 'failed', error: 'unexpected_response' }
  }

  return { status: 'dispatched' }
}

// Fires the MacroDroid webhook to send a text message. Physically confirmed:
// MacroDroid responds with the literal body "OK" on success. Never retries —
// see dispatcher.ts and Fase 4 report §7 for why an ambiguous timeout must
// not be retried automatically (risk of sending the same WhatsApp message
// twice).
export async function dispatchToMacroDroid(
  webhookUrl: string,
  phone:      string,
  message:    string,
  outboxId:   string,
): Promise<MacroDroidDispatchResult> {
  return performMacroDroidDispatch(buildMacroDroidUrl(webhookUrl, phone, message, outboxId))
}

// Fase 6B: fires the MacroDroid webhook to trigger a media extraction+upload.
// "dispatched" here means MacroDroid ACKNOWLEDGED the trigger — exactly like
// dispatched != delivered for text, dispatched != uploaded for media. The
// actual upload arrives later, asynchronously, at POST
// /api/webhooks/autoresponder/media. Never retried automatically for the
// same reason as text dispatch.
export async function dispatchMediaTriggerToMacroDroid(
  webhookUrl: string,
  eventId:    string,
  mediaType:  'audio' | 'image' | 'document',
  filename?:  string | null,
): Promise<MacroDroidDispatchResult> {
  return performMacroDroidDispatch(buildMacroDroidMediaTriggerUrl(webhookUrl, eventId, mediaType, filename))
}

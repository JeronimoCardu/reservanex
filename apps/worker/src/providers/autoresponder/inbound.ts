// Pure parsing/validation for AutoResponder for WA's "Web Server" inbound
// contract. No Supabase, no HTTP, no side effects — everything here is
// synchronous and unit-testable offline.

import { normalizePhoneForWhatsApp, isValidARWhatsAppPhone } from '../../lib/phone'
import { classifyAutoResponderMessage } from './media-parser'

export const AUTORESPONDER_APP_PACKAGE = 'tkstudio.autoresponderforwa'
export const WHATSAPP_BUSINESS_PACKAGE = 'com.whatsapp.w4b'

export interface AutoResponderQuery {
  sender:           string
  message:          string
  isGroup:          boolean
  groupParticipant: string
  ruleId:           number
  isTestMessage:    boolean
}

export interface AutoResponderPayload {
  appPackageName:        string
  messengerPackageName:  string
  query:                 AutoResponderQuery
}

// Discriminates AutoResponder's payload shape (top-level `query` object) from
// Meta's (`entry[].changes[].value.messages[]`). Meta payloads never have a
// top-level `query` key, so this is a safe, simple discriminator — no need
// for a separate `provider` field on message_queue.
export function isAutoResponderPayload(payload: unknown): payload is AutoResponderPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const query = (payload as Record<string, unknown>).query
  return typeof query === 'object' && query !== null
}

// The Android is dedicated to this system — reject anything from an
// unexpected app/messenger combination rather than assume it's safe.
export function isValidAutoResponderPackages(payload: AutoResponderPayload): boolean {
  return (
    payload.appPackageName === AUTORESPONDER_APP_PACKAGE &&
    payload.messengerPackageName === WHATSAPP_BUSINESS_PACKAGE
  )
}

export function isGroupMessage(payload: AutoResponderPayload): boolean {
  return payload.query.isGroup === true
}

export type SenderResolution =
  | { resolved: true;  phone: string }
  | { resolved: false; reason: 'empty_sender' | 'sender_not_a_phone' }

// Resolves query.sender to a normalized AR WhatsApp phone, or explicitly
// reports it as unresolvable. NEVER treats a name (or anything else that
// isn't a phone) as a contact identifier — that is the entire purpose of
// this function; do not "helpfully" fall back to matching by name upstream.
//
// normalizePhoneForWhatsApp() already returns any input containing letters
// (e.g. a saved contact's display name, like "Jeronimo Cardu") UNCHANGED —
// see apps/worker/src/lib/phone.ts. Running isValidARWhatsAppPhone() on the
// result is therefore a reliable "is this really a phone" check with no
// additional heuristics needed.
export function resolveAutoResponderSender(rawSender: string): SenderResolution {
  const trimmed = rawSender.trim()
  if (!trimmed) return { resolved: false, reason: 'empty_sender' }

  const normalized = normalizePhoneForWhatsApp(trimmed)
  if (!isValidARWhatsAppPhone(normalized)) {
    return { resolved: false, reason: 'sender_not_a_phone' }
  }
  return { resolved: true, phone: normalized }
}

export interface ExtractedInboundMessage {
  from:               string
  // For provider=autoresponder this is an INTERNALLY generated event id (see
  // the webhook route), NOT a provider-guaranteed message id like Meta's
  // wamid. AutoResponder gives no stable message id, so this value only
  // protects against retries of the SAME message_queue row within our own
  // system (e.g. a worker crash mid-processing before completing it) — it
  // does NOT detect, and cannot detect, AutoResponder delivering the
  // identical webhook twice for what is, from the customer's phone, a
  // genuinely new send. Never treat this field as provider-level dedup for
  // autoresponder-sourced rows (see also KNOWN_LIMITATIONS.md-style note in
  // the Fase 4 report).
  whatsappMessageId: string
  messageText:        string
  // 'audio' | 'image' | 'document' come from classifyAutoResponderMessage()
  // matching AutoResponder's fixed placeholder text (Fase 6B) — never real
  // bytes at this point, only a signal that media exists and (for
  // documents) its real filename. mediaExtract stays null even for these —
  // it is Meta's shape (built around an immediately-downloadable mediaId),
  // which does not apply here; see mediaDurationSeconds/mediaFilename/
  // mediaPages instead, and apps/worker/src/media-dispatcher.ts (trigger
  // dispatch) + apps/web/src/app/api/webhooks/autoresponder/media/route.ts
  // (upload endpoint) for how the actual bytes get fetched via MacroDroid.
  messageType:         'text' | 'audio' | 'image' | 'document'
  mediaExtract:        null
  mediaDurationSeconds: number | null
  mediaFilename:        string | null
  mediaPages:           number | null
}

// Placeholder message text shown while media is not yet available — mirrors
// extractMessage()'s (Meta) exact wording for image/audio for consistency,
// since both paths funnel into the same messages.content / CRM rendering.
const PENDING_AUDIO_TEXT = '[Audio recibido. Transcribiendo...]'
const PENDING_IMAGE_TEXT = '[Imagen recibida. El equipo puede verla en el CRM.]'
function pendingDocumentText(filename: string): string {
  return `[Documento recibido: ${filename}. El equipo puede verlo en el CRM.]`
}

// Extracts the customer message from an already-validated AutoResponder
// payload. Caller must confirm isAutoResponderPayload() and
// isValidAutoResponderPackages() (and isGroupMessage() / resolveAutoResponderSender()
// as needed) first — this function does not repeat those checks.
//
// `internalEventId` must be generated ONCE per inbound webhook call, at
// receipt time, and persisted as part of the queued raw_payload so retries
// of the same queue row reuse the same id (see webhook-handler.ts).
export function extractAutoResponderMessage(
  payload:         AutoResponderPayload,
  internalEventId: string,
): ExtractedInboundMessage {
  const classification = classifyAutoResponderMessage(payload.query.message)
  const base = { from: payload.query.sender, whatsappMessageId: internalEventId, mediaExtract: null }

  if (classification.type === 'audio') {
    return {
      ...base,
      messageText:          PENDING_AUDIO_TEXT,
      messageType:          'audio',
      mediaDurationSeconds: classification.durationSeconds,
      mediaFilename:        null,
      mediaPages:           null,
    }
  }

  if (classification.type === 'image') {
    return {
      ...base,
      messageText:          PENDING_IMAGE_TEXT,
      messageType:          'image',
      mediaDurationSeconds: null,
      mediaFilename:        null,
      mediaPages:           null,
    }
  }

  if (classification.type === 'document') {
    return {
      ...base,
      messageText:          pendingDocumentText(classification.filename),
      messageType:          'document',
      mediaDurationSeconds: null,
      mediaFilename:        classification.filename,
      mediaPages:           classification.pages,
    }
  }

  return {
    ...base,
    messageText:          payload.query.message,
    messageType:          'text',
    mediaDurationSeconds: null,
    mediaFilename:        null,
    mediaPages:           null,
  }
}

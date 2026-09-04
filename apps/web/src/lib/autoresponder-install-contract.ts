// Fase 9 — pure, DB/env-independent constants describing the CURRENT,
// physically-validated AutoResponder wire contract. Single source of truth
// for the Android install guide UI (and docs/macrodroid-android-setup.md,
// kept manually in sync) so neither can silently drift from what the real
// route handlers actually expect. These mirror — never redefine
// differently — the literal header/query-param names each route under
// apps/web/src/app/api/webhooks/autoresponder/* already uses. Changing any
// of these values here does NOT change the routes; it would only make the
// guide wrong. Never "rediseñar" the pipelines themselves in this file.

// NOT re-exported from autoresponder-webhook.ts on purpose — that module
// pulls in node:crypto (hashDeviceToken), and this contract module is
// imported by a 'use client' component (android-install-guide.tsx).
// Re-exporting from it broke the webpack client build ("node:crypto" is
// not handled by plugins). Small, deliberate duplicate instead — same
// "shared pure constant duplicated across a module boundary" pattern
// already established for the web/worker split elsewhere in this codebase.
export const AUTORESPONDER_APP_PACKAGE = 'tkstudio.autoresponderforwa'
export const WHATSAPP_BUSINESS_PACKAGE = 'com.whatsapp.w4b'

export const HEADER_DEVICE_TOKEN = 'x-reservanex-device-token'
export const HEADER_EVENT_ID     = 'x-reservanex-event-id'
export const HEADER_MEDIA_TYPE   = 'x-reservanex-media-type'
export const HEADER_FILENAME     = 'x-reservanex-filename'
export const HEADER_OUTBOX_ID    = 'x-reservanex-outbox-id'

export const RN_VAR_ACTION     = 'rn_action'
export const RN_VAR_PHONE      = 'rn_phone'
export const RN_VAR_MESSAGE    = 'rn_message'
export const RN_VAR_EVENT_ID   = 'rn_event_id'
export const RN_VAR_MEDIA_TYPE = 'rn_media_type'
export const RN_VAR_FILENAME   = 'rn_filename'
export const RN_VAR_OUTBOX_ID  = 'rn_outbox_id'

export const RN_ACTION_OUTBOUND = 'outbound'
export const RN_ACTION_MEDIA    = 'media'

// Physically validated macro timing — MacroDroid-side steps only, no server
// code executes these waits. Kept as named constants so the guide UI, docs,
// and tests never quote three different numbers for the same thing.
//
// OUTBOUND_WAIT_BEFORE_SEND_SECONDS history: originally validated at 1s
// (Fase 8), but that was only ever exercised with the device active/
// foreground. The Fase 9 physical E2E (background + screen-off + post-
// reboot) reproduced a real failure at 1s: the Android would wake, WhatsApp
// would open to the right conversation and type the message, but it was
// left sitting as an unsent draft — Screen On hadn't given the device
// enough time to fully wake and stabilize before WhatsApp Send ran.
// Isolated and fixed by raising this to 3s; re-validated across
// foreground, background, screen-off, and post-reboot before being
// accepted as the current contract. Never lower this without re-validating
// physically under all four of those conditions, not just foreground.
export const OUTBOUND_WAIT_BEFORE_SEND_SECONDS = 3
export const OUTBOUND_WAIT_AFTER_SEND_SECONDS  = 3
export const MEDIA_WAIT_BEFORE_EXTRACT_SECONDS = 2
export const HEARTBEAT_INTERVAL_MINUTES        = 2

export type MediaBranchType = 'audio' | 'image' | 'document'

// Matches apps/web/src/lib/autoresponder-media.ts's MIME_ALLOWLIST exactly
// (primary/first-choice value only — audio also accepts application/ogg
// server-side, but audio/ogg is what the macro should send).
export const MEDIA_CONTENT_TYPE: Record<MediaBranchType, string> = {
  audio:    'audio/ogg',
  image:    'image/jpeg',
  document: 'application/pdf',
}

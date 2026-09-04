// Pure, DB-independent logic for the platform's AutoResponder account
// configuration (Fase 5). Kept separate from actions/platform-autoresponder.ts
// (which has 'use server' and Next.js/Supabase-SSR coupling via
// requireSuperAdmin()) so this logic is directly unit-testable — same
// rationale as apps/worker/src/providers/autoresponder/*.ts's pure/DB-touching
// split.

import { randomBytes } from 'node:crypto'
import { normalizePhoneForWhatsApp, isValidARWhatsAppPhone } from '@orderflow/validators'

// 256 bits of entropy — matches seed-autoresponder-account.ts's own minimum
// (≥20 chars) and hashDeviceToken()'s expected input (an opaque secret
// string). Hex-encoded so it's easy to copy/paste without escaping.
export function generateDeviceToken(): string {
  return randomBytes(32).toString('hex')
}

export function normalizeAndValidatePhone(
  input: string,
): { valid: true; phone: string } | { valid: false; error: string } {
  const trimmed = input.trim()
  if (!trimmed) return { valid: false, error: 'El número de WhatsApp Business es requerido.' }

  const normalized = normalizePhoneForWhatsApp(trimmed)
  if (!isValidARWhatsAppPhone(normalized)) {
    return { valid: false, error: 'El número no parece un WhatsApp argentino válido (ej: +54 9 11 1234-5678).' }
  }
  return { valid: true, phone: normalized }
}

// Fase 10 security audit — hostname allowlist. This URL is stored
// superadmin-side and later fetched server-side by the worker's dispatcher
// (apps/worker/src/providers/autoresponder/outbound.ts) with no further
// validation at fetch time — an unrestricted hostname is a real SSRF
// vector (a malicious or compromised superadmin session could point it at
// http://169.254.169.254/..., an internal-only service, etc., and the
// worker would happily fetch it with no signal anything was wrong).
// Every physically-confirmed real-world sample across Fases 4/8/9 used
// exactly this host — this product only supports MacroDroid's own cloud
// trigger service today (see the Fase 10 report for the audit that
// justified this), so an allowlist of the one legitimate host is strictly
// safer than an open URL with no reachability restriction at all, and
// changes nothing for the one real, working configuration.
const ALLOWED_MACRODROID_HOSTNAME = 'trigger.macrodroid.com'

export function validateMacroDroidWebhookUrl(
  input: string,
): { valid: true; url: string } | { valid: false; error: string } {
  const trimmed = input.trim()
  if (!trimmed) return { valid: false, error: 'La URL de MacroDroid es requerida.' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { valid: false, error: 'La URL de MacroDroid no es válida.' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'La URL de MacroDroid debe ser HTTPS.' }
  }

  if (parsed.hostname !== ALLOWED_MACRODROID_HOSTNAME) {
    return {
      valid: false,
      error: `La URL de MacroDroid debe pertenecer a ${ALLOWED_MACRODROID_HOSTNAME} (host recibido: ${parsed.hostname}).`,
    }
  }

  return { valid: true, url: trimmed }
}

export type AutoResponderStatus = 'not_configured' | 'incomplete' | 'ready' | 'disabled'

// "Listo" only means the record is well-formed and active — it does NOT mean
// the Android/MacroDroid is online. There is no health-check yet (Fase 5
// explicitly excludes it) — never claim "Online" from this alone.
export function deriveAutoResponderStatus(row: {
  phone_number:       string
  active:             boolean
  has_device_token:   boolean
  has_macrodroid_url: boolean
} | null): AutoResponderStatus {
  if (!row) return 'not_configured'

  const hasValidPhone = isValidARWhatsAppPhone(row.phone_number)
  const isComplete    = hasValidPhone && row.has_device_token && row.has_macrodroid_url

  if (!isComplete) return 'incomplete'
  return row.active ? 'ready' : 'disabled'
}

export interface AutoResponderPlatformData {
  id:                         string
  tenant_id:                  string
  phone_number:               string
  device_name:                string | null
  active:                     boolean
  has_device_token:           boolean
  has_macrodroid_url:         boolean
  status:                     AutoResponderStatus
  created_at:                 string
  updated_at:                 string
  // Fase 7 Parte A — device health telemetry (raw timestamps; the platform
  // UI derives online/stale/offline from these via
  // autoresponder-device-health.ts's deriveDeviceStatus, never a stored
  // boolean). See that module's doc comment for why this is a separate
  // concept from `status` above.
  last_device_seen_at:        string | null
  last_inbound_at:            string | null
  last_outbound_dispatch_at:  string | null
  last_media_upload_at:       string | null
  // Fase 8 "outbound ACK" — set only by a valid physical ACK from the macro,
  // never by the trigger-cloud's own 200 OK (that's last_outbound_dispatch_at
  // above). Distinguishes "disparado" from "confirmado por el dispositivo" —
  // never described as "delivered" (see outbound-status.ts).
  last_outbound_device_ack_at: string | null
}

// Raw secret fields (inbound_token_hash, macrodroid_webhook_url) are
// intentionally NOT parameters here — this function's signature itself
// makes it impossible to accidentally forward them into the sanitized shape
// that reaches the browser.
export function sanitizeAutoResponderRow(row: {
  id:                         string
  tenant_id:                  string
  phone_number:               string
  device_name:                string | null
  active:                     boolean
  has_device_token:           boolean
  has_macrodroid_url:         boolean
  created_at:                 string
  updated_at:                 string
  last_device_seen_at:        string | null
  last_inbound_at:            string | null
  last_outbound_dispatch_at:  string | null
  last_media_upload_at:       string | null
  last_outbound_device_ack_at: string | null
}): AutoResponderPlatformData {
  return {
    id:                         row.id,
    tenant_id:                  row.tenant_id,
    phone_number:               row.phone_number,
    device_name:                row.device_name,
    active:                     row.active,
    has_device_token:           row.has_device_token,
    has_macrodroid_url:         row.has_macrodroid_url,
    status:                     deriveAutoResponderStatus(row),
    created_at:                 row.created_at,
    updated_at:                 row.updated_at,
    last_device_seen_at:        row.last_device_seen_at,
    last_inbound_at:            row.last_inbound_at,
    last_outbound_dispatch_at:  row.last_outbound_dispatch_at,
    last_media_upload_at:       row.last_media_upload_at,
    last_outbound_device_ack_at: row.last_outbound_device_ack_at,
  }
}

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

// Fase 2A (AUTORESPONDER-ONLY) — validateMacroDroidWebhookUrl() and its
// SSRF host allowlist were deleted here. macrodroid_webhook_url is no longer
// settable or readable from anywhere in the product; the column survives
// only as a legacy DB artifact (see Fase 2A report §E).

export type AutoResponderStatus = 'not_configured' | 'incomplete' | 'ready' | 'disabled'

// "Listo" only means the record is well-formed and active — it does NOT mean
// the Android is online. There is no health-check yet (Fase 5 explicitly
// excludes it) — never claim "Online" from this alone.
//
// Fase 2A — completeness is phone + device token. Nothing MacroDroid-related
// gates an account any more.
export function deriveAutoResponderStatus(row: {
  phone_number:       string
  active:             boolean
  has_device_token:   boolean
} | null): AutoResponderStatus {
  if (!row) return 'not_configured'

  const hasValidPhone = isValidARWhatsAppPhone(row.phone_number)
  const isComplete    = hasValidPhone && row.has_device_token

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
}

// Raw secret fields (inbound_token_hash) are
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
  created_at:                 string
  updated_at:                 string
  last_device_seen_at:        string | null
  last_inbound_at:            string | null
}): AutoResponderPlatformData {
  return {
    id:                         row.id,
    tenant_id:                  row.tenant_id,
    phone_number:               row.phone_number,
    device_name:                row.device_name,
    active:                     row.active,
    has_device_token:           row.has_device_token,
    status:                     deriveAutoResponderStatus(row),
    created_at:                 row.created_at,
    updated_at:                 row.updated_at,
    last_device_seen_at:        row.last_device_seen_at,
    last_inbound_at:            row.last_inbound_at,
  }
}

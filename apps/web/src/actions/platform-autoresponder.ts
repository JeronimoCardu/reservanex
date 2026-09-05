'use server'

import { revalidatePath } from 'next/cache'
import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import { hashDeviceToken } from '@/lib/autoresponder-webhook'
import {
  generateDeviceToken,
  normalizeAndValidatePhone,
  sanitizeAutoResponderRow,
} from '@/lib/autoresponder-platform'
import type { AutoResponderPlatformData } from '@/lib/autoresponder-platform'
import type { ActionResult } from '@/lib/action-result'

// AutoResponderPlatformData is intentionally NOT re-exported from here.
// This file has 'use server' — every export becomes a candidate entry in
// Next's server-actions reference manifest, and a type-only re-export
// (`export type { X }`) has no runtime binding once types are erased,
// which crashes Turbopack's build with "Export X doesn't exist in target
// module". Consumers must import the type directly from
// '@/lib/autoresponder-platform' instead.

export type CreateAutoResponderInput = {
  phone_number:            string
  device_name?:            string
  active:                  boolean
}

// ── A) Get AutoResponder settings for a tenant (SA only) ─────────────────────
// Never returns inbound_token_hash — only a boolean derived from its
// presence. It IS selected from the DB here (needed to compute that boolean)
// but sanitizeAutoResponderRow()'s return type makes it structurally
// impossible to forward it further.
export async function getTenantAutoResponderSettingsForPlatformAction(
  tenantId: string,
): Promise<ActionResult<AutoResponderPlatformData | null>> {
  await requireSuperAdmin()

  const admin = createAdminClient()

  const { data: tenant } = await admin
    .from('tenants')
    .select('id')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!tenant) return { success: false, error: 'Tenant no encontrado.' }

  // Unlike the Meta settings query (which filters active=true and so loses
  // visibility once deactivated), this intentionally fetches the most
  // recently touched autoresponder row REGARDLESS of active state — so the
  // "Desactivado" status (Fase 5 §9) is actually reachable in the UI instead
  // of silently falling back to "Sin configurar".
  const { data, error } = await admin
    .from('whatsapp_accounts')
    .select('id, tenant_id, phone_number, device_name, active, inbound_token_hash, created_at, updated_at, last_device_seen_at, last_inbound_at')
    .eq('tenant_id', tenantId)
    .eq('provider', 'autoresponder')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!data) return { success: true, data: null }

  return {
    success: true,
    data: sanitizeAutoResponderRow({
      id:                         data.id,
      tenant_id:                  data.tenant_id,
      phone_number:               data.phone_number,
      device_name:                data.device_name,
      active:                     data.active,
      has_device_token:           Boolean(data.inbound_token_hash),
      created_at:                 data.created_at,
      updated_at:                 data.updated_at,
      last_device_seen_at:        data.last_device_seen_at,
      last_inbound_at:            data.last_inbound_at,
    }),
  }
}

// ── B) Create the AutoResponder account (SA only) ─────────────────────────────
// Generates the device token server-side (256 bits) — the caller never
// supplies it. Returns the RAW token exactly once, in this response only; it
// is never persisted anywhere (only its SHA-256 hash is stored) and never
// logged.
export async function createAutoResponderAccountAction(
  tenantId: string,
  input:    CreateAutoResponderInput,
): Promise<ActionResult<{ id: string; raw_device_token: string }>> {
  await requireSuperAdmin()

  const phoneResult = normalizeAndValidatePhone(input.phone_number)
  if (!phoneResult.valid) return { success: false, error: phoneResult.error }

  const admin = createAdminClient()

  const { data: tenant } = await admin
    .from('tenants')
    .select('id')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!tenant) return { success: false, error: 'Tenant no encontrado.' }

  // This UI models exactly one AutoResponder account per tenant (matches the
  // single-card "Configurar" → "Editar/Rotar" UX). If one already exists
  // (active or not) direct the admin to the edit actions instead of
  // creating a second, orphaned row.
  const { data: existing } = await admin
    .from('whatsapp_accounts')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('provider', 'autoresponder')
    .maybeSingle()

  if (existing) {
    return {
      success: false,
      error: 'Ya existe una cuenta AutoResponder para este tenant. Usá Editar o Rotar token.',
    }
  }

  const rawToken  = generateDeviceToken()
  const tokenHash = hashDeviceToken(rawToken)

  const { data: created, error } = await admin
    .from('whatsapp_accounts')
    .insert({
      tenant_id:              tenantId,
      provider:               'autoresponder',
      phone_number:            phoneResult.phone,
      device_name:             input.device_name?.trim() || null,
      inbound_token_hash:      tokenHash,
      active:                  input.active,
    })
    .select('id')
    .single()

  if (error || !created) {
    if (error?.code === '23505') {
      return { success: false, error: 'Ya existe una cuenta activa con ese número de WhatsApp en este tenant.' }
    }
    return { success: false, error: error?.message ?? 'No se pudo crear la cuenta.' }
  }

  revalidatePath(`/platform/tenants/${tenantId}/whatsapp`)
  revalidatePath(`/platform/tenants/${tenantId}`)

  return { success: true, data: { id: created.id, raw_device_token: rawToken } }
}

// ── C) Update phone/device name only — never touches secrets (SA only) ───────
export async function updateAutoResponderPhoneAndNameAction(
  accountId: string,
  tenantId:  string,
  input:     { phone_number: string; device_name?: string },
): Promise<ActionResult> {
  await requireSuperAdmin()

  const phoneResult = normalizeAndValidatePhone(input.phone_number)
  if (!phoneResult.valid) return { success: false, error: phoneResult.error }

  const admin = createAdminClient()

  // .eq('tenant_id', tenantId) is not a convenience filter — it's the
  // server-side guard that the accountId being modified truly belongs to
  // the tenantId the caller claims (never trust tenant_id from the browser
  // alone). If they don't match, .select() below returns zero rows and we
  // report a clear error instead of silently no-op'ing.
  const { data, error } = await admin
    .from('whatsapp_accounts')
    .update({ phone_number: phoneResult.phone, device_name: input.device_name?.trim() || null })
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .eq('provider', 'autoresponder')
    .select('id')

  if (error) {
    if (error.code === '23505') return { success: false, error: 'Ya existe otra cuenta activa con ese número.' }
    return { success: false, error: error.message }
  }
  if (!data || data.length === 0) {
    return { success: false, error: 'Cuenta no encontrada para este tenant.' }
  }

  revalidatePath(`/platform/tenants/${tenantId}/whatsapp`)
  revalidatePath(`/platform/tenants/${tenantId}`)
  return { success: true }
}

// ── D) Rotate the device token (SA only) ──────────────────────────────────────
// The old token stops working IMMEDIATELY — inbound_token_hash is fully
// replaced (not appended/versioned), and the webhook route looks up the
// account by exact hash match, so the previous raw token no longer resolves
// to any account starting the instant this commits. No raw-token history is
// kept anywhere.
export async function rotateAutoResponderDeviceTokenAction(
  accountId: string,
  tenantId:  string,
): Promise<ActionResult<{ raw_device_token: string }>> {
  await requireSuperAdmin()

  const admin = createAdminClient()

  const rawToken  = generateDeviceToken()
  const tokenHash = hashDeviceToken(rawToken)

  const { data, error } = await admin
    .from('whatsapp_accounts')
    .update({ inbound_token_hash: tokenHash })
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .eq('provider', 'autoresponder')
    .select('id')

  if (error) {
    if (error.code === '23505') return { success: false, error: 'Colisión generando el token — intentá de nuevo.' }
    return { success: false, error: error.message }
  }
  if (!data || data.length === 0) {
    return { success: false, error: 'Cuenta no encontrada para este tenant.' }
  }

  revalidatePath(`/platform/tenants/${tenantId}/whatsapp`)
  revalidatePath(`/platform/tenants/${tenantId}`)
  return { success: true, data: { raw_device_token: rawToken } }
}

// ── E) (removed in Fase 2A) The MacroDroid webhook URL action lived here.
//    macrodroid_webhook_url is no longer settable from anywhere.

// ── F) Activate / deactivate (SA only) ────────────────────────────────────────
export async function setAutoResponderActiveAction(
  accountId: string,
  tenantId:  string,
  active:    boolean,
): Promise<ActionResult> {
  await requireSuperAdmin()

  const admin = createAdminClient()

  const { data, error } = await admin
    .from('whatsapp_accounts')
    .update({ active })
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .eq('provider', 'autoresponder')
    .select('id')

  if (error) {
    if (error.code === '23505') {
      return { success: false, error: 'Ya existe otra cuenta AutoResponder activa con ese número en este tenant.' }
    }
    return { success: false, error: error.message }
  }
  if (!data || data.length === 0) {
    return { success: false, error: 'Cuenta no encontrada para este tenant.' }
  }

  revalidatePath(`/platform/tenants/${tenantId}/whatsapp`)
  revalidatePath(`/platform/tenants/${tenantId}`)
  return { success: true }
}

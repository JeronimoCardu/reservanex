'use server'

import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import type { ActionResult } from '@/lib/action-result'
import { describeWhatsAppStatus, type WhatsAppStatusView } from '@/lib/whatsapp-status'

// Read-only sanitized view for tenant owner / receptionist: never the token
// nor the device-token hash — only what lib/whatsapp-status.ts derives.
export type WhatsAppSettingsData = WhatsAppStatusView

export async function getWhatsAppSettingsAction(): Promise<ActionResult<WhatsAppSettingsData>> {
  const ctx = await requireTenantContext()

  // Admin client required — RLS no longer grants session-based access to whatsapp_accounts
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('whatsapp_accounts')
    .select('provider, display_phone_number, phone_number, active, last_verified_at, access_token_encrypted, inbound_token_hash, last_inbound_at, last_device_seen_at')
    .eq('tenant_id', ctx.tenantId)
    // La activa si hay; si no, la última que tuvo el negocio, para poder decir
    // "Desactivado" en vez de "Sin configurar".
    .order('active', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  return { success: true, data: describeWhatsAppStatus(data) }
}

// Blocked — WhatsApp configuration is managed by ReservaNex Super Admin only.
export async function saveWhatsAppSettingsAction(): Promise<ActionResult> {
  await requireTenantContext()
  return {
    success: false,
    error: 'La configuración de WhatsApp la realiza el equipo de ReservaNex. Contactá a soporte.',
  }
}

export async function deactivateWhatsAppAccountAction(): Promise<ActionResult> {
  await requireTenantContext()
  return {
    success: false,
    error: 'La configuración de WhatsApp la realiza el equipo de ReservaNex. Contactá a soporte.',
  }
}

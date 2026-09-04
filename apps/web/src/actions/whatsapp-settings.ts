'use server'

import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import type { ActionResult } from '@/lib/action-result'

// Read-only sanitized view for tenant owner / receptionist
export type WhatsAppSettingsData = {
  display_phone_number: string | null
  phone_number:         string
  active:               boolean
  last_verified_at:     string | null
  has_token:            boolean
}

export async function getWhatsAppSettingsAction(): Promise<ActionResult<WhatsAppSettingsData | null>> {
  const ctx = await requireTenantContext()

  // Admin client required — RLS no longer grants session-based access to whatsapp_accounts
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('whatsapp_accounts')
    .select('display_phone_number, phone_number, active, last_verified_at, access_token_encrypted')
    .eq('tenant_id', ctx.tenantId)
    .eq('active', true)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!data)  return { success: true, data: null }

  return {
    success: true,
    data: {
      display_phone_number: data.display_phone_number ?? null,
      phone_number:         data.phone_number,
      active:               data.active,
      last_verified_at:     data.last_verified_at ?? null,
      has_token:            Boolean(data.access_token_encrypted),
    },
  }
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

'use server'

// Fase 8 §2/§9 — gathers the real per-tenant signals (owner, AI, AutoResponder
// config, device heartbeat, published properties) and reduces them through
// the pure deriveTenantSetupChecklist() into the single non-technical
// checklist a platform admin sees on the tenant detail page. Read-only.

import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import { getTenantById, getTenantSetupSignals } from '@/lib/repositories/platform.repository'
import { deriveAutoResponderStatus } from '@/lib/autoresponder-platform'
import { deriveDeviceStatus } from '@/lib/autoresponder-device-health'
import { deriveTenantSetupChecklist } from '@/lib/tenant-setup-status'
import type { TenantSetupChecklist } from '@/lib/tenant-setup-status'
import type { ActionResult } from '@/lib/action-result'

export async function getTenantSetupChecklistAction(
  tenantId: string,
): Promise<ActionResult<TenantSetupChecklist>> {
  await requireSuperAdmin()

  const tenant = await getTenantById(tenantId)
  if (!tenant) return { success: false, error: 'Tenant no encontrado.' }

  const signals = await getTenantSetupSignals(tenantId)

  const whatsappStatus = deriveAutoResponderStatus(
    signals.whatsapp
      ? {
          phone_number:       signals.whatsapp.phone_number,
          active:              signals.whatsapp.active,
          has_device_token:    signals.whatsapp.has_device_token,
        }
      : null,
  )

  const deviceStatus = deriveDeviceStatus({
    configStatus:     whatsappStatus,
    lastDeviceSeenAt: signals.lastDeviceSeenAt,
  })

  const checklist = deriveTenantSetupChecklist({
    tenantActive:           tenant.status === 'trial' || tenant.status === 'active',
    ownerActive:            signals.ownerActive,
    aiConfigured:           signals.aiConfigured,
    whatsappStatus,
    deviceStatus,
    publishedPropertyCount: signals.publishedPropertyCount,
  })

  return { success: true, data: checklist }
}

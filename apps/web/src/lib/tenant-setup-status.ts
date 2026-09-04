// Pure, DB-independent tenant-readiness derivation (Fase 8 §2/§9) — turns raw
// signals already computed elsewhere (AutoResponderStatus, DeviceStatus,
// owner/property counts) into ONE non-technical checklist + overall state a
// platform admin can read without knowing JWT/RLS/RPC/Supabase/WABA
// internals. Nothing here is persisted — recomputed at read time, same
// rationale as autoresponder-device-health.ts's derived (never stored)
// status. Deliberately NOT the same concept as the existing SetupStatusBadge
// on the tenant detail page (that one tracks the operator-assignment
// lifecycle: not_started/assigned/in_progress/completed/approved/revoked) —
// this module answers "is the tenant itself ready for pilot?", not "did an
// operator finish their assigned task?".

import type { AutoResponderStatus } from './autoresponder-platform'
import type { DeviceStatus } from './autoresponder-device-health'

export type TenantReadinessState =
  | 'not_started'       // nothing configured yet beyond the tenant row itself
  | 'setup_incomplete'  // owner and/or WhatsApp still missing/broken
  | 'android_offline'   // fully configured, but the phone isn't online right now
  | 'no_properties'     // fully configured + online, but nothing to show/sell yet
  | 'ready'              // ready for pilot

// Section 9 wants exactly two visible end states — "Configuración
// incompleta" or "Listo para piloto" — with no technical jargon. The finer
// TenantReadinessState values above stay available for internal use (list
// badges, filtering) without contradicting that simple final label.
export const TENANT_READINESS_LABEL: Record<TenantReadinessState, string> = {
  not_started:      'Configuración incompleta',
  setup_incomplete: 'Configuración incompleta',
  android_offline:  'Configuración incompleta',
  no_properties:    'Configuración incompleta',
  ready:            'Listo para piloto',
}

export interface TenantSetupChecklistItem {
  ok:    boolean
  label: string
}

export interface TenantSetupChecklist {
  tenant:     TenantSetupChecklistItem
  owner:      TenantSetupChecklistItem
  ai:         TenantSetupChecklistItem
  whatsapp:   TenantSetupChecklistItem
  android:    TenantSetupChecklistItem
  properties: TenantSetupChecklistItem
  state:      TenantReadinessState
  stateLabel: string
}

export function deriveTenantSetupChecklist(params: {
  tenantActive:           boolean  // tenants.status IN ('trial','active')
  ownerActive:            boolean  // >=1 tenant_users row, role=owner, active=true
  aiConfigured:           boolean  // an ai_settings row exists (informational only)
  whatsappStatus:         AutoResponderStatus
  deviceStatus:           DeviceStatus
  publishedPropertyCount: number
}): TenantSetupChecklist {
  const {
    tenantActive, ownerActive, aiConfigured,
    whatsappStatus, deviceStatus, publishedPropertyCount,
  } = params

  const whatsappOk   = whatsappStatus === 'ready'
  const everSeen     = deviceStatus === 'online' || deviceStatus === 'stale' || deviceStatus === 'offline'
  const androidOk     = deviceStatus === 'online'
  const propertiesOk = publishedPropertyCount > 0

  const tenant: TenantSetupChecklistItem = {
    ok:    tenantActive,
    label: tenantActive ? 'Datos básicos completos' : 'Inmobiliaria inactiva o suspendida',
  }
  const owner: TenantSetupChecklistItem = {
    ok:    ownerActive,
    label: ownerActive ? 'Owner activo' : 'Sin owner activo todavía',
  }
  // Always ok — ai_settings is genuinely optional (see tenant-provisioning.ts
  // §7 decision: worker code falls back to safe DeepSeek defaults when no
  // row exists), so a missing row is never itself a readiness blocker.
  const ai: TenantSetupChecklistItem = {
    ok:    true,
    label: aiConfigured ? 'Configurada' : 'Configurada (valores por defecto)',
  }
  const whatsapp: TenantSetupChecklistItem = {
    ok:    whatsappOk,
    label: whatsappOk ? 'AutoResponder configurado' : 'AutoResponder sin configurar',
  }
  const android: TenantSetupChecklistItem = {
    ok: androidOk,
    label:
      deviceStatus === 'online'     ? 'Online' :
      deviceStatus === 'stale'      ? 'Sin señal reciente' :
      deviceStatus === 'offline'    ? 'Offline' :
      deviceStatus === 'never_seen' ? 'Nunca conectado' :
                                       'Sin configurar',
  }
  const properties: TenantSetupChecklistItem = {
    ok: propertiesOk,
    label: propertiesOk
      ? `${publishedPropertyCount} propiedad${publishedPropertyCount === 1 ? '' : 'es'} publicada${publishedPropertyCount === 1 ? '' : 's'}`
      : 'Sin propiedades publicadas',
  }

  let state: TenantReadinessState
  if (!ownerActive && whatsappStatus === 'not_configured' && !propertiesOk) {
    state = 'not_started'
  } else if (!tenantActive || !ownerActive || !whatsappOk || !everSeen) {
    state = 'setup_incomplete'
  } else if (!androidOk) {
    state = 'android_offline'
  } else if (!propertiesOk) {
    state = 'no_properties'
  } else {
    state = 'ready'
  }

  return {
    tenant, owner, ai, whatsapp, android, properties,
    state, stateLabel: TENANT_READINESS_LABEL[state],
  }
}

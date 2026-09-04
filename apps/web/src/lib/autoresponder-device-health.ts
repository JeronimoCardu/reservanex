// Pure, DB-independent device HEALTH status derivation (Fase 7 Parte A) —
// deliberately separate from autoresponder-platform.ts's AutoResponderStatus
// (config completeness: not_configured/incomplete/ready/disabled). That
// enum answers "is this account set up correctly?"; this one answers "is the
// Android physically alive right now?" — two different questions, computed
// from two different signals (a static config row vs. a moving timestamp),
// intentionally not merged into one enum.
//
// Also unrelated to whatsapp_accounts.device_dispatch_reserved_until (Fase
// 6B.2) — that is short-lived (~20s) work-coordination between the
// outbound/media queues, not a health signal.
//
// No "online/offline" boolean is ever persisted — status is always DERIVED
// from last_device_seen_at at read time, so it can never drift out of sync
// with reality the way a stored flag would.

import type { AutoResponderStatus } from './autoresponder-platform'

export type DeviceStatus =
  | 'disabled'        // account.active = false
  | 'not_configured'  // config incomplete (see AutoResponderStatus)
  | 'never_seen'      // configured + active, but no signal ever received
  | 'online'          // last_device_seen_at within DEVICE_ONLINE_THRESHOLD_MS
  | 'stale'           // within DEVICE_STALE_THRESHOLD_MS but past online
  | 'offline'         // older than DEVICE_STALE_THRESHOLD_MS

// Centralized, testable thresholds — deliberately NOT the same concept or
// value as DEVICE_DISPATCH_LEASE_SECONDS (apps/worker/src/lib/device-lease.ts,
// 20s, work coordination). These are health-observability windows, in
// minutes, chosen to tolerate the heartbeat's own 2-minute interval (see the
// Fase 7 report's exact MacroDroid heartbeat config) without flickering
// between online/stale on ordinary jitter.
export const DEVICE_ONLINE_THRESHOLD_MS = 5 * 60 * 1000
export const DEVICE_STALE_THRESHOLD_MS  = 15 * 60 * 1000

export function deriveDeviceStatus(params: {
  configStatus:     AutoResponderStatus
  lastDeviceSeenAt: string | null
  now?:             Date
}): DeviceStatus {
  const { configStatus, lastDeviceSeenAt } = params

  if (configStatus === 'disabled') return 'disabled'
  if (configStatus !== 'ready') return 'not_configured'
  if (!lastDeviceSeenAt) return 'never_seen'

  const now       = params.now ?? new Date()
  const elapsedMs = now.getTime() - new Date(lastDeviceSeenAt).getTime()

  if (elapsedMs <= DEVICE_ONLINE_THRESHOLD_MS) return 'online'
  if (elapsedMs <= DEVICE_STALE_THRESHOLD_MS) return 'stale'
  return 'offline'
}

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  disabled:       'Desactivado',
  not_configured: 'Sin configurar',
  never_seen:     'Nunca visto',
  online:         'Online',
  stale:          'Sin señal reciente',
  offline:        'Offline',
}

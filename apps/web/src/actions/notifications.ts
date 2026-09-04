'use server'

import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { markNotificationRead } from '@/lib/repositories/notifications.repository'
import type { ActionResult } from '@/lib/action-result'

export async function markNotificationReadAction(
  notificationId: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  try {
    await markNotificationRead(ctx.tenantId, notificationId, ctx.userId)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al marcar la notificación.' }
  }
}

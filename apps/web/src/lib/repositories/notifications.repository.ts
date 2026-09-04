import type { NotificationRow } from '@orderflow/types'
import { createClient } from '@orderflow/supabase/server'

export async function listMyNotifications(
  tenantId: string,
  recipientId: string,
  opts?: { channel?: 'in_app'; onlyUnread?: boolean; limit?: number },
): Promise<NotificationRow[]> {
  const supabase = await createClient()

  let query = supabase
    .from('notifications')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('recipient_id', recipientId)
    .eq('recipient_type', 'tenant_user')
    .eq('channel', opts?.channel ?? 'in_app')
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 20)

  if (opts?.onlyUnread) {
    query = query.is('read_at', null)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function countUnread(
  tenantId: string,
  recipientId: string,
): Promise<number> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('recipient_id', recipientId)
    .eq('recipient_type', 'tenant_user')
    .eq('channel', 'in_app')
    .is('read_at', null)

  if (error) throw new Error(error.message)
  return count ?? 0
}

export async function markNotificationRead(
  tenantId: string,
  notificationId: string,
  recipientId: string,
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', notificationId)
    .eq('recipient_id', recipientId)
    .is('read_at', null)

  if (error) throw new Error(error.message)
}

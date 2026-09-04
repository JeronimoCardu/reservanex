import type { MessageRow } from '@orderflow/types'
import { createClient } from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import type { OutboundTrackingInfo } from '@/lib/outbound-status'

export type { MessageRow }

export async function listMessages(
  tenantId: string,
  conversationId: string,
  opts?: { limit?: number; before?: string },
): Promise<MessageRow[]> {
  const supabase = await createClient()
  const limit    = opts?.limit ?? 100

  // Fetch the LAST N messages in DESC order, then reverse so the caller receives
  // them in ascending chronological order for display.
  // Using DESC+reverse instead of ASC+offset ensures the most recent messages
  // are always included even in long conversations.
  let query = supabase
    .from('messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (opts?.before) {
    query = query.lt('created_at', opts.before)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []).reverse()
}

// Fase 8 "outbound ACK" — messaging_outbox rows for the given messages,
// keyed by message_id, as a plain object (Map isn't serializable across the
// server→client boundary; the client component converts this back into a
// Map). At most one outbox row per message in practice (enqueueOutboxMessage
// is called once per outbound message), so no aggregation is needed. A
// message with no key in the returned object has no outbound tracking at
// all — inbound (customer) messages, Meta-provider sends, or a message
// whose enqueue itself failed before any row was created — callers must
// treat that as "no status to show", never as a state.
export async function getOutboundTrackingForMessages(
  tenantId:   string,
  messageIds: string[],
): Promise<Record<string, OutboundTrackingInfo>> {
  if (messageIds.length === 0) return {}

  // messaging_outbox has RLS enabled with NO policies (service-role only —
  // same reason every other read/write against this table in this codebase
  // uses the admin client: actions/messages.ts's enqueue, and all three
  // AutoResponder webhook routes). The anon/session-scoped client used by
  // listMessages() above would silently return zero rows here.
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('messaging_outbox')
    .select('message_id, status, dispatched_at, device_ack_at')
    .eq('tenant_id', tenantId)
    .in('message_id', messageIds)

  if (error || !data) return {}

  const result: Record<string, OutboundTrackingInfo> = {}
  for (const row of data) {
    result[row.message_id] = {
      status:       row.status,
      dispatchedAt: row.dispatched_at,
      deviceAckAt:  row.device_ack_at,
    }
  }
  return result
}

export async function createMessage(
  tenantId: string,
  conversationId: string,
  input: {
    content:             string
    content_type:        'text' | 'image' | 'document' | 'audio' | 'video'
    sender_type:         'human'
    sender_id:           string
    media_storage_path?: string | null
    metadata?:           Record<string, unknown> | null
  },
): Promise<MessageRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('messages')
    .insert({
      tenant_id:          tenantId,
      conversation_id:    conversationId,
      content:            input.content,
      content_type:       input.content_type,
      sender_type:        input.sender_type,
      sender_id:          input.sender_id,
      media_storage_path: input.media_storage_path ?? null,
      metadata:           (input.metadata ?? null) as never,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)

  return data
}

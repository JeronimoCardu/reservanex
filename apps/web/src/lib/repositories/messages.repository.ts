import type { MessageRow } from '@orderflow/types'
import { createClient } from '@orderflow/supabase/server'
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

// Fase 2A (AUTORESPONDER-ONLY) — this used to read messaging_outbox to show
// per-message "disparado / confirmado por el dispositivo" badges in the CRM.
// That table is a legacy artifact now: nothing writes to it any more (the
// MacroDroid dispatcher that produced those rows was deleted), so the read
// could only ever return rows from before the migration. It is gone rather
// than left querying a dead table on every conversation open.
//
// The signature is intentionally preserved and returns an empty map, so the
// message-rendering components keep compiling and simply render no outbound
// badge — exactly what they already do for Meta sends and inbound messages.
// Removing the UI plumbing itself belongs to the Conversaciones rework
// (Fase 2B), not to this cleanup.
export async function getOutboundTrackingForMessages(
  _tenantId:   string,
  _messageIds: string[],
): Promise<Record<string, OutboundTrackingInfo>> {
  return {}
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

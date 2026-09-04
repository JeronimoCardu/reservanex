import { createClient } from './lib/supabase'

// Inserts a pending_android media event for an AutoResponder inbound
// audio/image/document message — Fase 6B. Mirrors outbox.ts's
// enqueueOutboxMessage() convention: never throws, logs and returns null on
// failure. media-dispatcher.ts's poll loop (via claim_next_media_event)
// picks this up asynchronously and fires the MacroDroid trigger.
export async function createMediaEvent(params: {
  tenantId:          string
  accountId:         string
  conversationId:    string
  messageId:         string
  mediaType:         'audio' | 'image' | 'document'
  expectedFilename?: string | null
}): Promise<{ id: string } | null> {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('media_events')
    .insert({
      tenant_id:         params.tenantId,
      account_id:        params.accountId,
      conversation_id:   params.conversationId,
      message_id:        params.messageId,
      media_type:        params.mediaType,
      expected_filename: params.expectedFilename ?? null,
      status:            'pending_android',
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[media-events] failed to create event', {
      error:          error?.message,
      tenantId:       params.tenantId,
      conversationId: params.conversationId,
      mediaType:      params.mediaType,
    })
    return null
  }

  console.log('[media-events] created', {
    eventId:        data.id,
    tenantId:       params.tenantId,
    conversationId: params.conversationId,
    mediaType:      params.mediaType,
  })
  return { id: data.id }
}

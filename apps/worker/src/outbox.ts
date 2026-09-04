import { createClient } from './lib/supabase'

// Inserts a pending row into messaging_outbox. Used for provider=autoresponder
// only — provider=meta keeps sending synchronously via whatsapp/sender.ts,
// unchanged (see Fase 4 report §5/§10). Never throws: a failure to enqueue is
// logged and returns null, same "non-fatal" convention as sendWhatsAppReply().
export async function enqueueOutboxMessage(params: {
  tenantId:          string
  accountId:         string
  conversationId:    string
  messageId:         string
  destinationPhone:  string
  text:              string
  source:            'ai' | 'human'
}): Promise<{ id: string } | null> {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('messaging_outbox')
    .insert({
      tenant_id:         params.tenantId,
      account_id:        params.accountId,
      conversation_id:   params.conversationId,
      message_id:        params.messageId,
      destination_phone: params.destinationPhone,
      text:              params.text,
      provider:          'autoresponder',
      source:            params.source,
      status:            'pending',
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[outbox] failed to enqueue message', {
      error:          error?.message,
      tenantId:       params.tenantId,
      conversationId: params.conversationId,
      source:         params.source,
    })
    return null
  }

  console.log('[outbox] enqueued', {
    outboxId:       data.id,
    tenantId:       params.tenantId,
    conversationId: params.conversationId,
    source:         params.source,
  })
  return { id: data.id }
}

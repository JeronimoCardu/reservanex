import { createClient } from '../lib/supabase'
import type { MessageContext } from '../context/builder'
import type { LLMResult } from '../lib/llm'

export async function writeMemory(
  ctx:    MessageContext,
  result: LLMResult,
): Promise<{ aiMessageId: string }> {
  const supabase = createClient()

  // Each AI message records which inbound wamid it is replying to.
  // The unique index messages_one_ai_reply_per_inbound_idx enforces at most
  // one row with this key, so duplicate retries hit a 23505 constraint rather
  // than silently inserting a second reply.
  const meta = {
    in_reply_to_whatsapp_message_id: ctx.whatsappMessageId,
    reply_mode: 'autonomous' as const,
  }

  const { data: inserted, error: msgError } = await supabase
    .from('messages')
    .insert({
      tenant_id:       ctx.tenantId,
      conversation_id: ctx.conversationId,
      content:         result.text,
      content_type:    'text',
      sender_type:     'ai',
      metadata:        meta as never,
    })
    .select('id')
    .single()

  if (msgError) {
    // 23505 = unique_violation — the DB index caught a duplicate before the
    // processor-level dedupe did (e.g. two workers racing on the same item).
    if (msgError.code === '23505') {
      console.warn('[memory-writer] unique constraint caught duplicate AI reply — returning existing id.', {
        inboundWhatsAppMessageId: ctx.whatsappMessageId,
        conversationId:           ctx.conversationId,
      })

      const { data: existing } = await supabase
        .from('messages')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('sender_type', 'ai')
        .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', ctx.whatsappMessageId)
        .maybeSingle()

      if (existing) return { aiMessageId: existing.id }
      // Fallthrough: constraint fired but we can't find the row — treat as real error
    }

    throw new Error(`[memory-writer] Failed to store AI message: ${msgError.message}`)
  }

  if (!inserted) {
    throw new Error('[memory-writer] Insert returned no data')
  }

  // Log token usage (non-fatal)
  const { error: logError } = await supabase
    .from('ai_usage_log')
    .insert({
      tenant_id:       ctx.tenantId,
      conversation_id: ctx.conversationId,
      model:           result.model,
      input_tokens:    result.usage?.inputTokens  ?? 0,
      output_tokens:   result.usage?.outputTokens ?? 0,
      cost_usd_cents:  null,
    })

  if (logError) {
    console.error('[memory-writer] Failed to write ai_usage_log:', logError.message)
  }

  // Bump conversation updated_at so it surfaces at the top of the inbox
  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', ctx.conversationId)

  const total = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
  console.log('[memory-writer] written', {
    aiMessageId:              inserted.id,
    conversationId:           ctx.conversationId,
    inboundWhatsAppMessageId: ctx.whatsappMessageId,
    model:                    result.model,
    tokens:                   total,
  })

  return { aiMessageId: inserted.id }
}

// Called after the Meta send succeeds. Updates the AI message row with the
// outbound wamid returned by Meta and merges it into existing metadata so the
// in_reply_to_whatsapp_message_id field is preserved.
export async function updateAiMessageWamid(
  tenantId:      string,
  aiMessageId:   string,
  outboundWamid: string,
): Promise<void> {
  const supabase = createClient()

  // Fetch current metadata to merge (not overwrite) the outbound fields
  const { data: row } = await supabase
    .from('messages')
    .select('metadata')
    .eq('id', aiMessageId)
    .eq('tenant_id', tenantId)
    .single()

  const merged = {
    ...(row?.metadata as Record<string, unknown> | null ?? {}),
    outbound_whatsapp_message_id: outboundWamid,
    sent_at: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('messages')
    .update({
      whatsapp_message_id: outboundWamid,
      metadata:            merged as never,
    })
    .eq('id', aiMessageId)
    .eq('tenant_id', tenantId)

  if (error) {
    // Non-fatal: message is already persisted and sent; losing the wamid is acceptable
    console.error('[memory-writer] Failed to store outbound wamid:', error.message, {
      aiMessageId,
      outboundWamid,
    })
  } else {
    console.log('[memory-writer] outbound wamid stored', { aiMessageId, outboundWamid })
  }
}

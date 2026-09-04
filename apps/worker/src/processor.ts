import type { Database } from '@orderflow/types'
import { createClient } from './lib/supabase'
import { buildContext } from './context/builder'
import type { MessageContext, LeadContext } from './context/builder'
import { generateAIReply } from './context/responder'
import type { LLMResult } from './lib/llm'
import { writeMemory, updateAiMessageWamid } from './memory/writer'
import { sendWhatsAppReply } from './whatsapp/sender'
import { downloadMetaMedia, uploadWhatsAppMediaToStorage } from './whatsapp/media'
import { transcribeAudio } from './whatsapp/transcribe'
import { executeEscalateToHuman } from './tools/escalate-to-human'
import { enqueueOutboxMessage } from './outbox'
import { createMediaEvent } from './media-events'

// Resolves which provider to dispatch THROUGH: the CONVERSATION's canonical
// account's real provider column — NOT ctx.provider, which only reflects the
// shape of the message that just arrived.
//
// Fase 4.1 correction: this used to be the PRIMARY defense against a real
// bug, where a contact messaging the tenant through two different
// channels/accounts could land in the SAME conversation (matched by
// contact+channel only), so a later AutoResponder-shaped message could
// resolve a conversation whose canonical account was still Meta. That bug is
// now fixed at the source — apps/worker/src/context/builder.ts's
// findConversationForAccount() never lets an inbound from account X match a
// conversation belonging to a different account Y, so ctx.whatsappAccountId
// and ctx.provider should always agree in the normal case. This function is
// kept as a cheap, correct defense-in-depth check (a single indexed lookup)
// in case that invariant is ever violated by a future change, rather than
// silently trusting ctx.provider. Falls back to ctx.provider only when there
// is no canonical account to look up (legacy conversation with no recorded
// whatsapp_account_id).
async function resolveDispatchProvider(ctx: MessageContext): Promise<'meta' | 'autoresponder'> {
  if (!ctx.whatsappAccountId) return ctx.provider

  const supabase = createClient()
  const { data: account } = await supabase
    .from('whatsapp_accounts')
    .select('provider')
    .eq('id', ctx.whatsappAccountId)
    .maybeSingle()

  if (!account) return ctx.provider
  return account.provider === 'autoresponder' ? 'autoresponder' : 'meta'
}

// Routes an AI reply's delivery by provider. provider='meta' is completely
// unchanged (synchronous Graph API call, same as before this file existed —
// see whatsapp/sender.ts, untouched — it already looks up the account by
// ctx.whatsappAccountId on its own, so it automatically sends through the
// conversation's canonical account). provider='autoresponder' cannot send
// synchronously (MacroDroid dispatch is a separate, serialized, asynchronous
// process — see apps/worker/src/dispatcher.ts and Fase 4 report §5/§8), so it
// enqueues into messaging_outbox instead and returns immediately.
async function dispatchOutboundReply(
  ctx:         MessageContext,
  text:        string,
  aiMessageId: string,
): Promise<string> {
  const provider = await resolveDispatchProvider(ctx)

  if (provider === 'autoresponder' && ctx.whatsappAccountId) {
    const queued = await enqueueOutboxMessage({
      tenantId:          ctx.tenantId,
      accountId:         ctx.whatsappAccountId,
      conversationId:    ctx.conversationId,
      messageId:         aiMessageId,
      destinationPhone:  ctx.contactPhone,
      text,
      source:            'ai',
    })
    return queued ? `outbox:${queued.id}` : 'outbox:failed'
  }

  const outboundWamid = await sendWhatsAppReply(ctx, text)
  if (outboundWamid) {
    await updateAiMessageWamid(ctx.tenantId, aiMessageId, outboundWamid)
  }
  return outboundWamid ?? 'not sent'
}

// Fixed handoff message sent as the last AI response when the cycle limit is reached.
// Must not mention: IA, Meta, WhatsApp, limits, costs, or plan.
const AI_HANDOFF_MESSAGE =
  'Para seguir ayudándote bien, voy a pasar esta conversación a una persona de la inmobiliaria.\n\n' +
  'En breve alguien del equipo te responde por acá.'

const AUDIO_TRANSCRIPTION_FAILED_TEXT =
  'Recibí tu audio, pero no pude transcribirlo automáticamente. Un asesor lo va a revisar.'

// Fase 6B.1 — distinct from the above: here no bytes ever arrived at all
// (MacroDroid never uploaded), so we never even claim to have "received" the
// audio. Must not mention IA/Meta/WhatsApp/limits/costs/plan — same
// constraint as AI_HANDOFF_MESSAGE above.
const AUDIO_NEVER_UPLOADED_TEXT =
  'No pudimos recibir tu audio. Un asesor te va a escribir para ayudarte con lo que necesites.'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

// Sends the fixed "couldn't transcribe" apology and escalates to a human —
// shared by Meta's synchronous audio path and AutoResponder's deferred one
// (Fase 6B's resumeAfterMediaReady). Never calls the LLM: the apology text is
// deterministic, matching the existing "no inventar contenido" rule for a
// failed transcription.
//
// Fase 6B.1: generalized into sendFixedAudioFallbackAndEscalate so the SAME
// mechanism (fixed message + escalate) also covers "audio never uploaded at
// all" (handleMediaNeverUploaded, below) — a distinct failure mode found
// during Fase 6B.1's audit that previously left the customer with pure
// silence. Not a new strategy: same primitives, a second honest wording.
async function sendFixedAudioFallbackAndEscalate(
  ctx:          MessageContext,
  text:         string,
  finishReason: string,
): Promise<void> {
  const supabase = createClient()
  const { data: convMode } = await supabase
    .from('conversations')
    .select('ai_mode')
    .eq('id', ctx.conversationId)
    .single()

  if (convMode?.ai_mode !== 'autonomous') {
    console.log('[processor:audio] skipping AI reply — manual mode', {
      conversationId: ctx.conversationId,
      aiMode:         convMode?.ai_mode,
    })
    return
  }

  const fixedResult: LLMResult = { text, finishReason, model: 'system' }
  const { aiMessageId } = await writeMemory(ctx, fixedResult)
  await dispatchOutboundReply(ctx, text, aiMessageId)

  // Escalate to human: sets ai_mode='manual', needs_human_attention=true,
  // human_attention_requested_at=now(). Non-fatal — reply already sent.
  await executeEscalateToHuman(ctx.tenantId, ctx.conversationId).catch((escalErr: unknown) => {
    console.warn('[processor:audio] escalation update failed (non-fatal)', {
      conversationId: ctx.conversationId,
      error:          escalErr instanceof Error ? escalErr.message : String(escalErr),
    })
  })
  console.log('[processor:audio] sent fixed reply and escalated to human', {
    conversationId: ctx.conversationId,
    finishReason,
  })
}

async function handleAudioTranscriptionFailure(ctx: MessageContext): Promise<void> {
  await sendFixedAudioFallbackAndEscalate(ctx, AUDIO_TRANSCRIPTION_FAILED_TEXT, 'audio_transcription_failed')
}

// Dedupe guard → AI slot claim → generateAIReply → dispatch. Extracted from
// processMessage() (Fase 6B) so the SAME critical path can be invoked either
// synchronously (text, Meta media, AutoResponder image/document — all of
// which already have their final ctx.messageText available immediately) or
// later, asynchronously, once AutoResponder audio's transcription completes
// (see resumeAfterMediaReady below). Logic is unchanged from before the
// extraction — only moved.
async function runAIPipeline(ctx: MessageContext): Promise<void> {
  const supabase = createClient()

  // ── Dedupe guard ────────────────────────────────────────────────────────────
  // Before calling the LLM, check whether we already have an AI reply for this
  // exact inbound wamid. This covers two scenarios:
  //   1. Meta retried the same webhook POST → same wamid enqueued twice
  //   2. message_queue has a duplicate row for the same payload
  // The DB-level unique index (messages_one_ai_reply_per_inbound_idx) is the
  // authoritative guard; this application-level check avoids an unnecessary
  // LLM call when the duplicate is detected early. For AutoResponder audio
  // (Fase 6B) it ALSO doubles as idempotency against the upload endpoint
  // being hit twice for the same event — see resumeAfterMediaReady.
  const { data: existingReply } = await supabase
    .from('messages')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('sender_type', 'ai')
    .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', ctx.whatsappMessageId)
    .maybeSingle()

  if (existingReply) {
    console.log('[processor] duplicate inbound already answered — skipping', {
      inboundWhatsAppMessageId: ctx.whatsappMessageId,
      conversationId:           ctx.conversationId,
      aiMessageId:              existingReply.id,
      duplicateSkipped:         true,
    })
    return
  }

  // ── AI auto-reply cycle limit ────────────────────────────────────────────────
  // Atomically claim one slot for this AI reply. The RPC increments the counter
  // only if: (a) conversation is still 'autonomous', AND (b) count < limit.
  // If two workers race on the same conversation, only one wins the UPDATE.
  type SlotRow = { claimed: boolean; new_count: number; reply_limit: number; is_last: boolean }
  const { data: slotRows, error: slotErr } = await supabase
    .rpc('claim_ai_auto_reply_slot', {
      p_conversation_id: ctx.conversationId,
      p_tenant_id:       ctx.tenantId,
    })

  if (slotErr) {
    // RPC failure is non-fatal — log and fall through to generateAIReply which
    // will do its own ai_mode check. Worst case: one extra reply beyond the limit.
    console.error('[processor:slot] claim_ai_auto_reply_slot failed (non-fatal)', {
      conversationId: ctx.conversationId,
      error:          slotErr.message,
    })
  } else {
    const slot = (slotRows as SlotRow[] | null)?.[0]

    if (!slot?.claimed) {
      // Already at limit or conversation switched to manual between enqueue and now.
      // Ensure manual mode + human attention are set (idempotent).
      await supabase
        .from('conversations')
        .update({
          ai_mode:                      'manual',
          needs_human_attention:        true,
          human_attention_requested_at: new Date().toISOString(),
        })
        .eq('id', ctx.conversationId)
        .eq('tenant_id', ctx.tenantId)
        .eq('ai_mode', 'autonomous')  // only update if still autonomous (guard)

      console.log('[processor:slot] at limit — no AI reply', {
        conversationId: ctx.conversationId,
        count:          slot?.new_count ?? '?',
        limit:          slot?.reply_limit ?? '?',
      })
      return
    }

    if (slot.is_last) {
      // This is the final slot (count == limit). Send the fixed handoff message.
      // Do NOT call the LLM — the handoff text is deterministic.
      const handoffResult: LLMResult = {
        text:         AI_HANDOFF_MESSAGE,
        finishReason: 'auto_reply_limit',
        model:        'system',
      }

      const { aiMessageId } = await writeMemory(ctx, handoffResult)
      const dispatchInfo    = await dispatchOutboundReply(ctx, AI_HANDOFF_MESSAGE, aiMessageId)

      // Transition conversation to manual mode with full handoff metadata.
      await supabase
        .from('conversations')
        .update({
          ai_mode:                      'manual',
          needs_human_attention:        true,
          human_attention_requested_at: new Date().toISOString(),
          ai_handoff_reason:            'auto_reply_limit',
          ai_handoff_at:                new Date().toISOString(),
        })
        .eq('id', ctx.conversationId)
        .eq('tenant_id', ctx.tenantId)

      console.log('[processor:slot] limit reached — handoff message sent', {
        conversationId:  ctx.conversationId,
        count:           slot.new_count,
        limit:           slot.reply_limit,
        aiMessageId,
        dispatch:        dispatchInfo,
      })
      return
    }

    // Slot claimed and not the last one — proceed with normal AI flow.
    console.log('[processor:slot] slot claimed', {
      conversationId: ctx.conversationId,
      count:          slot.new_count,
      limit:          slot.reply_limit,
    })
  }

  const result = await generateAIReply(ctx)

  if (result) {
    const { aiMessageId } = await writeMemory(ctx, result)
    const dispatchInfo    = await dispatchOutboundReply(ctx, result.text, aiMessageId)

    console.log('[processor] done', {
      conversationId:           ctx.conversationId,
      contactPhone:             ctx.contactPhone,
      aiMessageId,
      dispatch:                 dispatchInfo,
      inboundWhatsAppMessageId: ctx.whatsappMessageId,
    })
  } else {
    console.log('[processor] no AI reply generated', {
      conversationId: ctx.conversationId,
      contactPhone:   ctx.contactPhone,
    })
  }
}

export async function processMessage(queueItem: QueueRow): Promise<void> {
  console.log('[processor] processing', queueItem.id)

  const ctx     = await buildContext(queueItem)
  const supabase = createClient()

  // Track audio transcription outcome (set inside media block, consumed after dedupe)
  let audioTranscriptionStatus: 'completed' | 'failed' | 'skipped' | null = null
  let audioTranscriptionText:   string | null = null

  // ── Meta media: download + upload for image/document/audio messages ──────────
  // Runs before dedupe so that even retried queue items get their media stored.
  // Non-fatal: a failed download/upload leaves media_storage_path as null.
  // UNCHANGED from before Fase 6B — Meta always had bytes available
  // immediately (mediaId + access token), unlike AutoResponder (see block
  // below), so this stays fully synchronous.
  if (ctx.mediaType && ctx.mediaId && ctx.messageId && queueItem.whatsapp_account_id) {
    try {
      const { data: account } = await supabase
        .from('whatsapp_accounts')
        .select('access_token_encrypted')
        .eq('id', queueItem.whatsapp_account_id)
        .single()

      if (account?.access_token_encrypted) {
        const downloaded = await downloadMetaMedia(ctx.mediaId, account.access_token_encrypted)
        if (downloaded) {
          const storagePath = await uploadWhatsAppMediaToStorage({
            tenantId:       ctx.tenantId,
            conversationId: ctx.conversationId,
            messageId:      ctx.messageId,
            buffer:         downloaded.buffer,
            mimeType:       ctx.mediaMimeType ?? downloaded.contentType,
            contentType:    downloaded.contentType,
          })

          if (storagePath) {
            const { error: updateErr } = await supabase
              .from('messages')
              .update({ media_storage_path: storagePath })
              .eq('id', ctx.messageId)
              .eq('tenant_id', ctx.tenantId)

            if (!updateErr) {
              console.log('[processor:media] stored', { messageId: ctx.messageId, storagePath })
            } else {
              console.warn('[processor:media] failed to update media_storage_path', { error: updateErr.message })
            }

            // ── Audio transcription ────────────────────────────────────────────
            if (ctx.mediaType === 'audio') {
              const txResult = await transcribeAudio(
                downloaded.buffer,
                ctx.mediaMimeType ?? downloaded.contentType,
                `voice_${ctx.messageId}`,
              )
              audioTranscriptionStatus = txResult.status

              // Rebuild full metadata — avoids an extra SELECT by reconstructing from ctx
              const updatedMeta: Record<string, unknown> = {
                whatsapp_media_id:    ctx.mediaId,
                mime_type:            ctx.mediaMimeType ?? downloaded.contentType,
                filename:             ctx.mediaFilename,
                sha256:               ctx.mediaSha256,
                original_type:        'audio',
                storage_bucket:       'whatsapp-media',
                transcription_status: txResult.status,
              }

              let newContent: string
              if (txResult.status === 'completed') {
                audioTranscriptionText           = txResult.text
                updatedMeta['transcription_text'] = txResult.text
                newContent = txResult.text
              } else {
                newContent = '[Audio recibido. No se pudo transcribir automáticamente. El equipo puede escucharlo en el CRM.]'
              }

              const { error: txErr } = await supabase
                .from('messages')
                .update({ content: newContent, metadata: updatedMeta as never })
                .eq('id', ctx.messageId)
                .eq('tenant_id', ctx.tenantId)

              if (txErr) {
                console.warn('[processor:audio] failed to update transcription', { error: txErr.message })
              } else {
                console.log('[processor:audio] transcription saved', {
                  status:    txResult.status,
                  messageId: ctx.messageId,
                })
              }
            }
          }
        }
      } else {
        console.warn('[processor:media] no access_token_encrypted for account', { accountId: queueItem.whatsapp_account_id })
      }
    } catch (err) {
      console.warn('[processor:media] non-fatal error', {
        messageId: ctx.messageId,
        mediaType: ctx.mediaType,
        error:     err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── AutoResponder media (Fase 6B) ─────────────────────────────────────────────
  // AutoResponder never gives bytes at webhook time — only a placeholder
  // (see providers/autoresponder/media-parser.ts). buildContext() already
  // created the customer message with a neutral placeholder as its content.
  // Here we just register a pending media event so media-dispatcher.ts can
  // trigger MacroDroid asynchronously.
  //
  // AUDIO defers the AI pipeline entirely (return below) until the real
  // upload + transcription complete — resumeAfterMediaReady() picks up from
  // there, mirroring Meta's own "wait for transcription" behavior above.
  // IMAGE/DOCUMENT do NOT defer — exactly like Meta's existing image/document
  // handling, which already answers immediately using its fixed placeholder
  // text without waiting for any download to finish. The placeholder text
  // plays the identical role for both providers.
  if (ctx.provider === 'autoresponder' && ctx.mediaType && ctx.whatsappAccountId) {
    const { data: existingEvent } = await supabase
      .from('media_events')
      .select('id')
      .eq('message_id', ctx.messageId)
      .maybeSingle()

    if (!existingEvent) {
      await createMediaEvent({
        tenantId:         ctx.tenantId,
        accountId:        ctx.whatsappAccountId,
        conversationId:   ctx.conversationId,
        messageId:        ctx.messageId,
        mediaType:        ctx.mediaType,
        expectedFilename: ctx.mediaFilename,
      })
    }

    if (ctx.mediaType === 'audio') {
      console.log('[processor] AutoResponder audio — AI deferred until transcription', {
        conversationId: ctx.conversationId,
        messageId:      ctx.messageId,
      })
      return
    }
    // image/document: fall through to the normal pipeline below.
  }

  // ── Meta audio: route based on transcription outcome ─────────────────────────
  // (AutoResponder audio never reaches here — it already returned above.)
  if (ctx.mediaType === 'audio' && ctx.provider === 'meta') {
    if (audioTranscriptionStatus === 'completed' && audioTranscriptionText) {
      // Replace the placeholder with the real transcription so the LLM sees it
      ctx.messageText = audioTranscriptionText
      // Fall through to runAIPipeline below
    } else {
      await handleAudioTranscriptionFailure(ctx)
      return
    }
  }

  await runAIPipeline(ctx)
}

// Shared by resumeAfterMediaReady and handleMediaNeverUploaded (Fase 6B.1) —
// both need to reconstruct enough of a MessageContext from an EXISTING
// message/conversation to resume/fall back the AI pipeline, without a fresh
// inbound payload to parse. Extracted so the DB lookups (conversation,
// contact, property) live in exactly one place.
async function resolveConversationContext(
  supabase:       ReturnType<typeof createClient>,
  conversationId: string,
): Promise<{
  conversation:  { id: string; contact_id: string; property_id: string | null; whatsapp_account_id: string | null; lead_context: unknown }
  contactId:     string
  contactPhone:  string
  contactName:   string | null
  propertyTitle: string | null
  propertySlug:  string | null
} | null> {
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, contact_id, lead_context, property_id, whatsapp_account_id')
    .eq('id', conversationId)
    .maybeSingle()

  if (!conversation) return null

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, phone, name')
    .eq('id', conversation.contact_id)
    .maybeSingle()

  let propertyTitle: string | null = null
  let propertySlug:  string | null = null
  if (conversation.property_id) {
    const { data: property } = await supabase
      .from('properties')
      .select('title, slug')
      .eq('id', conversation.property_id)
      .maybeSingle()
    propertyTitle = property?.title ?? null
    propertySlug  = property?.slug  ?? null
  }

  return {
    conversation,
    contactId:    contact?.id    ?? conversation.contact_id,
    contactPhone: contact?.phone ?? '',
    contactName:  contact?.name  ?? null,
    propertyTitle,
    propertySlug,
  }
}

// ── Fase 6B: resume the AI pipeline for AutoResponder audio once its real
//    upload has arrived ──────────────────────────────────────────────────────
// Called from media-dispatcher.ts's poll tick for media_events rows with
// status='uploaded' AND media_type='audio' (image/document never reach
// 'uploaded' via this path — the upload endpoint marks them 'ready' directly
// since their AI reply was already sent synchronously in processMessage()).
//
// Idempotent: atomically claims the event (uploaded → processing) before
// doing any work, so a duplicate/retried call for the same event_id is a
// harmless no-op (Fase 6B report §15) — separate from, and in addition to,
// runAIPipeline's own dedupe-by-whatsappMessageId guard below.
export async function resumeAfterMediaReady(mediaEventId: string): Promise<void> {
  const supabase = createClient()

  const { data: claimed } = await supabase
    .from('media_events')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', mediaEventId)
    .eq('status', 'uploaded')
    .eq('media_type', 'audio')
    .select('*')
    .maybeSingle()

  if (!claimed) {
    // Already claimed by a concurrent/duplicate call, already terminal, or
    // not an audio event — nothing to do.
    return
  }

  const { data: message } = await supabase
    .from('messages')
    .select('id, tenant_id, conversation_id, metadata, media_storage_path, whatsapp_message_id')
    .eq('id', claimed.message_id)
    .maybeSingle()

  if (!message || !message.media_storage_path) {
    await supabase
      .from('media_events')
      .update({ status: 'failed', error: 'message_or_storage_path_missing', updated_at: new Date().toISOString() })
      .eq('id', mediaEventId)
    console.error('[processor:media] resumeAfterMediaReady: message or storage path missing', { eventId: mediaEventId })
    return
  }

  const resolved = await resolveConversationContext(supabase, claimed.conversation_id)
  if (!resolved) {
    await supabase
      .from('media_events')
      .update({ status: 'failed', error: 'conversation_missing', updated_at: new Date().toISOString() })
      .eq('id', mediaEventId)
    console.error('[processor:media] resumeAfterMediaReady: conversation missing', { eventId: mediaEventId })
    return
  }
  const { conversation, contactId, contactPhone, contactName, propertyTitle, propertySlug } = resolved

  const { data: fileBlob, error: downloadErr } = await supabase.storage
    .from('whatsapp-media')
    .download(message.media_storage_path)

  const meta      = (message.metadata as Record<string, unknown> | null) ?? {}
  const mimeType  = typeof meta['mime_type'] === 'string' ? meta['mime_type'] : 'audio/ogg'

  let txResult: Awaited<ReturnType<typeof transcribeAudio>>
  if (downloadErr || !fileBlob) {
    console.error('[processor:media] failed to download stored audio for transcription', {
      eventId: mediaEventId, error: downloadErr?.message,
    })
    txResult = { status: 'failed', error: 'storage_download_failed' }
  } else {
    const buffer = Buffer.from(await fileBlob.arrayBuffer())
    txResult = await transcribeAudio(buffer, mimeType, `autoresponder_${message.id}`)
  }

  const updatedMeta: Record<string, unknown> = { ...meta, transcription_status: txResult.status }
  let newContent: string
  if (txResult.status === 'completed') {
    newContent = txResult.text
    updatedMeta['transcription_text'] = txResult.text
  } else {
    newContent = '[Audio recibido. No se pudo transcribir automáticamente. El equipo puede escucharlo en el CRM.]'
  }

  await supabase
    .from('messages')
    .update({ content: newContent, metadata: updatedMeta as never })
    .eq('id', message.id)
    .eq('tenant_id', message.tenant_id)

  // Terminal 'ready' regardless of transcription outcome — the audio file
  // itself is safely stored and playable either way (Fase 6B report §10/§15).
  await supabase
    .from('media_events')
    .update({ status: 'ready', updated_at: new Date().toISOString() })
    .eq('id', mediaEventId)

  console.log('[processor:media] AutoResponder audio transcription resolved', {
    eventId: mediaEventId, messageId: message.id, status: txResult.status,
  })

  const ctx: MessageContext = {
    tenantId:             message.tenant_id,
    conversationId:       conversation.id,
    contactId,
    contactPhone,
    contactName,
    messageText:          newContent,
    whatsappMessageId:    message.whatsapp_message_id ?? mediaEventId,
    whatsappAccountId:    conversation.whatsapp_account_id,
    provider:             'autoresponder',
    messageId:            message.id,
    mediaType:            'audio',
    mediaId:              null,
    mediaMimeType:        mimeType,
    mediaFilename:        null,
    mediaCaption:         null,
    mediaSha256:          null,
    mediaDurationSeconds: null,
    mediaPages:           null,
    propertyId:           conversation.property_id,
    propertyTitle,
    propertySlug,
    // Known, documented limitation (Fase 6B report §12/riesgos): lead-context
    // extraction (property Ref / date parsing) does NOT re-run against the
    // transcription text — only against typed messages, via builder.ts, at
    // inbound time. The transcription still reaches DeepSeek as full semantic
    // content; only the deterministic Ref/date regex pass is skipped here.
    leadContext: (conversation.lead_context as LeadContext | null) ?? {},
  }

  if (txResult.status === 'completed') {
    await runAIPipeline(ctx)
  } else {
    await handleAudioTranscriptionFailure(ctx)
  }
}

// ── Fase 6B.1: audio that was dispatched to MacroDroid but NEVER received an
//    upload (Android offline, app killed, no matching file, etc.) ───────────
// Found during Fase 6B.1's audit: before this, a stuck-and-recovered audio
// event (media-dispatcher.ts's recoverStuckMediaEvents, marks it 'failed'
// after ~5 minutes) left the customer with pure silence — no automated
// reply at all, unlike a received-but-untranscribable audio (which already
// got handleAudioTranscriptionFailure's apology). Called from
// recoverStuckMediaEvents for stuck AUDIO events specifically — image/
// document already sent their AI reply immediately when the placeholder
// first arrived (see processMessage), so they have no equivalent silence gap
// to close; only their real file may end up missing from the CRM, a lesser,
// already-accepted gap.
export async function handleMediaNeverUploaded(messageId: string, conversationId: string): Promise<void> {
  const supabase = createClient()

  const { data: message } = await supabase
    .from('messages')
    .select('id, tenant_id, whatsapp_message_id')
    .eq('id', messageId)
    .maybeSingle()

  if (!message) {
    console.error('[processor:media] handleMediaNeverUploaded: message missing', { messageId })
    return
  }

  const resolved = await resolveConversationContext(supabase, conversationId)
  if (!resolved) {
    console.error('[processor:media] handleMediaNeverUploaded: conversation missing', { conversationId })
    return
  }
  const { conversation, contactId, contactPhone, contactName, propertyTitle, propertySlug } = resolved

  const ctx: MessageContext = {
    tenantId:             message.tenant_id,
    conversationId:       conversation.id,
    contactId,
    contactPhone,
    contactName,
    messageText:          AUDIO_NEVER_UPLOADED_TEXT,
    whatsappMessageId:    message.whatsapp_message_id ?? messageId,
    whatsappAccountId:    conversation.whatsapp_account_id,
    provider:             'autoresponder',
    messageId:            message.id,
    mediaType:            'audio',
    mediaId:              null,
    mediaMimeType:        null,
    mediaFilename:        null,
    mediaCaption:         null,
    mediaSha256:          null,
    mediaDurationSeconds: null,
    mediaPages:           null,
    propertyId:           conversation.property_id,
    propertyTitle,
    propertySlug,
    leadContext: (conversation.lead_context as LeadContext | null) ?? {},
  }

  await sendFixedAudioFallbackAndEscalate(ctx, AUDIO_NEVER_UPLOADED_TEXT, 'audio_never_uploaded')
}

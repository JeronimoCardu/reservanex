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
import { decideAutoResponderDelivery } from './providers/autoresponder/delivery-decision'

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

// Decides delivery AND persistence together for one AI reply — this is the
// single point that enforces the Fase 1B hard rule: for provider='meta',
// completely unchanged (synchronous Graph API call, see whatsapp/sender.ts,
// untouched — it already looks up the account by ctx.whatsappAccountId on
// its own). For provider='autoresponder', messaging_outbox/MacroDroid is NO
// LONGER a delivery mechanism under ANY condition — not as an outbound
// path, not as a fallback, not as a retry, not for a late/timed-out reply.
// The ONLY way an AutoResponder reply reaches the customer is a live sync
// HTTP call still within its deadline (ctx.syncReply — see
// decideAutoResponderDelivery). If that isn't available, the reply is
// generated but DROPPED: never enqueued anywhere, and — crucially — never
// persisted via writeMemory() either, so a reply the customer never
// received can never show up as "already sent" in the conversation history
// DeepSeek reads on the next turn (see delivery-decision.ts's doc comment
// and the Fase 1B report §E for the "ghost message" problem this avoids).
async function deliverAIReply(
  ctx:    MessageContext,
  result: LLMResult,
): Promise<{ aiMessageId: string | null; dispatch: string }> {
  const provider = await resolveDispatchProvider(ctx)

  if (provider === 'autoresponder') {
    const syncReply = ctx.syncReply
    const decision  = decideAutoResponderDelivery(syncReply, Date.now())

    if (!decision.deliver || !syncReply) {
      console.warn('[processor] AutoResponder reply generated but NOT delivered — MacroDroid/messaging_outbox is disabled for this version', {
        conversationId: ctx.conversationId,
        reason:         decision.deliver ? 'no_sync_context' : decision.reason,
      })
      return { aiMessageId: null, dispatch: `not_delivered:${decision.deliver ? 'no_sync_context' : decision.reason}` }
    }

    const { aiMessageId } = await writeMemory(ctx, result)
    syncReply.captured = result.text
    return { aiMessageId, dispatch: 'sync:captured' }
  }

  const { aiMessageId } = await writeMemory(ctx, result)
  const outboundWamid = await sendWhatsAppReply(ctx, result.text)
  if (outboundWamid) {
    await updateAiMessageWamid(ctx.tenantId, aiMessageId, outboundWamid)
  }
  return { aiMessageId, dispatch: outboundWamid ?? 'not sent' }
}

// Fixed handoff message sent as the last AI response when the cycle limit is reached.
// Must not mention: IA, Meta, WhatsApp, limits, costs, or plan.
const AI_HANDOFF_MESSAGE =
  'Para seguir ayudándote bien, voy a pasar esta conversación a una persona de la inmobiliaria.\n\n' +
  'En breve alguien del equipo te responde por acá.'

const AUDIO_TRANSCRIPTION_FAILED_TEXT =
  'Recibí tu audio, pero no pude transcribirlo automáticamente. Un asesor lo va a revisar.'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

// Sends the fixed "couldn't transcribe" apology and escalates to a human.
// Never calls the LLM: the apology text is deterministic, matching the
// existing "no inventar contenido" rule for a failed transcription.
//
// Fase 2A: now reached ONLY from Meta's audio path
// (handleAudioTranscriptionFailure below). Its former second caller —
// AutoResponder's "audio never uploaded by MacroDroid" recovery — was
// deleted along with that transport.
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
  await deliverAIReply(ctx, fixedResult)

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

// Fase 1B — AutoResponder audio/image/document with no MacroDroid to fetch
// real bytes: answer immediately and honestly instead of silently depending
// on a mechanism this version doesn't have (see the doc comment at
// processMessage's AutoResponder-media block). Never calls the LLM — same
// "no inventar, respuesta determinística" rule as the audio-failure texts
// above. Explicit per-type wording so the customer always knows exactly
// what to do next (write it as text).
const AUTORESPONDER_MEDIA_NOT_SUPPORTED_TEXT: Record<'audio' | 'image' | 'document', string> = {
  audio:    'Por el momento no puedo procesar audios. ¿Podés escribirme el mensaje en texto?',
  image:    'Por el momento no puedo procesar imágenes. ¿Podés contarme en texto qué necesitás?',
  document: 'Por el momento no puedo procesar documentos. ¿Podés contarme en texto qué necesitás?',
}

async function respondMediaNotSupported(
  ctx:       MessageContext,
  mediaType: 'audio' | 'image' | 'document',
): Promise<void> {
  const supabase = createClient()
  const { data: conv } = await supabase
    .from('conversations')
    .select('ai_mode')
    .eq('id', ctx.conversationId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (conv && conv.ai_mode !== 'autonomous') {
    console.log('[processor:media] skipping fixed media-not-supported reply — manual mode', {
      conversationId: ctx.conversationId, mediaType,
    })
    return
  }

  const text   = AUTORESPONDER_MEDIA_NOT_SUPPORTED_TEXT[mediaType]
  const result: LLMResult = { text, finishReason: 'media_not_supported', model: 'system' }
  const { aiMessageId, dispatch } = await deliverAIReply(ctx, result)

  console.log('[processor:media] AutoResponder media not supported — fixed reply', {
    conversationId: ctx.conversationId, mediaType, aiMessageId, dispatch,
  })
}

// Dedupe guard → AI slot claim → generateAIReply → dispatch. Every caller
// now reaches this synchronously, with ctx.messageText already final (text
// for AutoResponder, text or a transcribed/placeholder body for Meta) —
// Fase 2A removed the one asynchronous caller (AutoResponder audio resumed
// after a MacroDroid upload).
async function runAIPipeline(ctx: MessageContext, signal?: AbortSignal): Promise<void> {
  const supabase = createClient()

  // ── Dedupe guard ────────────────────────────────────────────────────────────
  // Before calling the LLM, check whether we already have an AI reply for this
  // exact inbound wamid. This covers two scenarios:
  //   1. Meta retried the same webhook POST → same wamid enqueued twice
  //   2. message_queue has a duplicate row for the same payload
  // The DB-level unique index (messages_one_ai_reply_per_inbound_idx) is the
  // authoritative guard; this application-level check avoids an unnecessary
  // LLM call when the duplicate is detected early.
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

      const { aiMessageId, dispatch: dispatchInfo } = await deliverAIReply(ctx, handoffResult)

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

  const result = await generateAIReply(ctx, { signal })

  if (result) {
    const { aiMessageId, dispatch: dispatchInfo } = await deliverAIReply(ctx, result)

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

// Fase 1B (AutoResponder sin MacroDroid, definitivo) — when syncOptions is
// passed, processMessage runs exactly the same pipeline as the async
// poller, but attaches ctx.syncReply so deliverAIReply() (above) captures
// the generated text instead of ever touching messaging_outbox, and returns
// that text to the caller — see internal-server.ts, the synchronous
// endpoint that backs POST /api/webhooks/autoresponder. Every existing call
// site (poller.ts, validate-autoresponder.ts, demo-flow.ts) omits the
// second argument and keeps getting `void`/no reply text, unchanged.
//
// Also builds an AbortController tied to the SAME deadline, threaded down
// into generateAIReply()/callLLM() — §8 of the Fase 1B spec: propagate the
// timeout into the LLM pipeline where reasonably possible, rather than
// relying solely on the outer race in internal-server.ts. Not every step
// (tool DB calls between LLM turns) is abortable this way; deliverAIReply's
// deadline check is the actual, unconditional guarantee that a late result
// is never delivered/persisted/enqueued — the abort is purely a latency/
// waste-reduction improvement on top of that guarantee, not a substitute.
export interface ProcessMessageSyncOptions {
  timeoutMs: number
}
export interface ProcessMessageSyncResult {
  replyText: string | null
}

export async function processMessage(
  queueItem:    QueueRow,
  syncOptions?: ProcessMessageSyncOptions,
): Promise<ProcessMessageSyncResult | void> {
  console.log('[processor] processing', queueItem.id)

  const ctx     = await buildContext(queueItem)
  const supabase = createClient()

  let abortSignal: AbortSignal | undefined
  if (syncOptions) {
    ctx.syncReply = { deadlineAtMs: Date.now() + syncOptions.timeoutMs, captured: null }
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('autoresponder_sync_budget_exceeded')), syncOptions.timeoutMs)
    abortSignal = controller.signal
  }
  const finish = (): ProcessMessageSyncResult | void =>
    syncOptions ? { replyText: ctx.syncReply?.captured ?? null } : undefined

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

  // ── AutoResponder media (Fase 1B — sin MacroDroid) ────────────────────────────
  // AutoResponder's "Web Server" trigger never gives real bytes at webhook
  // time — only a placeholder (see providers/autoresponder/media-parser.ts).
  // The ONLY mechanism this codebase ever had to fetch real bytes was the
  // MacroDroid media-extraction trigger (media_events → media-dispatcher.ts
  // → the deleted media trigger) — no longer part of any active flow
  // in this version (see Fase 1B report §F). Creating a media_events row
  // here would silently reintroduce that dependency. Instead: answer
  // immediately and honestly, through the exact same delivery path as any
  // other reply — no media_events, no deferring, no MacroDroid. The
  // customer's inbound message itself is still persisted normally by
  // buildContext() above (with its placeholder content) for CRM/audit
  // visibility; only the real file extraction is the capability we don't
  // have without MacroDroid.
  if (ctx.provider === 'autoresponder' && ctx.mediaType) {
    await respondMediaNotSupported(ctx, ctx.mediaType)
    return finish()
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
      return finish()
    }
  }

  try {
    await runAIPipeline(ctx, abortSignal)
  } catch (err) {
    // Fase 1B — the sync budget's own AbortController (above) rejects
    // callLLM mid-flight once the deadline passes. That is NOT a genuine
    // processing failure — deliverAIReply would have refused to deliver
    // this reply anyway (decideAutoResponderDelivery, deadline already
    // exceeded). Left uncaught, this rejection would propagate out of
    // processMessage() and internal-server.ts would call failQueueItem(),
    // which resets status to 'pending' (attempts<3) — the async poller
    // then picks it up and burns a SECOND real DeepSeek call for a reply
    // that was always going to be dropped. Swallow it here instead: the
    // queue item completes normally, exactly like any other "no reply"
    // outcome (manual mode, etc.) — no retry, no wasted LLM call. A
    // genuine unrelated error (not caused by our own abort) still
    // propagates normally.
    if (abortSignal?.aborted) {
      console.warn('[processor] AI pipeline aborted — sync budget exceeded, no reply to deliver', {
        conversationId: ctx.conversationId,
        error:          err instanceof Error ? err.message : String(err),
      })
    } else {
      throw err
    }
  }
  return finish()
}

// Fase 2A (AUTORESPONDER-ONLY) — resumeAfterMediaReady(),
// handleMediaNeverUploaded() and their shared resolveConversationContext()
// helper were deleted here. All three existed solely to resume the AI
// pipeline after MacroDroid physically extracted an audio file off the
// Android and uploaded it to /api/webhooks/autoresponder/media. That whole
// transport is gone (see media-dispatcher.ts / media_events, both removed):
// AutoResponder media is now answered synchronously by
// respondMediaNotSupported() above, so nothing can ever produce a
// media_events row to resume from. Meta media is unaffected — it gets its
// bytes directly from the Graph API inside processMessage() and never used
// this path.

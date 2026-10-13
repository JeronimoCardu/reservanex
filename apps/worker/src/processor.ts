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
import { runSubmissionFlow } from './submissions/handler'
import {
  decideHumanMode,
  computeHumanUntilIso,
  getHumanHandoffTimeoutMs,
  handoffModeForProvider,
  HUMAN_HANDOFF_MESSAGE,
} from './lib/human-handoff'

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

// Fase 2B — the auto-reply-limit handoff now uses the single shared
// HUMAN_HANDOFF_MESSAGE (lib/human-handoff.ts) like every other handoff
// path, so the customer always hears the same sentence before silence.

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

  // Fase 2B §8 — escalate FIRST, then deliver. This text promises "un asesor
  // lo va a revisar"; if the escalation update failed after the customer
  // already read that, the AI would keep answering over the human. Silence
  // after a failed delivery is the recoverable direction.
  await executeEscalateToHuman(
    ctx.tenantId, ctx.conversationId, 'human_requested', handoffModeForProvider(ctx.provider),
  ).catch((escalErr: unknown) => {
    console.warn('[processor:audio] escalation update failed (non-fatal)', {
      conversationId: ctx.conversationId,
      error:          escalErr instanceof Error ? escalErr.message : String(escalErr),
    })
  })

  const fixedResult: LLMResult = { text, finishReason, model: 'system' }
  await deliverAIReply(ctx, fixedResult)
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

// Has this exact inbound already been answered by an AI message?
//
// The DB-level unique index (messages_one_ai_reply_per_inbound_idx) is the
// authoritative guard; this application-level check avoids doing the work
// twice when the duplicate is detected early. Two scenarios it covers:
//   1. Meta retried the same webhook POST → same wamid enqueued twice
//   2. message_queue has a duplicate row for the same payload
//
// Fase 3B — shared by runAIPipeline() and the submission flow. A retried
// inbound carrying "SUB-X72K91" or "sí" must not send the summary twice nor
// run the confirmation transition twice (§24).
async function alreadyAnsweredInbound(ctx: MessageContext): Promise<{ id: string } | null> {
  const supabase = createClient()
  const { data } = await supabase
    .from('messages')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('sender_type', 'ai')
    .filter('metadata->>in_reply_to_whatsapp_message_id', 'eq', ctx.whatsappMessageId)
    .maybeSingle()
  return data ?? null
}

// Dedupe guard → AI slot claim → generateAIReply → dispatch. Every caller
// now reaches this synchronously, with ctx.messageText already final (text
// for AutoResponder, text or a transcribed/placeholder body for Meta) —
// Fase 2A removed the one asynchronous caller (AutoResponder audio resumed
// after a MacroDroid upload).
async function runAIPipeline(ctx: MessageContext, signal?: AbortSignal): Promise<void> {
  const supabase = createClient()

  // ── Dedupe guard ────────────────────────────────────────────────────────────
  // See alreadyAnsweredInbound() — shared with the Fase 3B submission flow so
  // both deterministic and LLM replies get the same idempotency guarantee.
  const existingReply = await alreadyAnsweredInbound(ctx)

  if (existingReply) {
    console.log('[processor] duplicate inbound already answered — skipping', {
      inboundWhatsAppMessageId: ctx.whatsappMessageId,
      conversationId:           ctx.conversationId,
      aiMessageId:              existingReply.id,
      duplicateSkipped:         true,
    })
    return
  }

  // ── AI auto-reply slot: sesión de 8 h + fusible (MVP P0-A) ────────────────────
  // La RPC, con la conversación bloqueada, decide todo junto:
  //   · inbound >= 8 h después del último inbound que pasó por acá → sesión
  //     nueva (contador a 1, 'claimed', session_reset);
  //   · contador < límite → 'claimed' (respuestas 1..límite son normales);
  //   · contador == límite → 'fuse_tripped': ESTE es el intento siguiente a la
  //     última respuesta permitida. La RPC ya dejó la conversación en HUMAN
  //     (estado ANTES del mensaje: Fase 2B §8) y se lo devuelve a un solo
  //     llamador; cualquier concurrente ve 'not_autonomous';
  //   · no autónoma / inexistente → silencio.
  // El bot desactivado nunca llega hasta acá (processMessage corta antes).
  const fuseHumanUntil = handoffModeForProvider(ctx.provider) === 'temporary'
    ? computeHumanUntilIso(Date.now(), getHumanHandoffTimeoutMs())
    : null
  const { data: slotRows, error: slotErr } = await supabase
    .rpc('claim_ai_auto_reply_slot', {
      p_conversation_id:    ctx.conversationId,
      p_tenant_id:          ctx.tenantId,
      p_inbound_message_id: ctx.messageId,
      p_human_until:        fuseHumanUntil ?? undefined,
    })

  if (slotErr) {
    // RPC failure is non-fatal — log and fall through to generateAIReply which
    // will do its own ai_mode check. Worst case: one extra reply beyond the limit.
    console.error('[processor:slot] claim_ai_auto_reply_slot failed (non-fatal)', {
      conversationId: ctx.conversationId,
      error:          slotErr.message,
    })
  } else {
    const slot = slotRows?.[0]

    if (slot?.outcome === 'fuse_tripped') {
      // Deterministic — no LLM. The HUMAN state is already committed.
      const handoffResult: LLMResult = {
        text:             HUMAN_HANDOFF_MESSAGE,
        finishReason:     'auto_reply_limit',
        model:            'system',
        handoffRequested: true,
      }
      const { aiMessageId, dispatch: dispatchInfo } = await deliverAIReply(ctx, handoffResult)

      console.log('[processor:slot] fusible — mensaje de handoff', {
        conversationId: ctx.conversationId,
        count:          slot.new_count,
        limit:          slot.reply_limit,
        aiMessageId,
        dispatch:       dispatchInfo,
      })
      return
    }

    if (slot?.outcome !== 'claimed') {
      console.log('[processor:slot] sin slot — sin respuesta', {
        conversationId: ctx.conversationId,
        outcome:        slot?.outcome ?? 'no_row',
      })
      return
    }

    console.log('[processor:slot] slot claimed', {
      conversationId: ctx.conversationId,
      count:          slot.new_count,
      limit:          slot.reply_limit,
      sessionReset:   slot.session_reset,
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

// ── Fase 2B: the HUMAN handoff gate ─────────────────────────────────────────
// Decides, for ONE inbound, whether the AI may answer at all.
//
//   human_active     → slide the window, stay silent (no LLM, no AI message)
//   human_expired    → atomically hand the conversation back to the AI,
//                      stamp the context boundary, and let THIS SAME inbound
//                      be answered (§10 — the customer must not have to send
//                      a second message)
//   ai               → nothing to do
//   manual_no_expiry → a human took the conversation over from the CRM;
//                      stays silent until someone reactivates the AI there
//
// Returns 'silent' when the caller must stop and answer {"replies": []}.
//
// Provider-agnostic by design: AI/HUMAN semantics live on the conversation,
// so Meta gets the same gate. Only the transport of the eventual reply
// differs, and that is decided later in deliverAIReply() — Meta is NOT
// adapted to the replies[] contract (§20).
async function applyHumanHandoffGate(ctx: MessageContext): Promise<'silent' | 'continue'> {
  const supabase = createClient()

  const { data: conv, error } = await supabase
    .from('conversations')
    .select('ai_mode, human_until')
    .eq('id', ctx.conversationId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (error || !conv) {
    // Cannot read the state. Continue rather than silencing the conversation
    // forever on a transient read error: generateAIReply() does its own
    // independent ai_mode check before spending a token, so a genuinely
    // non-autonomous conversation still stays silent one layer down.
    console.warn('[processor:handoff] could not read conversation state — continuing', {
      conversationId: ctx.conversationId,
      error:          error?.message,
    })
    return 'continue'
  }

  const nowMs    = Date.now()
  const decision = decideHumanMode({ ai_mode: conv.ai_mode, human_until: conv.human_until }, nowMs)

  if (decision.mode === 'ai') return 'continue'

  if (decision.mode === 'manual_no_expiry') {
    console.log('[processor:handoff] conversation is manual with no expiry — staying silent', {
      conversationId: ctx.conversationId,
    })
    return 'silent'
  }

  if (decision.mode === 'human_active') {
    // Sliding window: every customer inbound pushes the expiry out again,
    // measured from THIS message (§2).
    const nextUntil = computeHumanUntilIso(nowMs, getHumanHandoffTimeoutMs())
    const { error: extendErr } = await supabase
      .from('conversations')
      .update({ human_until: nextUntil, updated_at: new Date(nowMs).toISOString() })
      .eq('id', ctx.conversationId)
      .eq('tenant_id', ctx.tenantId)

    if (extendErr) {
      // Non-fatal: the window just doesn't slide this time. Staying silent is
      // still the correct, fail-safe outcome (§8).
      console.warn('[processor:handoff] could not extend the HUMAN window (non-fatal)', {
        conversationId: ctx.conversationId,
        error:          extendErr.message,
      })
    }

    console.log('[processor:handoff] HUMAN active — inbound persisted, staying silent', {
      conversationId: ctx.conversationId,
      humanUntil:     nextUntil,
    })
    return 'silent'
  }

  // decision.mode === 'human_expired' — hand back to the AI.
  //
  // The guard clauses make this transition atomic: only the request whose
  // UPDATE still matches (non-autonomous, and holding the SAME expired
  // human_until we just read) performs the reactivation. A second inbound
  // racing on the same expiry matches zero rows and simply proceeds — it
  // cannot reset the context a second time (§14 C).
  //
  // ai_context_reset_at is stamped with the INBOUND MESSAGE's own created_at,
  // not now(): buildContext() already inserted that row, so stamping now()
  // would put the boundary AFTER it and the very message that reactivated
  // the AI would be excluded from its own context (§22 F).
  const { data: inboundMsg } = await supabase
    .from('messages')
    .select('created_at')
    .eq('id', ctx.messageId)
    .maybeSingle()

  const resetAt = inboundMsg?.created_at ?? new Date(nowMs).toISOString()

  // decideHumanMode only returns 'human_expired' when human_until was a
  // parseable non-null timestamp, so this narrowing is sound — it exists to
  // let the race guard below compare against that exact value.
  const expiredUntil = conv.human_until ?? ''

  const { data: reactivated } = await supabase
    .from('conversations')
    .update({
      ai_mode:                'autonomous',
      human_until:            null,
      ai_context_reset_at:    resetAt,
      needs_human_attention:  false,
      ai_auto_replies_count:  0,
      ai_handoff_reason:      null,
      ai_handoff_at:          null,
      updated_at:             new Date(nowMs).toISOString(),
    })
    .eq('id', ctx.conversationId)
    .eq('tenant_id', ctx.tenantId)
    .neq('ai_mode', 'autonomous')
    .eq('human_until', expiredUntil)
    .select('id')

  console.log('[processor:handoff] HUMAN window expired — AI reactivated for this inbound', {
    conversationId: ctx.conversationId,
    contextResetAt: resetAt,
    wonRace:        (reactivated?.length ?? 0) > 0,
  })

  return 'continue'
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
/**
 * `reason` explica un silencio que no es "no había nada que decir":
 *   bot_disabled      → el tenant tiene la IA generativa desactivada (ai_settings.active =
 *                       false) y este mensaje sólo podía contestarlo el bot (no era una
 *                       confirmación determinística, que sigue funcionando);
 *   deadline_exceeded → el presupuesto síncrono se agotó: lo que se haya
 *                       generado ya no puede entregarse en este request.
 */
export interface ProcessMessageSyncResult {
  replyText: string | null
  reason?:   'bot_disabled' | 'deadline_exceeded'
}

// MVP P0-A — "Bot activo" del tenant (ai_settings.active), con la misma
// semántica que el responder: sin fila → activo; error de lectura → activo
// (el responder vuelve a mirar antes de gastar un token, como siempre).
async function isBotEnabled(ctx: MessageContext): Promise<boolean> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('ai_settings')
    .select('active')
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (error) {
    console.warn('[processor] could not read ai_settings.active — treating as enabled', {
      tenantId: ctx.tenantId,
      error:    error.message,
    })
    return true
  }
  return !data || data.active !== false
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
  const finish = (reason?: ProcessMessageSyncResult['reason']): ProcessMessageSyncResult | void => {
    if (!syncOptions) return undefined
    const replyText = ctx.syncReply?.captured ?? null
    const deadlineExceeded = replyText === null && ctx.syncReply !== undefined && Date.now() >= ctx.syncReply.deadlineAtMs
    return { replyText, reason: reason ?? (deadlineExceeded ? 'deadline_exceeded' : undefined) }
  }

  // ── Fase 2B: HUMAN handoff gate ─────────────────────────────────────────────
  // Runs BEFORE any media handling on purpose (§18): while a human is
  // attending from WhatsApp Web, an audio/image/document must produce plain
  // silence, NOT the "send it as text" fallback — the customer is talking to
  // a person, who can see the media in WhatsApp themselves. Returning here
  // also means no LLM call, no tokens, no AI message row (§9).
  const humanGate = await applyHumanHandoffGate(ctx)
  if (humanGate === 'silent') return finish()

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

  // ── MVP P0-A.1: "Bot desactivado" = IA generativa desactivada ────────────────
  // NO es "ReservaNex en silencio": las confirmaciones determinísticas de
  // formularios y pedidos (SUB-…) son parte de una operación del negocio y
  // siguen funcionando con el bot apagado, sin slot ni contador.
  //
  // Lo que se calla con el bot apagado es todo lo que habla COMO el bot: la
  // respuesta fija de media no soportada, el aviso de audio sin transcribir
  // (Meta) y el pipeline de IA —con su slot, su contador y su fusible—. El
  // chequeo se hace justo antes de cada una de esas respuestas, nunca antes de
  // la puerta HUMAN (su precedencia no cambia) ni de los handlers
  // determinísticos. Una sola lectura de ai_settings por mensaje, y sólo si
  // hace falta: un mensaje que resuelve una confirmación no la lee.
  let botEnabledRead: Promise<boolean> | null = null
  const botDisabled = async (): Promise<boolean> => !(await (botEnabledRead ??= isBotEnabled(ctx)))
  const silentBecauseBotDisabled = () => {
    console.log('[processor] bot desactivado (IA generativa) — el bot no responde este mensaje', {
      conversationId: ctx.conversationId,
      tenantId:       ctx.tenantId,
    })
    return finish('bot_disabled')
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
    // Habla como el bot ("no puedo procesar audios"): con el bot apagado, la
    // persona que atiende WhatsApp ve el archivo ella misma.
    if (await botDisabled()) return silentBecauseBotDisabled()
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
      if (await botDisabled()) return silentBecauseBotDisabled()
      await handleAudioTranscriptionFailure(ctx)
      return finish()
    }
  }

  // ── Fase 3B: formulario → WhatsApp → confirmación ───────────────────────────
  // Corre DESPUÉS del gate de HUMAN (§5): mientras una persona atiende desde
  // WhatsApp Web nunca se llega hasta acá, así que una referencia mandada en
  // ese momento no toca la submission ni rompe el silencio de la Fase 2B.
  //
  // Corre ANTES de runAIPipeline y, si contesta, la IA no se llama en absoluto
  // (§12): el resumen y la confirmación son determinísticos, así que no hay
  // tokens gastados ni margen para que el modelo altere los datos (§10).
  //
  // Si no hay referencia ni confirmación pendiente devuelve 'skip' y el
  // pipeline normal sigue exactamente igual que antes (§21).
  const submissionFlow = await runSubmissionFlow(ctx)
  if (submissionFlow.kind === 'reply') {
    // Mismo guard de idempotencia que usa el camino con LLM (§24).
    const duplicate = await alreadyAnsweredInbound(ctx)
    if (duplicate) {
      console.log('[processor:submissions] inbound duplicado ya respondido — se omite', {
        inboundWhatsAppMessageId: ctx.whatsappMessageId,
        conversationId:           ctx.conversationId,
        aiMessageId:              duplicate.id,
      })
      return finish()
    }

    // Se entrega por el MISMO camino que cualquier otra respuesta:
    // deliverAIReply decide transporte y persistencia juntos, así que esto
    // hereda la garantía de que nunca se persiste un mensaje que el cliente
    // no recibió, y jamás toca messaging_outbox (§12).
    const deterministic: LLMResult = {
      text:         submissionFlow.text,
      finishReason: 'stop',
      // Marcado explícito: en auditoría queda claro que este texto no lo
      // generó un modelo.
      model:        'deterministic/submission-confirmation',
    }
    const { aiMessageId, dispatch } = await deliverAIReply(ctx, deterministic)
    console.log('[processor:submissions] respuesta determinística entregada', {
      conversationId: ctx.conversationId, aiMessageId, dispatch,
    })
    return finish()
  }

  // Mensaje libre: sólo la IA podría contestarlo. Con el bot apagado no se
  // entra al pipeline — sin slot, sin contador, sin fusible, sin Atención
  // Humana por límite.
  if (await botDisabled()) return silentBecauseBotDisabled()

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

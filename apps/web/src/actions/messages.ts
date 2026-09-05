'use server'

import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { sendMessageSchema } from '@orderflow/validators'
import * as convRepo from '@/lib/repositories/conversations.repository'
import * as msgRepo from '@/lib/repositories/messages.repository'
import { createAdminClient } from '@orderflow/supabase/admin'
import type { ActionResult } from '@/lib/action-result'

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'
const DEV        = process.env.NODE_ENV === 'development'

type AdminClient = ReturnType<typeof createAdminClient>

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/aac',
  'audio/wav', 'audio/webm', 'audio/x-m4a',
]
const MAX_IMAGE_BYTES    = 5  * 1024 * 1024   //  5 MB
const MAX_AUDIO_BYTES    = 16 * 1024 * 1024   // 16 MB
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024   // 16 MB

const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'application/csv',
]

// ─── Send text message (human agent) ─────────────────────────────────────────

export async function sendMessageAction(
  conversationId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const conversation = await convRepo.getConversationById(
    ctx.tenantId,
    conversationId,
  )
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  if (conversation.status === 'closed') {
    return { success: false, error: 'No podés enviar mensajes a una conversación cerrada.' }
  }

  const parsed = sendMessageSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  try {
    const message = await msgRepo.createMessage(ctx.tenantId, conversationId, {
      content:      parsed.data.content,
      content_type: parsed.data.content_type,
      sender_type:  'human',
      sender_id:    ctx.userId,
    })

    const admin = createAdminClient()

    await updateConversationMode(admin, ctx.tenantId, conversationId, conversation.assigned_user_id, ctx.userId)

    if (conversation.channel === 'whatsapp') {
      await sendViaWhatsApp(
        admin,
        ctx.tenantId,
        conversationId,
        conversation.contact_id,
        message.id,
        parsed.data.content,
        ctx.userId,
      )
    }

    return { success: true, data: { id: message.id } }
  } catch {
    return { success: false, error: 'Error al enviar el mensaje. Intentá de nuevo.' }
  }
}

// ─── Send image message ───────────────────────────────────────────────────────

export async function sendImageMessageAction(
  conversationId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string; mediaStoragePath?: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const conversation = await convRepo.getConversationById(ctx.tenantId, conversationId)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }
  if (conversation.status === 'closed') {
    return { success: false, error: 'No podés enviar mensajes a una conversación cerrada.' }
  }

  const file = formData.get('file')
  if (!(file instanceof File)) return { success: false, error: 'Archivo no válido.' }
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return { success: false, error: 'Tipo de imagen no permitido. Usá JPEG, PNG o WebP.' }
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { success: false, error: 'La imagen no puede superar 5 MB.' }
  }

  const captionRaw = formData.get('caption')
  const caption    = typeof captionRaw === 'string' ? captionRaw.trim() : ''

  const admin = createAdminClient()

  let message: Awaited<ReturnType<typeof msgRepo.createMessage>>
  try {
    message = await msgRepo.createMessage(ctx.tenantId, conversationId, {
      content:      caption,
      content_type: 'image',
      sender_type:  'human',
      sender_id:    ctx.userId,
      metadata: {
        delivery_status: 'sending',
        mime_type:       file.type,
        filename:        file.name,
        ...(caption ? { caption } : {}),
      },
    })
  } catch {
    return { success: false, error: 'Error al guardar el mensaje. Intentá de nuevo.' }
  }

  await updateConversationMode(admin, ctx.tenantId, conversationId, conversation.assigned_user_id, ctx.userId)

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext    = mimeToExt(file.type)
  const storagePath = `${ctx.tenantId}/${conversationId}/${message.id}.${ext}`

  const { error: uploadErr } = await admin.storage
    .from('whatsapp-media')
    .upload(storagePath, buffer, { contentType: file.type, upsert: true })

  if (uploadErr) {
    console.error('[send-image] storage upload failed:', uploadErr.message)
    await markDeliveryFailed(admin, ctx.tenantId, message.id, ctx.userId, 'Storage upload failed', {
      mime_type:     file.type,
      filename:      file.name,
      storage_error: uploadErr.message,
      ...(caption ? { caption } : {}),
    })
    return { success: true, data: { id: message.id } }
  }

  await admin
    .from('messages')
    .update({ media_storage_path: storagePath })
    .eq('id', message.id)
    .eq('tenant_id', ctx.tenantId)

  if (conversation.channel === 'whatsapp') {
    await sendMediaViaWhatsApp({
      admin,
      tenantId:   ctx.tenantId,
      contactId:  conversation.contact_id,
      messageId:  message.id,
      buffer,
      mimeType:   file.type,
      filename:   file.name,
      mediaType:  'image',
      caption:    caption || null,
      userId:     ctx.userId,
    })
  }

  return { success: true, data: { id: message.id, mediaStoragePath: storagePath } }
}

// ─── Send audio message ───────────────────────────────────────────────────────
// Voice recording is paused from the UI until browser audio format conversion
// is supported. This action remains available for future use.

export async function sendAudioMessageAction(
  conversationId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const conversation = await convRepo.getConversationById(ctx.tenantId, conversationId)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }
  if (conversation.status === 'closed') {
    return { success: false, error: 'No podés enviar mensajes a una conversación cerrada.' }
  }

  const file = formData.get('file')
  if (!(file instanceof File)) return { success: false, error: 'Archivo no válido.' }
  if (!ALLOWED_AUDIO_TYPES.includes(file.type)) {
    return { success: false, error: 'Tipo de audio no permitido. Usá OGG, MP3, M4A, WAV o WebM.' }
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return { success: false, error: 'El audio no puede superar 16 MB.' }
  }

  if (DEV) {
    console.log('[send-audio] received file:', { type: file.type, size: file.size, name: file.name })
  }

  const admin = createAdminClient()

  let message: Awaited<ReturnType<typeof msgRepo.createMessage>>
  try {
    message = await msgRepo.createMessage(ctx.tenantId, conversationId, {
      content:      '',
      content_type: 'audio',
      sender_type:  'human',
      sender_id:    ctx.userId,
      metadata: {
        delivery_status: 'sending',
        mime_type:       file.type,
        filename:        file.name,
      },
    })
  } catch {
    return { success: false, error: 'Error al guardar el mensaje. Intentá de nuevo.' }
  }

  await updateConversationMode(admin, ctx.tenantId, conversationId, conversation.assigned_user_id, ctx.userId)

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext    = mimeToExt(file.type)
  const storagePath = `${ctx.tenantId}/${conversationId}/${message.id}.${ext}`

  if (DEV) {
    console.log('[send-audio] uploading to storage:', { storagePath, bufferLen: buffer.length })
  }

  // Upload with application/octet-stream so bucket MIME-type policies don't
  // reject audio formats. The media proxy (/api/media/[id]) serves the correct
  // Content-Type from message metadata — it does NOT rely on the storage object's
  // own content-type header.
  const { error: uploadErr } = await admin.storage
    .from('whatsapp-media')
    .upload(storagePath, buffer, { contentType: 'application/octet-stream', upsert: true })

  if (uploadErr) {
    console.error('[send-audio] storage upload failed:', uploadErr.message, { storagePath })
    await markDeliveryFailed(admin, ctx.tenantId, message.id, ctx.userId, `Storage upload failed: ${uploadErr.message}`, {
      mime_type: file.type,
      filename:  file.name,
    })
    return { success: true, data: { id: message.id } }
  }

  if (DEV) console.log('[send-audio] storage upload ok:', storagePath)

  await admin
    .from('messages')
    .update({ media_storage_path: storagePath })
    .eq('id', message.id)
    .eq('tenant_id', ctx.tenantId)

  if (conversation.channel === 'whatsapp') {
    await sendMediaViaWhatsApp({
      admin,
      tenantId:   ctx.tenantId,
      contactId:  conversation.contact_id,
      messageId:  message.id,
      buffer,
      mimeType:   file.type,
      filename:   file.name,
      mediaType:  'audio',
      caption:    null,
      userId:     ctx.userId,
    })
  }

  return { success: true, data: { id: message.id } }
}

// ─── Send document message ────────────────────────────────────────────────────

export async function sendDocumentMessageAction(
  conversationId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string; mediaStoragePath?: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const conversation = await convRepo.getConversationById(ctx.tenantId, conversationId)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }
  if (conversation.status === 'closed') {
    return { success: false, error: 'No podés enviar mensajes a una conversación cerrada.' }
  }

  const file = formData.get('file')
  if (!(file instanceof File)) return { success: false, error: 'Archivo no válido.' }
  if (!ALLOWED_DOCUMENT_TYPES.includes(file.type)) {
    return { success: false, error: 'Tipo de archivo no permitido. Usá PDF, Word, Excel o TXT.' }
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { success: false, error: 'El archivo no puede superar 16 MB.' }
  }

  const captionRaw = formData.get('caption')
  const caption    = typeof captionRaw === 'string' ? captionRaw.trim() : ''

  const admin = createAdminClient()

  let message: Awaited<ReturnType<typeof msgRepo.createMessage>>
  try {
    message = await msgRepo.createMessage(ctx.tenantId, conversationId, {
      content:      caption,
      content_type: 'document',
      sender_type:  'human',
      sender_id:    ctx.userId,
      metadata: {
        delivery_status: 'sending',
        mime_type:       file.type,
        filename:        file.name,
        ...(caption ? { caption } : {}),
      },
    })
  } catch {
    return { success: false, error: 'Error al guardar el mensaje. Intentá de nuevo.' }
  }

  await updateConversationMode(admin, ctx.tenantId, conversationId, conversation.assigned_user_id, ctx.userId)

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext    = mimeToExt(file.type)
  const storagePath = `${ctx.tenantId}/${conversationId}/${message.id}.${ext}`

  if (DEV) {
    console.log('[send-document] uploading to storage:', { storagePath, fileType: file.type, bufferLen: buffer.length })
  }

  // Use the real MIME type — the bucket's allowed_mime_types includes document
  // types after migration 20260813000001_extend_whatsapp_media_mime_types.sql.
  const { error: uploadErr } = await admin.storage
    .from('whatsapp-media')
    .upload(storagePath, buffer, { contentType: file.type, upsert: true })

  if (uploadErr) {
    console.error('[send-document] storage upload failed:', uploadErr.message, { storagePath })
    await markDeliveryFailed(admin, ctx.tenantId, message.id, ctx.userId, `Storage upload failed: ${uploadErr.message}`, {
      mime_type:     file.type,
      filename:      file.name,
      storage_error: uploadErr.message,
      ...(caption ? { caption } : {}),
    })
    return { success: true, data: { id: message.id } }
  }

  if (DEV) console.log('[send-document] storage upload ok:', storagePath)

  await admin
    .from('messages')
    .update({ media_storage_path: storagePath })
    .eq('id', message.id)
    .eq('tenant_id', ctx.tenantId)

  if (conversation.channel === 'whatsapp') {
    await sendMediaViaWhatsApp({
      admin,
      tenantId:   ctx.tenantId,
      contactId:  conversation.contact_id,
      messageId:  message.id,
      buffer,
      mimeType:   file.type,
      filename:   file.name,
      mediaType:  'document',
      caption:    caption || null,
      userId:     ctx.userId,
    })
  }

  return { success: true, data: { id: message.id, mediaStoragePath: storagePath } }
}

// ─── Retry failed human send ───────────────────────────────────────────────

export async function retryMessageAction(messageId: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  const admin = createAdminClient()

  const { data: message } = await admin
    .from('messages')
    .select('id, content, content_type, conversation_id, sender_type, metadata')
    .eq('id', messageId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!message) return { success: false, error: 'Mensaje no encontrado.' }
  if (message.sender_type !== 'human') {
    return { success: false, error: 'Solo se pueden reintentar mensajes de agentes.' }
  }

  const meta = message.metadata as Record<string, unknown> | null
  if (meta?.delivery_status !== 'failed') {
    return { success: false, error: 'El mensaje no está en estado fallido.' }
  }

  // Retry is only supported for text messages.
  // Media messages require re-selecting the file on the client.
  if (message.content_type !== 'text') {
    return { success: false, error: 'El reintento automático no está disponible para mensajes con archivos. Volvé a seleccionar el archivo.' }
  }

  const { data: conv } = await admin
    .from('conversations')
    .select('contact_id, channel')
    .eq('id', message.conversation_id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!conv) return { success: false, error: 'Conversación no encontrada.' }
  if (conv.channel !== 'whatsapp') {
    return { success: false, error: 'Solo WhatsApp soporta reintento de envío.' }
  }

  await sendViaWhatsApp(
    admin,
    ctx.tenantId,
    message.conversation_id,
    conv.contact_id,
    message.id,
    message.content,
    ctx.userId,
  )

  return { success: true }
}

// ─── Shared: update conversation mode ────────────────────────────────────────

async function updateConversationMode(
  admin:            AdminClient,
  tenantId:         string,
  conversationId:   string,
  assignedUserId:   string | null,
  currentUserId:    string,
): Promise<void> {
  const { error } = await admin
    .from('conversations')
    .update(
      assignedUserId === null
        ? {
            ai_mode:               'manual' as const,
            updated_at:            new Date().toISOString(),
            needs_human_attention: false,
            assigned_user_id:      currentUserId,
          }
        : {
            ai_mode:               'manual' as const,
            updated_at:            new Date().toISOString(),
            needs_human_attention: false,
          },
    )
    .eq('id', conversationId)
    .eq('tenant_id', tenantId)

  if (error) {
    console.warn('[send-message] conversation update failed:', error.message)
  }
}

// ─── WhatsApp text delivery ───────────────────────────────────────────────────

interface MetaSendResponse {
  messages?: Array<{ id: string }>
  error?:    { message: string; code?: number }
}

async function sendViaWhatsApp(
  admin:          AdminClient,
  tenantId:       string,
  conversationId: string,
  contactId:      string,
  messageId:      string,
  text:           string,
  userId:         string,
): Promise<void> {
  const { data: contact } = await admin
    .from('contacts')
    .select('phone')
    .eq('id', contactId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!contact?.phone) {
    console.warn('[send-message] contact has no phone — skipping WhatsApp delivery', { contactId })
    await markDeliveryFailed(admin, tenantId, messageId, userId, 'Contact has no phone number')
    return
  }

  // Fase 4.1 §2: a reply to an existing conversation must go out through the
  // SAME account/channel that conversation originated from — never an
  // arbitrarily-picked "tenant's active account" (ambiguous when a tenant has
  // more than one active account, e.g. Meta + AutoResponder simultaneously
  // during a provider migration). conversations.whatsapp_account_id is the
  // canonical account, set by apps/worker/src/context/builder.ts. Only when
  // it is null (a legacy conversation predating that column) do we fall back
  // to the old ambiguous lookup — same approximation used before Fase 4.1,
  // not a regression.
  const { data: conv } = await admin
    .from('conversations')
    .select('whatsapp_account_id')
    .eq('id', conversationId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  const canonicalAccountId = conv?.whatsapp_account_id ?? null

  let account: { id: string; provider: string; phone_number: string; access_token_encrypted: string | null } | null = null

  if (canonicalAccountId) {
    const { data } = await admin
      .from('whatsapp_accounts')
      .select('id, provider, phone_number, access_token_encrypted, active')
      .eq('id', canonicalAccountId)
      .eq('tenant_id', tenantId)
      .maybeSingle()

    if (!data) {
      console.error('[send-message] conversation\'s canonical account no longer exists', { conversationId, canonicalAccountId })
      await markDeliveryFailed(admin, tenantId, messageId, userId, 'Original WhatsApp account for this conversation no longer exists')
      return
    }
    if (!data.active) {
      // Deliberately does NOT fall back to a different active account — that
      // would silently reroute through a different channel/phone number than
      // the one this conversation was built on.
      console.warn('[send-message] conversation\'s canonical account is inactive', { conversationId, canonicalAccountId })
      await markDeliveryFailed(admin, tenantId, messageId, userId, 'Original WhatsApp account for this conversation is inactive')
      return
    }
    account = data
  } else {
    const { data } = await admin
      .from('whatsapp_accounts')
      .select('id, provider, phone_number, access_token_encrypted')
      .eq('tenant_id', tenantId)
      .eq('active', true)
      .limit(1)
      .maybeSingle()
    account = data
  }

  if (!account) {
    console.warn('[send-message] no active WhatsApp account for tenant', { tenantId })
    await markDeliveryFailed(admin, tenantId, messageId, userId, 'No active WhatsApp account configured')
    return
  }

  // Fase 1B (AutoResponder sin MacroDroid, definitivo) — this CRM action can
  // no longer deliver anything for provider=autoresponder: messaging_outbox/
  // MacroDroid is retired from every active flow, and this action has no
  // live synchronous AutoResponder webhook request to answer through (that
  // only exists inside internal-server.ts, mid-request — see processor.ts's
  // deliverAIReply). Human replies for this provider now happen directly in
  // WhatsApp/WhatsApp Web, outside ReservaNex (see Fase 1B report §G) — fail
  // predictably and visibly instead of silently doing nothing or reviving
  // the retired outbox path. Meta is completely unaffected below.
  if (account.provider === 'autoresponder') {
    console.warn('[send-message] manual CRM send is not available for provider=autoresponder', { conversationId })
    await markDeliveryFailed(
      admin, tenantId, messageId, userId,
      'Envío manual no disponible para AutoResponder — respondé directamente desde WhatsApp.',
    )
    return
  }

  if (!account.access_token_encrypted) {
    console.error('[send-message] meta account missing access token', { tenantId })
    await markDeliveryFailed(admin, tenantId, messageId, userId, 'WhatsApp account misconfigured')
    return
  }

  let res: Response
  try {
    res = await fetch(`${GRAPH_BASE}/${account.phone_number}/messages`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${account.access_token_encrypted}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   contact.phone,
        type: 'text',
        text: { body: text },
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[send-message] Meta API network error:', msg)
    await markDeliveryFailed(admin, tenantId, messageId, userId, 'Network error reaching Meta API')
    return
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText)
    console.error('[send-message] Meta API HTTP error', { status: res.status, detail: raw.slice(0, 200) })
    await markDeliveryFailed(admin, tenantId, messageId, userId, `Meta API returned HTTP ${res.status}`)
    return
  }

  const data = await res.json() as MetaSendResponse
  const outboundWamid = data.messages?.[0]?.id ?? null

  if (!outboundWamid) {
    console.warn('[send-message] Meta returned no wamid in response')
    await markDeliveryFailed(admin, tenantId, messageId, userId, 'Meta API returned no message ID')
    return
  }

  const { error: updateError } = await admin
    .from('messages')
    .update({
      whatsapp_message_id: outboundWamid,
      metadata: {
        outbound_whatsapp_message_id: outboundWamid,
        delivery_status: 'sent',
        sent_at:  new Date().toISOString(),
        sent_by:  userId,
      } as never,
    })
    .eq('id', messageId)
    .eq('tenant_id', tenantId)

  if (updateError) {
    console.error('[send-message] failed to store outbound wamid:', updateError.message)
  } else {
    console.log('[send-message] human reply delivered', { outboundWamid })
  }
}

// ─── WhatsApp media delivery ──────────────────────────────────────────────────

interface SendMediaParams {
  admin:     AdminClient
  tenantId:  string
  contactId: string
  messageId: string
  buffer:    Buffer
  mimeType:  string
  filename:  string
  mediaType: 'image' | 'audio' | 'document'
  caption:   string | null
  userId:    string
}

async function sendMediaViaWhatsApp(p: SendMediaParams): Promise<void> {
  const preservedMeta: Record<string, unknown> = {
    mime_type: p.mimeType,
    filename:  p.filename,
    ...(p.caption ? { caption: p.caption } : {}),
  }

  const { data: contact } = await p.admin
    .from('contacts')
    .select('phone')
    .eq('id', p.contactId)
    .eq('tenant_id', p.tenantId)
    .maybeSingle()

  if (!contact?.phone) {
    await markDeliveryFailed(p.admin, p.tenantId, p.messageId, p.userId, 'Contact has no phone number', preservedMeta)
    return
  }

  const { data: account } = await p.admin
    .from('whatsapp_accounts')
    .select('provider, phone_number, access_token_encrypted')
    .eq('tenant_id', p.tenantId)
    .eq('active', true)
    .limit(1)
    .maybeSingle()

  if (!account) {
    await markDeliveryFailed(p.admin, p.tenantId, p.messageId, p.userId, 'No active WhatsApp account', preservedMeta)
    return
  }

  // Media send via AutoResponder/MacroDroid is out of scope for Fase 4 (see
  // report §14) — fail predictably instead of attempting a Meta call with a
  // null token, or silently doing nothing.
  if (account.provider !== 'meta' || !account.access_token_encrypted) {
    await markDeliveryFailed(
      p.admin, p.tenantId, p.messageId, p.userId,
      'Envío de archivos no disponible todavía para este canal', preservedMeta,
    )
    return
  }

  // Step 1: upload file to Meta media endpoint → get media_id
  const metaMediaId = await uploadMediaToMeta(
    account.phone_number,
    account.access_token_encrypted,
    p.buffer,
    p.mimeType,
    p.filename,
  )

  if (!metaMediaId) {
    await markDeliveryFailed(p.admin, p.tenantId, p.messageId, p.userId, 'Meta media upload failed', {
      ...preservedMeta,
      meta_upload_error: 'Upload to Meta media endpoint failed',
    })
    return
  }

  // Step 2: send message referencing the media_id
  const msgBody: Record<string, unknown> =
    p.mediaType === 'image'
      ? {
          messaging_product: 'whatsapp',
          to:    contact.phone,
          type:  'image',
          image: { id: metaMediaId, ...(p.caption ? { caption: p.caption } : {}) },
        }
      : p.mediaType === 'audio'
        ? {
            messaging_product: 'whatsapp',
            to:    contact.phone,
            type:  'audio',
            audio: { id: metaMediaId },
          }
        : {
            messaging_product: 'whatsapp',
            to:       contact.phone,
            type:     'document',
            document: {
              id:       metaMediaId,
              filename: p.filename,
              ...(p.caption ? { caption: p.caption } : {}),
            },
          }

  let res: Response
  try {
    res = await fetch(`${GRAPH_BASE}/${account.phone_number}/messages`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${account.access_token_encrypted}`,
        'Content-Type': 'application/json',
      },
      body:   JSON.stringify(msgBody),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[send-media] Meta API network error:', msg)
    await markDeliveryFailed(p.admin, p.tenantId, p.messageId, p.userId, 'Network error reaching Meta API', {
      ...preservedMeta,
      meta_send_error: `Network error: ${msg}`,
    })
    return
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText)
    console.error('[send-media] Meta API HTTP error', { status: res.status, detail: raw.slice(0, 200) })
    await markDeliveryFailed(p.admin, p.tenantId, p.messageId, p.userId, `Meta API returned HTTP ${res.status}`, {
      ...preservedMeta,
      meta_send_error: `HTTP ${res.status}: ${raw.slice(0, 120)}`,
    })
    return
  }

  const data = await res.json() as MetaSendResponse
  const outboundWamid = data.messages?.[0]?.id ?? null

  if (!outboundWamid) {
    await markDeliveryFailed(p.admin, p.tenantId, p.messageId, p.userId, 'Meta returned no message ID', preservedMeta)
    return
  }

  const { error } = await p.admin
    .from('messages')
    .update({
      whatsapp_message_id: outboundWamid,
      metadata: {
        ...preservedMeta,
        outbound_whatsapp_message_id: outboundWamid,
        delivery_status: 'sent',
        sent_at:  new Date().toISOString(),
        sent_by:  p.userId,
      } as never,
    })
    .eq('id', p.messageId)
    .eq('tenant_id', p.tenantId)

  if (error) {
    console.error('[send-media] failed to store outbound wamid:', error.message)
  } else {
    console.log('[send-media] delivered', { mediaType: p.mediaType, outboundWamid })
  }
}

// Uploads file bytes to the Meta media endpoint.
// Returns the media_id on success, null on any failure.
async function uploadMediaToMeta(
  phoneNumberId: string,
  token:         string,
  buffer:        Buffer,
  mimeType:      string,
  filename:      string,
): Promise<string | null> {
  try {
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', mimeType)
    // Uint8Array copy ensures the Blob constructor receives a plain ArrayBuffer view
    // rather than a Node.js Buffer<ArrayBufferLike>, which TS rejects as BlobPart.
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename)

    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/media`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
      body:    form,
      signal:  AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error('[send-media] Meta media upload failed', { status: res.status, detail: raw.slice(0, 200) })
      return null
    }

    const data = await res.json() as { id?: string }
    return data.id ?? null
  } catch (err) {
    console.error('[send-media] Meta media upload error:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ─── Shared: mark delivery failed ────────────────────────────────────────────

async function markDeliveryFailed(
  admin:     AdminClient,
  tenantId:  string,
  messageId: string,
  userId:    string,
  reason:    string,
  extraMeta?: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from('messages')
    .update({
      metadata: {
        ...(extraMeta ?? {}),
        delivery_status: 'failed',
        delivery_error:  reason,
        failed_at:       new Date().toISOString(),
        sent_by:         userId,
      } as never,
    })
    .eq('id', messageId)
    .eq('tenant_id', tenantId)

  if (error) {
    console.error('[send-message] failed to store delivery failure:', error.message)
  }
}

// ─── MIME → file extension ────────────────────────────────────────────────────

function mimeToExt(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  const map: Record<string, string> = {
    'image/jpeg':  'jpg',
    'image/png':   'png',
    'image/webp':  'webp',
    'audio/mpeg':  'mp3',
    'audio/ogg':   'ogg',
    'audio/mp4':   'm4a',
    'audio/aac':   'aac',
    'audio/wav':   'wav',
    'audio/webm':  'webm',
    'audio/x-m4a': 'm4a',
    'application/pdf':  'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'text/csv':   'csv',
    'application/csv': 'csv',
  }
  return map[base] ?? 'bin'
}

'use server'

import { z } from 'zod'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import type { ActionResult } from '@/lib/action-result'

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SendReceiptResult = {
  messageId: string
  wamid:     string | null
}

interface MetaSendResponse {
  messages?: Array<{ id: string }>
  error?:    { message: string; code?: number }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const schema = z.object({
  documentId:    z.string().uuid(),
  customCaption: z.string().max(1000).optional(),
})

// ─── Action ───────────────────────────────────────────────────────────────────
//
// Sends a receipt PDF to the reservation's WhatsApp contact.
// Uses a short-lived signed URL (5 min) so Meta can download the private PDF.
// The signed URL is never sent to the client.
// Inserts an outbound 'document' message row for chat display.

export async function sendReceiptDocumentByWhatsAppAction(
  input: unknown,
): Promise<ActionResult<SendReceiptResult>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && !ctx.canConfirmReservations) {
    return { success: false, error: 'No tenés permiso para enviar recibos por WhatsApp.' }
  }

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { documentId, customCaption } = parsed.data
  const admin = createAdminClient()

  // 1. Fetch and validate document
  const { data: doc } = await admin
    .from('documents')
    .select('id, tenant_id, document_type, reservation_id, storage_bucket, storage_path, name, receipt_number, mime_type')
    .eq('id', documentId)
    .maybeSingle()

  if (!doc)                              return { success: false, error: 'Documento no encontrado.' }
  if (doc.tenant_id !== ctx.tenantId)    return { success: false, error: 'Acceso denegado.' }
  if (doc.document_type !== 'receipt')   return { success: false, error: 'Solo se pueden enviar recibos por WhatsApp desde aquí.' }
  if (!doc.reservation_id)              return { success: false, error: 'El recibo no tiene reserva asociada.' }
  if (!doc.storage_bucket || !doc.storage_path) {
    return { success: false, error: 'El documento no tiene archivo disponible.' }
  }

  // 2. Fetch and validate reservation
  const { data: reservation } = await admin
    .from('reservations')
    .select('id, tenant_id, contact_id, conversation_id')
    .eq('id', doc.reservation_id)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation)              return { success: false, error: 'Reserva no encontrada.' }
  if (!reservation.contact_id)  return { success: false, error: 'La reserva no tiene contacto asociado.' }

  // 3. Fetch and validate contact
  const { data: contact } = await admin
    .from('contacts')
    .select('id, phone, name')
    .eq('id', reservation.contact_id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!contact)        return { success: false, error: 'Contacto no encontrado.' }
  if (!contact.phone)  return { success: false, error: 'El contacto no tiene número de teléfono registrado. Agregá el teléfono antes de enviar.' }

  // 4. Resolve conversation_id — required to register the outbound message in the chat
  let conversationId: string | null = reservation.conversation_id ?? null

  if (!conversationId) {
    const { data: conv } = await admin
      .from('conversations')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('contact_id', reservation.contact_id)
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    conversationId = conv?.id ?? null
  }

  if (!conversationId) {
    return { success: false, error: 'No hay conversación de WhatsApp activa para este contacto.' }
  }

  // 5. Resolve active WhatsApp account
  const { data: account } = await admin
    .from('whatsapp_accounts')
    .select('phone_number, access_token_encrypted')
    .eq('tenant_id', ctx.tenantId)
    .eq('active', true)
    .limit(1)
    .maybeSingle()

  if (!account) {
    return { success: false, error: 'No hay cuenta de WhatsApp activa configurada para este tenant.' }
  }

  // 6. Generate short-lived signed URL (5 min) — never leaves the server
  const { data: signedData, error: signedError } = await admin.storage
    .from(doc.storage_bucket)
    .createSignedUrl(doc.storage_path, 300)

  if (signedError || !signedData?.signedUrl) {
    console.error('[receipt-whatsapp] signed URL error:', signedError?.message)
    return { success: false, error: 'No se pudo preparar el archivo para enviar. Intentá de nuevo.' }
  }

  const signedUrl = signedData.signedUrl  // server-side only — not returned to client

  // 7. Build filename and caption
  const filename = doc.name.endsWith('.pdf') ? doc.name : `${doc.name}.pdf`
  const caption  = customCaption?.trim()
    || 'Te enviamos el recibo de tu reserva. Cualquier consulta, respondé por este chat.'

  // 8. Insert outbound message row BEFORE calling Meta
  //    Lets us record the attempt; updated with wamid on success.
  const messageContent = `Recibo enviado por WhatsApp: ${doc.name}`
  const { data: msgRow, error: msgInsertError } = await admin
    .from('messages')
    .insert({
      tenant_id:          ctx.tenantId,
      conversation_id:    conversationId,
      content:            messageContent,
      content_type:       'document',
      sender_type:        'human',
      sender_id:          ctx.userId,
      media_storage_path: null,
      metadata: {
        document_id:     documentId,
        receipt_number:  doc.receipt_number,
        filename,
        mime_type:       doc.mime_type ?? 'application/pdf',
        caption,
        delivery_status: 'pending',
        sent_by:         ctx.userId,
      } as never,
    })
    .select('id')
    .single()

  if (msgInsertError || !msgRow) {
    console.error('[receipt-whatsapp] message insert failed:', msgInsertError?.message)
    return { success: false, error: 'Error interno al registrar el mensaje. El recibo no fue enviado.' }
  }

  const messageId = msgRow.id

  // Helper: update message metadata on delivery outcome (fire-and-forget)
  const updateMeta = async (patch: Record<string, unknown>) => {
    const { error } = await admin
      .from('messages')
      .update({ metadata: patch as never })
      .eq('id', messageId)
      .eq('tenant_id', ctx.tenantId)
    if (error) console.error('[receipt-whatsapp] metadata update failed:', error.message)
  }

  // 9. Send document via Meta Cloud API
  let res: Response
  try {
    res = await fetch(`${GRAPH_BASE}/${account.phone_number}/messages`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${account.access_token_encrypted}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   contact.phone,
        type: 'document',
        document: {
          link:     signedUrl,
          filename,
          caption,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error('[receipt-whatsapp] Meta API network error:', detail)
    await updateMeta({
      document_id: documentId, receipt_number: doc.receipt_number,
      filename, mime_type: doc.mime_type ?? 'application/pdf', caption,
      delivery_status: 'failed', delivery_error: 'Network error reaching Meta API', sent_by: ctx.userId,
    })
    return { success: false, error: 'Error de red al enviar por WhatsApp. El recibo no fue enviado.' }
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText)
    console.error('[receipt-whatsapp] Meta API error', { status: res.status, detail: raw.slice(0, 200) })
    await updateMeta({
      document_id: documentId, receipt_number: doc.receipt_number,
      filename, mime_type: doc.mime_type ?? 'application/pdf', caption,
      delivery_status: 'failed', delivery_error: `Meta API HTTP ${res.status}`, sent_by: ctx.userId,
    })
    return { success: false, error: 'WhatsApp rechazó el envío. Verificá la configuración de la cuenta.' }
  }

  const data   = await res.json() as MetaSendResponse
  const wamid  = data.messages?.[0]?.id ?? null

  // 10. Update message with wamid + delivery_status='sent'
  const successMeta = {
    document_id:                  documentId,
    receipt_number:               doc.receipt_number,
    filename,
    mime_type:                    doc.mime_type ?? 'application/pdf',
    caption,
    delivery_status:              'sent',
    sent_at:                      new Date().toISOString(),
    sent_by:                      ctx.userId,
    outbound_whatsapp_message_id: wamid,
  }

  const { error: updateError } = await admin
    .from('messages')
    .update({
      whatsapp_message_id: wamid,
      metadata:            successMeta as never,
    })
    .eq('id', messageId)
    .eq('tenant_id', ctx.tenantId)

  if (updateError) {
    console.error('[receipt-whatsapp] wamid update failed:', updateError.message)
    // Message was sent successfully to Meta — return success with a warning
    return {
      success: true,
      data:    { messageId, wamid },
      warning: 'Recibo enviado, pero no se pudo registrar correctamente en el chat.',
    } as ActionResult<SendReceiptResult>
  }

  return { success: true, data: { messageId, wamid } }
}

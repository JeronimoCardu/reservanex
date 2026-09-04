'use server'

import { z } from 'zod'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createClient } from '@orderflow/supabase/server'
import type { ActionResult } from '@/lib/action-result'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReservationOption = {
  id:           string
  start_date:   string
  end_date:     string
  status:       string
  total_amount: number | null
  currency:     string
}

// Carried client-side per conversation load — initializes "Comprobante guardado"
// for each message without a per-bubble round-trip.
export type ConversationProofInfo = {
  storagePath:   string
  documentId:    string
  notes:         string | null
  reservationId: string | null
}

export type PaymentProofDoc = {
  id:           string
  name:         string
  file_url:     string
  mime_type:    string | null
  notes:        string | null
  created_at:   string
}

// ─── Save WhatsApp media as payment proof ─────────────────────────────────────
//
// Creates or updates a documents row (document_type = 'payment_proof') linked to
// the message's contact and a reservation (required — no unlinked proofs).
//
// Dedupe rule — one payment_proof per (tenant_id, storage_bucket, storage_path):
//   A) Existing has no reservation    → update with the provided reservation
//   B) Existing has same reservation  → return existing, update notes if changed
//   C) Existing has other reservation → return existing unchanged
//   E) No existing doc                → insert new row with reservation
//
// Does NOT confirm payments, change reservation status, or generate receipts.

const saveProofSchema = z.object({
  messageId:     z.string().uuid(),
  reservationId: z.string().uuid(),
  notes:         z.string().max(1000).optional(),
})

type SaveProofResult = {
  documentId:     string
  alreadyExisted: boolean
  storagePath:    string
  notes:          string | null
  reservationId:  string | null
}

export async function saveMessageMediaAsPaymentProofAction(
  input: unknown,
): Promise<ActionResult<SaveProofResult>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const parsed = saveProofSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { messageId, reservationId, notes } = parsed.data
  const trimmedNotes = notes?.trim() || null
  const supabase = await createClient()

  // 1. Fetch message — validate tenant ownership and content type
  const { data: message } = await supabase
    .from('messages')
    .select('id, tenant_id, content_type, media_storage_path, metadata, conversation_id')
    .eq('id', messageId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!message) {
    return { success: false, error: 'Mensaje no encontrado o sin permisos.' }
  }

  if (message.content_type !== 'image' && message.content_type !== 'document') {
    return { success: false, error: 'Solo imágenes y documentos pueden guardarse como comprobante.' }
  }

  if (!message.media_storage_path) {
    return { success: false, error: 'El archivo aún no está disponible. Intentá de nuevo en unos segundos.' }
  }

  const storagePath = message.media_storage_path

  // 2. Dedupe guard — one payment_proof per (tenant, storage_bucket, storage_path).
  // limit(1) + order handles any pre-migration duplicate rows gracefully.
  const { data: existingArr } = await supabase
    .from('documents')
    .select('id, reservation_id, notes')
    .eq('tenant_id', ctx.tenantId)
    .eq('document_type', 'payment_proof')
    .eq('storage_bucket', 'whatsapp-media')
    .eq('storage_path', storagePath)
    .order('created_at', { ascending: true })
    .limit(1)

  const existing = (existingArr ?? [])[0] ?? null

  if (existing) {
    const updates: {
      notes?:          string | null
      reservation_id?: string | null
      property_id?:    string | null
      unit_id?:        string | null
    } = {}

    let finalNotes         = existing.notes
    let finalReservationId = existing.reservation_id

    if (trimmedNotes !== null && trimmedNotes !== existing.notes) {
      updates.notes = trimmedNotes
      finalNotes    = trimmedNotes
    }

    // Case A: existing has no reservation → link it now
    if (!existing.reservation_id) {
      const { data: conversation } = await supabase
        .from('conversations')
        .select('contact_id')
        .eq('id', message.conversation_id)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle()

      if (conversation) {
        const { data: reservation } = await supabase
          .from('reservations')
          .select('id, contact_id, property_id, unit_id')
          .eq('id', reservationId)
          .eq('tenant_id', ctx.tenantId)
          .is('deleted_at', null)
          .maybeSingle()

        if (reservation && reservation.contact_id === conversation.contact_id) {
          updates.reservation_id = reservationId
          updates.property_id    = reservation.property_id
          updates.unit_id        = reservation.unit_id
          finalReservationId     = reservationId
        }
      }
    }
    // Cases B/C: existing already has a reservation → do not overwrite

    if (Object.keys(updates).length > 0) {
      await supabase
        .from('documents')
        .update(updates)
        .eq('id', existing.id)
        .eq('tenant_id', ctx.tenantId)
    }

    return {
      success: true,
      data: {
        documentId:     existing.id,
        alreadyExisted: true,
        storagePath,
        notes:          finalNotes,
        reservationId:  finalReservationId,
      },
    }
  }

  // 3. No existing doc — fetch conversation for contact FK
  const { data: conversation } = await supabase
    .from('conversations')
    .select('contact_id, property_id, unit_id')
    .eq('id', message.conversation_id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!conversation) {
    return { success: false, error: 'Conversación no encontrada.' }
  }

  // 4. Validate reservation — must belong to same tenant and contact
  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, contact_id, property_id, unit_id')
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada o sin permisos.' }
  }

  if (reservation.contact_id !== conversation.contact_id) {
    return { success: false, error: 'La reserva no pertenece al contacto de esta conversación.' }
  }

  // 5. Extract MIME / filename from message metadata
  const meta     = message.metadata as Record<string, unknown> | null
  const mimeType = typeof meta?.['mime_type'] === 'string' ? meta['mime_type'] : null
  const filename  = typeof meta?.['filename']  === 'string' ? meta['filename']  : null

  const contentLabel = message.content_type === 'image' ? 'imagen' : 'documento'
  const name = filename ? `Comprobante — ${filename}` : `Comprobante de pago — ${contentLabel}`

  // 6. Insert with reservation always set
  const { data: doc, error: insertError } = await supabase
    .from('documents')
    .insert({
      tenant_id:      ctx.tenantId,
      document_type:  'payment_proof',
      name,
      file_url:       `/api/media/${messageId}`,
      source:         'whatsapp',
      storage_bucket: 'whatsapp-media',
      storage_path:   storagePath,
      mime_type:      mimeType,
      contact_id:     conversation.contact_id,
      reservation_id: reservation.id,
      property_id:    reservation.property_id,
      unit_id:        reservation.unit_id,
      notes:          trimmedNotes,
    })
    .select('id, notes, reservation_id')
    .single()

  if (insertError || !doc) {
    console.error('[documents] insert error', { error: insertError?.message, messageId })
    return { success: false, error: 'Error al guardar el comprobante.' }
  }

  return {
    success: true,
    data: {
      documentId:     doc.id,
      alreadyExisted: false,
      storagePath,
      notes:          doc.notes,
      reservationId:  doc.reservation_id,
    },
  }
}

// ─── Get proof info for all payment proofs in a conversation ──────────────────
//
// Returns one ConversationProofInfo per saved proof; the caller builds a Map
// keyed by storagePath for O(1) lookup per message bubble.
// Paths follow the pattern: {tenantId}/{conversationId}/{messageId}.ext

export async function getConversationPaymentProofsAction(
  conversationId: string,
): Promise<ActionResult<ConversationProofInfo[]>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  const supabase = await createClient()

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!conversation) {
    return { success: false, error: 'Conversación no encontrada.' }
  }

  const pattern = `${ctx.tenantId}/${conversationId}/%`

  const { data, error } = await supabase
    .from('documents')
    .select('id, storage_path, notes, reservation_id')
    .eq('tenant_id', ctx.tenantId)
    .eq('document_type', 'payment_proof')
    .eq('storage_bucket', 'whatsapp-media')
    .like('storage_path', pattern)
    .not('storage_path', 'is', null)

  if (error) {
    return { success: false, error: 'Error al cargar comprobantes.' }
  }

  const proofs: ConversationProofInfo[] = (data ?? [])
    .filter((d) => d.storage_path !== null)
    .map((d) => ({
      storagePath:   d.storage_path!,
      documentId:    d.id,
      notes:         d.notes,
      reservationId: d.reservation_id,
    }))

  return { success: true, data: proofs }
}

// ─── Get payment proof documents linked to a reservation ─────────────────────

export async function getReservationPaymentProofsAction(
  reservationId: string,
): Promise<ActionResult<PaymentProofDoc[]>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  const supabase = await createClient()

  const { data: reservation } = await supabase
    .from('reservations')
    .select('id')
    .eq('id', reservationId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!reservation) {
    return { success: false, error: 'Reserva no encontrada.' }
  }

  const { data, error } = await supabase
    .from('documents')
    .select('id, name, file_url, mime_type, notes, created_at')
    .eq('tenant_id', ctx.tenantId)
    .eq('reservation_id', reservationId)
    .eq('document_type', 'payment_proof')
    .order('created_at', { ascending: false })

  if (error) {
    return { success: false, error: 'Error al cargar comprobantes.' }
  }

  return { success: true, data: (data ?? []) as PaymentProofDoc[] }
}

// ─── List reservations for the payment proof modal ────────────────────────────

export async function listConversationReservationsAction(
  conversationId: string,
): Promise<ActionResult<ReservationOption[]>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  const supabase = await createClient()

  const { data: conversation } = await supabase
    .from('conversations')
    .select('contact_id')
    .eq('id', conversationId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!conversation) {
    return { success: false, error: 'Conversación no encontrada.' }
  }

  const { data: reservations, error } = await supabase
    .from('reservations')
    .select('id, start_date, end_date, status, total_amount, currency')
    .eq('tenant_id', ctx.tenantId)
    .eq('contact_id', conversation.contact_id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) {
    return { success: false, error: 'Error al cargar las reservas.' }
  }

  return { success: true, data: reservations ?? [] }
}

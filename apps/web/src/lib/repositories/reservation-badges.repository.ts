import { createClient } from '@orderflow/supabase/server'

export interface ReservationDocumentBadge {
  hasPaymentProof: boolean
  hasReceipt:      boolean
  receiptSent:     boolean
  receiptFailed:   boolean
}

export async function getReservationDocumentBadges(
  tenantId:       string,
  reservationIds: string[],
): Promise<Map<string, ReservationDocumentBadge>> {
  if (reservationIds.length === 0) return new Map()

  const supabase = await createClient()

  // Query 1: documents grouped by reservation and type
  const { data: docs } = await supabase
    .from('documents')
    .select('id, reservation_id, document_type')
    .eq('tenant_id', tenantId)
    .in('reservation_id', reservationIds)
    .is('deleted_at', null)

  if (!docs || docs.length === 0) return new Map()

  const map = new Map<string, ReservationDocumentBadge>()
  const docToReservation = new Map<string, string>()

  for (const doc of docs) {
    if (!doc.reservation_id) continue
    const badge = map.get(doc.reservation_id) ?? {
      hasPaymentProof: false,
      hasReceipt:      false,
      receiptSent:     false,
      receiptFailed:   false,
    }
    if (doc.document_type === 'payment_proof') badge.hasPaymentProof = true
    if (doc.document_type === 'receipt') {
      badge.hasReceipt = true
      docToReservation.set(doc.id, doc.reservation_id)
    }
    map.set(doc.reservation_id, badge)
  }

  // Query 2: receipt delivery status from outbound messages — only if there are receipts
  if (docToReservation.size > 0) {
    const { data: msgs } = await supabase
      .from('messages')
      .select('metadata')
      .eq('tenant_id', tenantId)
      .eq('content_type', 'document')
      .eq('sender_type', 'human')
      .not('metadata->>document_id', 'is', null)

    for (const msg of (msgs ?? [])) {
      const meta           = msg.metadata as Record<string, unknown> | null
      const docId          = typeof meta?.['document_id']    === 'string' ? meta['document_id']    : null
      const deliveryStatus = typeof meta?.['delivery_status'] === 'string' ? meta['delivery_status'] : null

      if (!docId || !deliveryStatus) continue
      const reservationId = docToReservation.get(docId)
      if (!reservationId) continue

      const badge = map.get(reservationId)
      if (!badge) continue

      if (deliveryStatus === 'sent')   badge.receiptSent   = true
      if (deliveryStatus === 'failed') badge.receiptFailed = true
      map.set(reservationId, badge)
    }
  }

  return map
}

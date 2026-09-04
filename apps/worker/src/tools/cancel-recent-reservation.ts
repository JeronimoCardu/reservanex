import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'

export const cancelRecentReservationTool: LLMTool = {
  type: 'function',
  function: {
    name: 'cancel_recent_reservation',
    description:
      'Cancela la reserva pendiente más reciente creada por IA en esta conversación. ' +
      'Usá esta tool cuando el cliente corrija fechas, año u otros datos de una reserva que acabás de crear. ' +
      'Llamala ANTES de crear una nueva reserva con los datos corregidos. ' +
      'Solo cancela reservas source=ai con status=pre_reserved creadas en las últimas 24 horas.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type:        'string',
          description: 'Motivo de la cancelación (ej: "Cliente corrigió el año — era 2024, debe ser 2026")',
        },
      },
      required:             [],
      additionalProperties: false,
    },
  },
}

export async function executeCancelRecentReservation(
  tenantId:       string,
  conversationId: string,
  rawArgs:        Record<string, unknown>,
): Promise<string> {
  const reason   = typeof rawArgs['reason'] === 'string' ? rawArgs['reason'].trim() : 'Cancelada por corrección del cliente'
  const supabase = createClient()

  // Find most recent AI pre_reserved reservation for this conversation (last 24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, start_date, end_date, customer_notes')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .eq('status', 'pre_reserved')
    .eq('source', 'ai')
    .is('deleted_at', null)
    .gt('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!reservation) {
    return JSON.stringify({
      success: false,
      message: 'No encontré una reserva pendiente reciente para cancelar en esta conversación.',
    })
  }

  const existingNotes     = reservation.customer_notes ?? ''
  const cancellationNote  = `${reason}. Fechas originales: ${reservation.start_date} – ${reservation.end_date}`
  const newNotes          = existingNotes ? `${existingNotes}\n${cancellationNote}` : cancellationNote

  const { error } = await supabase
    .from('reservations')
    .update({ status: 'cancelled', customer_notes: newNotes })
    .eq('id', reservation.id)
    .eq('tenant_id', tenantId)

  if (error) {
    throw new Error(`Error al cancelar reserva: ${error.message}`)
  }

  console.log('[cancel_recent_reservation] cancelled', {
    reservationId:  reservation.id,
    tenantId,
    conversationId,
  })

  return JSON.stringify({
    success: true,
    message: 'Reserva pendiente cancelada correctamente. Podés proceder con los datos corregidos.',
  })
}

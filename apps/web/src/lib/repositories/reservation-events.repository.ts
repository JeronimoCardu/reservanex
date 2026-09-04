import { createClient } from '@orderflow/supabase/server'
import type { Json } from '@orderflow/types'

export type ReservationEventRow = {
  id:         string
  event_type: string
  metadata:   Json
  created_at: string
  actor_id:   string | null
  actor?:     { id: string; name: string } | null
}

export async function createReservationEvent(
  tenantId:      string,
  reservationId: string,
  actorId:       string | null,
  eventType:     string,
  metadata:      Record<string, unknown> = {},
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('reservation_events')
    .insert({
      tenant_id:      tenantId,
      reservation_id: reservationId,
      actor_id:       actorId,
      event_type:     eventType,
      metadata:       metadata as Json,
    })

  if (error) {
    console.error('[reservation-event] failed', {
      tenantId,
      reservationId,
      eventType,
      actorId,
      errorCode:    error.code,
      errorMessage: error.message,
    })
  }
}

export async function listReservationEvents(
  tenantId:      string,
  reservationId: string,
): Promise<ReservationEventRow[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservation_events')
    .select('id, event_type, metadata, created_at, actor_id, actor:tenant_users(id, name)')
    .eq('tenant_id', tenantId)
    .eq('reservation_id', reservationId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as ReservationEventRow[]
}

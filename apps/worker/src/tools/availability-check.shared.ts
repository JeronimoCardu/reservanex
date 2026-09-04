/**
 * Shared availability check — single source of truth used by both
 * check_property_availability and create_pending_reservation.
 *
 * Having one implementation guarantees that both tools give the same answer
 * for the same inputs, eliminating "check says blocked, create succeeds" divergence.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'

export type AppSupabase = SupabaseClient<Database>

export type ConflictSource = 'confirmed' | 'pre_reserved' | 'block'

export interface AvailabilityResult {
  available:       boolean
  conflict_source?: ConflictSource
  conflict_id?:    string
}

export async function checkPropertyAvailability(
  supabase:   AppSupabase,
  tenantId:   string,
  propertyId: string,
  startStr:   string,   // YYYY-MM-DD
  endStr:     string,   // YYYY-MM-DD
): Promise<AvailabilityResult> {
  const now = new Date().toISOString()

  // Layer 1 — confirmed reservations that overlap
  const { data: conf } = await supabase
    .from('reservations')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .eq('status', 'confirmed')
    .is('deleted_at', null)
    .lt('start_date', endStr)
    .gt('end_date', startStr)
    .limit(1)

  if (conf && conf.length > 0) {
    return { available: false, conflict_source: 'confirmed', conflict_id: conf[0]!.id }
  }

  // Layer 2 — non-expired pre_reserved reservations that overlap
  const { data: pend } = await supabase
    .from('reservations')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .eq('status', 'pre_reserved')
    .is('deleted_at', null)
    .lt('start_date', endStr)
    .gt('end_date', startStr)
    .gt('expires_at', now)
    .limit(1)

  if (pend && pend.length > 0) {
    return { available: false, conflict_source: 'pre_reserved', conflict_id: pend[0]!.id }
  }

  // Layer 3 — manual availability blocks
  const { data: blk } = await supabase
    .from('property_availability_blocks')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .lt('start_date', endStr)
    .gt('end_date', startStr)
    .limit(1)

  if (blk && blk.length > 0) {
    return { available: false, conflict_source: 'block', conflict_id: blk[0]!.id }
  }

  return { available: true }
}

import type { ReservationRow, ReservationStatus, Json } from '@orderflow/types'
import { createClient } from '@orderflow/supabase/server'

export type ReservationProperty = {
  id:             string
  title:          string
  city:           string | null
  check_in_time:  string | null
  check_out_time: string | null
}

export type ReservationUnit = {
  id:       string
  name:     string
  property: ReservationProperty | null
}

export type ReservationContact = {
  id:    string
  name:  string | null
  phone: string | null
}

export type ReservationWithDetails = ReservationRow & {
  property: ReservationProperty | null
  unit:     ReservationUnit     | null
  contact:  ReservationContact  | null
}

export type ReservationForConversation = Pick<
  ReservationRow,
  'id' | 'status' | 'start_date' | 'end_date' | 'guests' | 'total_amount' | 'currency' | 'price_currency' | 'notes' | 'created_at' | 'expires_at' | 'source' | 'payment_status'
> & {
  property: ReservationProperty | null
  unit:     { id: string; name: string } | null
}

export async function listReservationsByConversation(
  tenantId:       string,
  conversationId: string,
): Promise<ReservationForConversation[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservations')
    .select(`
      id, status, start_date, end_date, guests, total_amount, currency, price_currency, notes, created_at, expires_at, source, payment_status,
      property:properties(id, title, city),
      unit:units(id, name)
    `)
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as ReservationForConversation[]
}

export async function getReservationById(
  tenantId:      string,
  reservationId: string,
): Promise<ReservationWithDetails | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservations')
    .select(`
      *,
      property:properties(id, title, city, check_in_time, check_out_time),
      unit:units(id, name, property:properties(id, title, city, check_in_time, check_out_time)),
      contact:contacts(id, name, phone)
    `)
    .eq('tenant_id', tenantId)
    .eq('id', reservationId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data as unknown as ReservationWithDetails | null
}

export async function confirmReservation(
  tenantId:      string,
  reservationId: string,
  confirmedById: string,
): Promise<{ conversation_id: string | null }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservations')
    .update({
      status:       'confirmed',
      confirmed_at: new Date().toISOString(),
      confirmed_by: confirmedById,
    })
    .eq('tenant_id', tenantId)
    .eq('id', reservationId)
    .eq('status', 'pre_reserved')
    .is('deleted_at', null)
    .select('conversation_id')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw new Error('NOT_FOUND')
  return { conversation_id: data.conversation_id }
}

export async function completeReservation(
  tenantId:       string,
  reservationId:  string,
  completedById:  string,
): Promise<{ conversation_id: string | null }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservations')
    .update({
      status:       'completed',
      completed_at: new Date().toISOString(),
      completed_by: completedById,
    })
    .eq('tenant_id', tenantId)
    .eq('id', reservationId)
    .eq('status', 'confirmed')
    .is('deleted_at', null)
    .select('conversation_id')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw new Error('NOT_FOUND')
  return { conversation_id: data.conversation_id }
}

export async function cancelReservation(
  tenantId:      string,
  reservationId: string,
  cancelledById: string,
  reason:        string | null,
): Promise<{ conversation_id: string | null }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservations')
    .update({
      status:              'cancelled',
      cancelled_at:        new Date().toISOString(),
      cancelled_by:        cancelledById,
      cancellation_reason: reason ?? null,
    })
    .eq('tenant_id', tenantId)
    .eq('id', reservationId)
    .neq('status', 'cancelled')
    .is('deleted_at', null)
    .select('conversation_id')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw new Error('NOT_FOUND')
  return { conversation_id: data.conversation_id }
}

export async function rescheduleReservation(
  tenantId:      string,
  reservationId: string,
  input: {
    start_date:              string
    end_date:                string
    guests:                  number
    nights_count:            number
    nightly_price_snapshot:  number | null
    subtotal_amount:         number | null
    fees_amount:             number
    total_amount:            number | null
    deposit_required_amount: number | null
    pricing_mode_snapshot:   string
    pricing_breakdown:       Json
    price_currency:          string
  },
): Promise<{ conversation_id: string | null }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservations')
    .update({
      start_date:              input.start_date,
      end_date:                input.end_date,
      guests:                  input.guests,
      nights_count:            input.nights_count,
      nightly_price_snapshot:  input.nightly_price_snapshot,
      subtotal_amount:         input.subtotal_amount,
      fees_amount:             input.fees_amount,
      total_amount:            input.total_amount,
      deposit_required_amount: input.deposit_required_amount,
      pricing_mode_snapshot:   input.pricing_mode_snapshot,
      pricing_breakdown:       input.pricing_breakdown,
      price_currency:          input.price_currency,
      updated_at:              new Date().toISOString(),
    })
    .eq('tenant_id', tenantId)
    .eq('id', reservationId)
    .in('status', ['pre_reserved', 'confirmed'])
    .is('deleted_at', null)
    .select('conversation_id')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw new Error('NOT_FOUND')
  return { conversation_id: data.conversation_id }
}

export type UpcomingPropertyReservation = Pick<
  ReservationRow,
  'id' | 'status' | 'start_date' | 'end_date' | 'guests' | 'expires_at' | 'source'
> & { contact: ReservationContact | null }

export async function listUpcomingReservationsByProperty(
  tenantId:   string,
  propertyId: string,
): Promise<UpcomingPropertyReservation[]> {
  const supabase = await createClient()
  const today    = new Date().toISOString().split('T')[0]!

  const { data, error } = await supabase
    .from('reservations')
    .select('id, status, start_date, end_date, guests, expires_at, source, contact:contacts(id, name, phone)')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .in('status', ['pre_reserved', 'confirmed'])
    .is('deleted_at', null)
    .gte('end_date', today)
    .order('start_date', { ascending: true })
    .limit(20)

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as UpcomingPropertyReservation[]
}

export async function listReservationsByTenant(
  tenantId: string,
  opts?: {
    status?: ReservationStatus
    limit?:  number
    offset?: number
  },
): Promise<ReservationWithDetails[]> {
  const supabase = await createClient()

  let query = supabase
    .from('reservations')
    .select(`
      *,
      property:properties(id, title, city, check_in_time, check_out_time),
      unit:units(id, name, property:properties(id, title, city, check_in_time, check_out_time)),
      contact:contacts(id, name, phone)
    `)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 100)

  if (opts?.status) query = query.eq('status', opts.status)
  if (opts?.offset) query = query.range(opts.offset, opts.offset + (opts?.limit ?? 100) - 1)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as ReservationWithDetails[]
}

export async function createReservation(
  tenantId: string,
  input: {
    contact_id:              string
    conversation_id:         string | null
    property_id:             string | null
    unit_id:                 string | null
    start_date:              string
    end_date:                string
    guests:                  number
    nights_count?:           number | null
    total_amount?:           number | null
    subtotal_amount?:        number | null
    fees_amount?:            number
    nightly_price_snapshot?: number | null
    deposit_required_amount?: number | null
    pricing_mode_snapshot?:  string | null
    pricing_breakdown?:      Json
    currency?:               string
    price_currency?:         string
    status?:                 ReservationStatus
    source?:                 string
    notes?:                  string | null
    expires_at?:             string | null
  },
): Promise<Pick<ReservationRow, 'id'>> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservations')
    .insert({
      tenant_id:               tenantId,
      contact_id:              input.contact_id,
      conversation_id:         input.conversation_id,
      property_id:             input.property_id,
      unit_id:                 input.unit_id,
      start_date:              input.start_date,
      end_date:                input.end_date,
      guests:                  input.guests,
      nights_count:            input.nights_count ?? null,
      total_amount:            input.total_amount ?? null,
      subtotal_amount:         input.subtotal_amount ?? null,
      fees_amount:             input.fees_amount ?? 0,
      nightly_price_snapshot:  input.nightly_price_snapshot ?? null,
      deposit_required_amount: input.deposit_required_amount ?? null,
      pricing_mode_snapshot:   input.pricing_mode_snapshot ?? null,
      pricing_breakdown:       input.pricing_breakdown ?? {},
      currency:                input.currency ?? 'ARS',
      price_currency:          input.price_currency ?? input.currency ?? 'ARS',
      status:                  input.status ?? 'inquiry',
      source:                  input.source ?? 'manual',
      notes:                   input.notes ?? null,
      expires_at:              input.expires_at ?? null,
    })
    .select('id')
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function updateReservationStatus(
  tenantId:      string,
  reservationId: string,
  status:        ReservationStatus,
): Promise<{ conversation_id: string | null }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('reservations')
    .update({ status })
    .eq('tenant_id', tenantId)
    .eq('id', reservationId)
    .is('deleted_at', null)
    .select('conversation_id')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw new Error('NOT_FOUND')
  return { conversation_id: data.conversation_id }
}

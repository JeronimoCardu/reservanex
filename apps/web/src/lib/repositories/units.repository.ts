import type { UnitRow } from '@orderflow/types'
import type { CreateUnitInput, UpdateUnitInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'

export async function listUnits(tenantId: string, propertyId: string): Promise<UnitRow[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('units')
    .select('*')
    .eq('property_id', propertyId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getUnitById(tenantId: string, id: string): Promise<UnitRow | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('units')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) return null
  return data
}

export async function createUnit(
  tenantId: string,
  propertyId: string,
  input: CreateUnitInput,
): Promise<UnitRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('units')
    .insert({
      tenant_id:   tenantId,
      property_id: propertyId,
      name:        input.name,
      capacity:    input.capacity,
      price:       input.price ?? null,
      currency:    input.currency,
      active:      true,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function updateUnit(
  tenantId: string,
  id: string,
  input: UpdateUnitInput,
): Promise<UnitRow> {
  const supabase = await createClient()

  const patch: {
    name?:     string
    capacity?: number
    currency?: string
    price?:    number | null
  } = {}
  if (input.name !== undefined)     patch.name     = input.name
  if (input.capacity !== undefined) patch.capacity = input.capacity
  if (input.currency !== undefined) patch.currency = input.currency
  // price can be explicitly set to null (clear price)
  if ('price' in input) patch.price = input.price ?? null

  const { data, error } = await supabase
    .from('units')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function setUnitActive(
  tenantId: string,
  id: string,
  active: boolean,
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('units')
    .update({ active })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (error) throw new Error(error.message)
}

export async function hasActiveReservationsForUnit(
  tenantId: string,
  unitId: string,
): Promise<boolean> {
  const supabase = await createClient()

  const { count } = await supabase
    .from('reservations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('unit_id', unitId)
    .is('deleted_at', null)
    .neq('status', 'cancelled')

  return (count ?? 0) > 0
}

export async function archiveUnit(tenantId: string, id: string): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('units')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (error) throw new Error(error.message)
}

export async function validatePropertyAccess(
  tenantId: string,
  propertyId: string,
  workspaceIds: string[] | null,
): Promise<boolean> {
  const supabase = await createClient()

  if (workspaceIds !== null && workspaceIds.length === 0) return false

  let query = supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (workspaceIds !== null) {
    query = query.in('workspace_id', workspaceIds)
  }

  const { data } = await query.maybeSingle()
  return !!data
}

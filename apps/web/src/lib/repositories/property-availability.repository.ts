import { createClient } from '@orderflow/supabase/server'

export type PropertyAvailabilityBlock = {
  id:          string
  tenant_id:   string
  property_id: string
  start_date:  string
  end_date:    string
  reason:      string | null
  created_by:  string | null
  created_at:  string
}

export async function listPropertyAvailabilityBlocks(
  tenantId:   string,
  propertyId: string,
  fromDate?:  string,
): Promise<PropertyAvailabilityBlock[]> {
  const supabase = await createClient()

  const today = fromDate ?? new Date().toISOString().split('T')[0]!

  const { data, error } = await supabase
    .from('property_availability_blocks')
    .select('id, tenant_id, property_id, start_date, end_date, reason, created_by, created_at')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .gte('end_date', today)
    .order('start_date', { ascending: true })
    .limit(50)

  if (error) throw new Error(error.message)
  return (data ?? []) as PropertyAvailabilityBlock[]
}

export async function createPropertyAvailabilityBlock(
  tenantId: string,
  input: {
    property_id: string
    start_date:  string
    end_date:    string
    reason?:     string | null
    created_by:  string
  },
): Promise<{ id: string }> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('property_availability_blocks')
    .insert({
      tenant_id:   tenantId,
      property_id: input.property_id,
      start_date:  input.start_date,
      end_date:    input.end_date,
      reason:      input.reason ?? null,
      created_by:  input.created_by,
    })
    .select('id')
    .single()

  if (error) throw new Error(error.message)
  return data as { id: string }
}

export async function deletePropertyAvailabilityBlock(
  tenantId: string,
  blockId:  string,
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('property_availability_blocks')
    .update({ deleted_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', blockId)
    .is('deleted_at', null)

  if (error) throw new Error(error.message)
}

import type { TenantUserRow } from '@orderflow/types'
import { createClient } from '@orderflow/supabase/server'

export async function listActiveTenantUsers(tenantId: string): Promise<TenantUserRow[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tenant_users')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .order('name')

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getTenantUserById(
  tenantId: string,
  userId: string,
): Promise<TenantUserRow | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tenant_users')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', userId)
    .eq('active', true)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data
}

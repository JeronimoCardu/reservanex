import type { WorkspaceRow, WorkspaceUpdate } from '@orderflow/types'
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'
import { nullify } from './shared'

export async function listWorkspaces(
  tenantId: string,
  opts?: { activeOnly?: boolean },
): Promise<WorkspaceRow[]> {
  const supabase = await createClient()

  let query = supabase
    .from('workspaces')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true })

  if (opts?.activeOnly) query = query.eq('active', true)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data
}

export async function getWorkspaceById(
  tenantId: string,
  id: string,
): Promise<WorkspaceRow | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error) return null
  return data
}

export async function createWorkspace(
  tenantId: string,
  input: CreateWorkspaceInput,
): Promise<WorkspaceRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('workspaces')
    .insert({
      tenant_id: tenantId,
      name: input.name,
      type: input.type,
      city: nullify(input.city),
      address: nullify(input.address),
      phone: nullify(input.phone),
      email: nullify(input.email),
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function updateWorkspace(
  tenantId: string,
  id: string,
  input: UpdateWorkspaceInput,
): Promise<WorkspaceRow> {
  const supabase = await createClient()

  const patch: WorkspaceUpdate = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.type !== undefined) patch.type = input.type
  if (input.city !== undefined) patch.city = nullify(input.city)
  if (input.address !== undefined) patch.address = nullify(input.address)
  if (input.phone !== undefined) patch.phone = nullify(input.phone)
  if (input.email !== undefined) patch.email = nullify(input.email)

  const { data, error } = await supabase
    .from('workspaces')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function archiveWorkspace(tenantId: string, id: string): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('workspaces')
    .update({ active: false })
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) throw new Error(error.message)
}

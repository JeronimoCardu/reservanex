import { createClient } from '@orderflow/supabase/server'

// Converts empty/blank strings to null.
// Used in workspace and property repositories for optional text fields.
export function nullify(val: string | undefined): string | null {
  const trimmed = val?.trim()
  return trimmed === '' || trimmed === undefined ? null : trimmed
}

// Checks that a workspace is active and belongs to the tenant.
// Shared between conversations and properties repositories — identical logic.
export async function validateWorkspaceInTenant(
  tenantId: string,
  workspaceId: string,
): Promise<boolean> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from('workspaces')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('id', workspaceId)
    .eq('active', true)

  if (error) throw new Error(error.message)
  return (count ?? 0) > 0
}

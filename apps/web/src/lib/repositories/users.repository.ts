import type { TenantUserRow } from '@orderflow/types'
import type { CreateTenantUserInput, UpdateTenantUserInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import {
  ensureInvitedUser,
  ENSURE_RATE_LIMIT,
  ENSURE_REDIRECT_INVALID,
  ENSURE_CONFIRMED_OTHER,
} from '@/lib/auth/ensure-invited-user'
import type { EnsureInvitedStatus } from '@/lib/auth/ensure-invited-user'
import { getAuthRedirectTo } from '@/lib/site-url'

export type TenantUserWithWorkspaceIds = TenantUserRow & {
  workspaceIds: string[]
}

// ─── Error sentinels ──────────────────────────────────────────────────────────
// Named constants so the action layer can match without coupling to raw messages.
export const OWNER_UNIQUE_VIOLATION         = 'OWNER_UNIQUE_VIOLATION'
export const ALREADY_IN_TENANT              = 'ALREADY_IN_TENANT'
export const ALREADY_IN_TENANT_INACTIVE     = 'ALREADY_IN_TENANT_INACTIVE'
export const AUTH_USER_CONFIRMED_NO_TENANT  = 'AUTH_USER_CONFIRMED_NO_TENANT'
export const INVITE_RATE_LIMIT              = 'INVITE_RATE_LIMIT'
export const INVITE_REDIRECT_URL_INVALID    = 'INVITE_REDIRECT_URL_INVALID'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function throwIfOwnerUniqueViolation(error: { code?: string; message?: string }): void {
  if (
    error.code === '23505' &&
    error.message?.includes('idx_one_active_owner_per_tenant')
  ) {
    throw new Error(OWNER_UNIQUE_VIOLATION)
  }
}

// Maps ensureInvitedUser sentinels to the legacy sentinels the action layer expects.
function remapEnsureError(msg: string): string | null {
  if (msg === ENSURE_RATE_LIMIT)       return INVITE_RATE_LIMIT
  if (msg === ENSURE_REDIRECT_INVALID) return INVITE_REDIRECT_URL_INVALID
  if (msg === ENSURE_CONFIRMED_OTHER)  return AUTH_USER_CONFIRMED_NO_TENANT
  return null
}

// ─── Repository functions ─────────────────────────────────────────────────────

export async function listTenantUsers(tenantId: string): Promise<TenantUserWithWorkspaceIds[]> {
  const supabase = await createClient()

  const { data: users, error } = await supabase
    .from('tenant_users')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return (users ?? []).map((u) => ({ ...u, workspaceIds: [] }))
}

export async function getTenantUserById(
  tenantId: string,
  id: string,
): Promise<TenantUserWithWorkspaceIds | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tenant_users')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error || !data) return null
  return { ...data, workspaceIds: [] }
}

export async function countActiveOwners(
  tenantId: string,
  excludeUserId?: string,
): Promise<number> {
  const supabase = await createClient()

  let query = supabase
    .from('tenant_users')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('role', 'owner')
    .eq('active', true)

  if (excludeUserId) query = query.neq('id', excludeUserId)

  const { count } = await query
  return count ?? 0
}

export async function countActiveReceptionists(
  tenantId: string,
  excludeUserId?: string,
): Promise<number> {
  const supabase = await createClient()

  let query = supabase
    .from('tenant_users')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('role', 'receptionist')
    .eq('active', true)

  if (excludeUserId) query = query.neq('id', excludeUserId)

  const { count } = await query
  return count ?? 0
}

export async function countActiveTenantUsers(
  tenantId: string,
  excludeUserId?: string,
): Promise<number> {
  const supabase = await createClient()

  let query = supabase
    .from('tenant_users')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('active', true)

  if (excludeUserId) query = query.neq('id', excludeUserId)

  const { count } = await query
  return count ?? 0
}

export type TenantLimits = {
  maxOwners:        number
  maxReceptionists: number
  maxTotalUsers:    number
}

export async function getTenantLimits(tenantId: string): Promise<TenantLimits> {
  const admin = createAdminClient()

  const { data } = await admin
    .from('tenants')
    .select('max_owners, max_receptionists, max_users')
    .eq('id', tenantId)
    .maybeSingle()

  return {
    maxOwners:        data?.max_owners        ?? 1,
    maxReceptionists: data?.max_receptionists ?? 4,
    maxTotalUsers:    data?.max_users         ?? 5,
  }
}

export async function validateWorkspacesInTenant(
  tenantId: string,
  workspaceIds: string[],
): Promise<boolean> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('workspaces')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .in('id', workspaceIds)

  if (error || !data) return false
  return data.length === workspaceIds.length
}

export async function createTenantUser(
  tenantId: string,
  input: CreateTenantUserInput,
): Promise<TenantUserRow> {
  const admin    = createAdminClient()
  const supabase = await createClient()
  const normalizedEmail = input.email.toLowerCase().trim()

  // Guard: email already in this tenant (active or inactive)
  const { data: existingInTenant } = await supabase
    .from('tenant_users')
    .select('id, active')
    .eq('tenant_id', tenantId)
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (existingInTenant) {
    throw new Error(existingInTenant.active ? ALREADY_IN_TENANT : ALREADY_IN_TENANT_INACTIVE)
  }

  const redirectTo = getAuthRedirectTo()

  // ensureInvitedUser with sendRecoveryToConfirmed=false: confirmed users from
  // other contexts are blocked (throws ENSURE_CONFIRMED_OTHER → AUTH_USER_CONFIRMED_NO_TENANT).
  let ensureResult: Awaited<ReturnType<typeof ensureInvitedUser>>
  try {
    ensureResult = await ensureInvitedUser(normalizedEmail, redirectTo, {
      sendRecoveryToConfirmed: false,
    })
  } catch (err) {
    const msg    = err instanceof Error ? err.message : ''
    const mapped = remapEnsureError(msg)
    if (mapped) throw new Error(mapped)
    console.error('[auth:invite:create] ensureInvitedUser failed', {
      email: normalizedEmail,
      tenantId,
      error: msg,
    })
    throw new Error(msg || 'Error al enviar la invitación')
  }

  const { authUserId, isNewUser } = ensureResult

  // If a previous invite attempt already created the tenant_users record, return it.
  const { data: existingById } = await supabase
    .from('tenant_users')
    .select('*')
    .eq('id', authUserId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (existingById) {
    return existingById
  }

  try {
    const { data, error } = await supabase
      .from('tenant_users')
      .insert({
        id:        authUserId,
        tenant_id: tenantId,
        name:      input.name,
        email:     normalizedEmail,
        role:      input.role,
        active:    true,
      })
      .select()
      .single()

    if (error) {
      console.error('[auth:invite:create] tenant_users insert failed', {
        email:        normalizedEmail,
        tenantId,
        authUserId,
        phase:        'tenantUserInsert',
        errorCode:    error.code,
        errorMessage: error.message,
      })
      throwIfOwnerUniqueViolation(error)
      throw new Error(error.message)
    }

    const workspaceIds = input.role === 'owner' ? [] : (input.workspaceIds ?? [])
    if (workspaceIds.length > 0) {
      const { error: assignError } = await supabase
        .from('user_workspace_assignments')
        .insert(workspaceIds.map((workspace_id) => ({ user_id: authUserId, workspace_id })))
      if (assignError) throw new Error(assignError.message)
    }

    return data
  } catch (err) {
    // Only roll back by deleting the auth user when WE created it in this request.
    // isNewUser=false means the user pre-existed (e.g. belongs to another tenant) —
    // deleting them would destroy their account elsewhere.
    if (isNewUser) {
      await admin.auth.admin.deleteUser(authUserId).catch((delErr: unknown) => {
        console.warn('[auth:invite:create] rollback deleteUser failed', {
          authUserId,
          error: delErr instanceof Error ? delErr.message : String(delErr),
        })
      })
    }
    throw err
  }
}

export async function resendUserAccess(
  tenantId: string,
  userId:   string,
): Promise<{ mode: EnsureInvitedStatus }> {
  const admin    = createAdminClient()
  const supabase = await createClient()

  const { data: tu } = await supabase
    .from('tenant_users')
    .select('id, email, active')
    .eq('id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!tu) throw new Error('Usuario no encontrado en este tenant.')
  if (!tu.active) throw new Error('El usuario está desactivado. Reactivalo primero.')

  const { data: authData, error: authError } = await admin.auth.admin.getUserById(userId)
  if (authError || !authData.user) {
    console.error('[auth:resend-access] getUserById failed', {
      userId,
      tenantId,
      errorCode:    authError?.code,
      errorMessage: authError?.message,
    })
    throw new Error('No se encontró el usuario en auth.')
  }

  const email      = authData.user.email ?? tu.email
  const redirectTo = getAuthRedirectTo()

  try {
    const result = await ensureInvitedUser(email, redirectTo)

    console.log('[auth:resend-access]', {
      userId,
      tenantId,
      email,
      mode: result.status,
    })

    return { mode: result.status }
  } catch (err) {
    const msg    = err instanceof Error ? err.message : ''
    const mapped = remapEnsureError(msg)
    if (mapped) {
      console.error('[auth:resend-access] ensureInvitedUser failed', {
        userId,
        tenantId,
        email,
        error: msg,
      })
      throw new Error(mapped)
    }
    throw err
  }
}

export async function updateTenantUser(
  tenantId: string,
  id: string,
  input: UpdateTenantUserInput,
): Promise<TenantUserRow> {
  const supabase = await createClient()

  const patch: { name?: string; role?: 'owner' | 'receptionist' } = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.role !== undefined) patch.role = input.role

  const { data, error } = await supabase
    .from('tenant_users')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select()
    .single()

  if (error) {
    throwIfOwnerUniqueViolation(error)
    throw new Error(error.message)
  }
  return data
}

export async function deactivateTenantUser(tenantId: string, id: string): Promise<void> {
  const admin    = createAdminClient()
  const supabase = await createClient()

  // Ban auth first: if DB update fails, user is blocked (safe failure).
  const { error: banError } = await admin.auth.admin.updateUserById(id, {
    ban_duration: '876000h',
  })

  if (banError) throw new Error(banError.message)

  const { error } = await supabase
    .from('tenant_users')
    .update({ active: false })
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) {
    // Rollback: unban in auth so the user can still log in
    await admin.auth.admin.updateUserById(id, { ban_duration: 'none' })
    throw new Error(error.message)
  }
}

export type ReceptionistPermissions = {
  can_create_properties:    boolean
  can_access_settings:      boolean
  can_confirm_reservations: boolean
  can_assign_conversations: boolean
  // Fase 3E-B1 — gestionar consultas es su propio permiso, no un efecto
  // secundario de can_confirm_reservations.
  can_manage_inquiries:     boolean
  // Fase 3E-B2 — agendar y gestionar visitas es su propio permiso.
  can_manage_visits:        boolean
  // Fase 3E-C2 — reservas de mesa, ídem.
  can_manage_table_reservations: boolean
}

export async function updateReceptionistPermissions(
  tenantId: string,
  id: string,
  permissions: ReceptionistPermissions,
): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin
    .from('tenant_users')
    .update(permissions)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .eq('role', 'receptionist')
  if (error) throw new Error(error.message)
}

export async function assignWorkspaces(
  tenantId:     string,
  userId:       string,
  workspaceIds: string[],
): Promise<void> {
  const supabase = await createClient()

  const [{ data: user, error: userError }, { data: tenantWorkspaces }] = await Promise.all([
    supabase
      .from('tenant_users')
      .select('id')
      .eq('id', userId)
      .eq('tenant_id', tenantId)
      .single(),
    supabase.from('workspaces').select('id').eq('tenant_id', tenantId),
  ])

  if (userError || !user) throw new Error('Usuario no pertenece a este tenant')

  const tenantWorkspaceIds = (tenantWorkspaces ?? []).map((w) => w.id)

  if (tenantWorkspaceIds.length > 0) {
    const { error: deleteError } = await supabase
      .from('user_workspace_assignments')
      .delete()
      .eq('user_id', userId)
      .in('workspace_id', tenantWorkspaceIds)

    if (deleteError) throw new Error(deleteError.message)
  }

  if (workspaceIds.length > 0) {
    const { error: insertError } = await supabase
      .from('user_workspace_assignments')
      .insert(workspaceIds.map((workspace_id) => ({ user_id: userId, workspace_id })))

    if (insertError) throw new Error(insertError.message)
  }
}

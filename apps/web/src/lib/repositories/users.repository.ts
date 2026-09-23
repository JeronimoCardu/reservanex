import type { TenantUserRow } from '@orderflow/types'
import type { CreateTenantUserInput, UpdateTenantUserInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import type { EnsureInvitedStatus } from '@/lib/auth/ensure-invited-user'
import {
  issueAccessLink,
  ACCESS_LINK_RATE_LIMIT,
  ACCESS_LINK_REDIRECT_INVALID,
  ACCESS_LINK_CONFIRMED_OTHER,
  type AccessLink,
} from '@/lib/auth/issue-access-link'
import { sendAccessEmail } from '@/lib/auth/send-access-email'

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

// Sentinelas del emisor de accesos → los sentinelas históricos que la capa de
// actions ya interpreta, para que sus mensajes al usuario no cambien.
function remapAccessLinkError(msg: string): string | null {
  if (msg === ACCESS_LINK_RATE_LIMIT)       return INVITE_RATE_LIMIT
  if (msg === ACCESS_LINK_REDIRECT_INVALID) return INVITE_REDIRECT_URL_INVALID
  if (msg === ACCESS_LINK_CONFIRMED_OTHER)  return AUTH_USER_CONFIRMED_NO_TENANT
  return null
}

/** El nombre del negocio para el email. Si falla, el copy tiene su variante. */
async function tenantDisplayName(tenantId: string): Promise<string | null> {
  try {
    const admin = createAdminClient()
    const { data } = await admin.from('tenants').select('name').eq('id', tenantId).maybeSingle()
    return data?.name ?? null
  } catch {
    return null
  }
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

/**
 * NULL significa SIN LÍMITE, igual que en la columna.
 *
 * Esto es lo que antes decía `?? 5`: con las columnas ya nullables, ese
 * fallback habría interpretado "sin límite" como "cinco" y habría topeado
 * justo a las inmobiliarias, que son las que no deben tener tope. El default
 * por ausencia de fila se mantiene conservador —si el tenant no existe no se
 * crea nada— pero NULL se propaga tal cual.
 */
export type TenantLimits = {
  maxOwners:        number | null
  maxReceptionists: number | null
  maxTotalUsers:    number | null
}

export async function getTenantLimits(tenantId: string): Promise<TenantLimits> {
  const admin = createAdminClient()

  const { data } = await admin
    .from('tenants')
    .select('max_owners, max_receptionists, max_users')
    .eq('id', tenantId)
    .maybeSingle()

  return {
    maxOwners:        data?.max_owners        ?? null,
    maxReceptionists: data?.max_receptionists ?? null,
    maxTotalUsers:    data?.max_users         ?? null,
  }
}

/** ¿Llegó al tope? Con límite nulo, nunca. */
export function limitReached(actual: number, max: number | null): boolean {
  return max !== null && actual >= max
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

  // Atención humana V2 / Invitaciones V2 — el acceso se emite SIN que Supabase
  // mande nada: el email lo arma ReservaNex y lo entrega Resend, más abajo,
  // recién cuando la fila de tenant_users ya existe.
  //
  // allowRecoveryForConfirmed: false conserva EXACTAMENTE la semántica previa
  // del alta: un email ya confirmado en otro contexto se bloquea, no se degrada
  // en silencio a un recovery.
  let link: AccessLink
  try {
    link = await issueAccessLink(normalizedEmail, { allowRecoveryForConfirmed: false })
  } catch (err) {
    const msg    = err instanceof Error ? err.message : ''
    const mapped = remapAccessLinkError(msg)
    if (mapped) throw new Error(mapped)
    console.error('[auth:invite:create] issueAccessLink failed', {
      email: normalizedEmail,
      tenantId,
      error: msg,
    })
    throw new Error(msg || 'Error al generar el acceso')
  }

  const { userId: authUserId, isNewUser } = link

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

    // El email va al final, con el estado interno ya persistido: si sale antes
    // y el insert falla después, el destinatario recibe un acceso a una cuenta
    // que ReservaNex no terminó de preparar.
    //
    // El rol del copy es el REAL (input.role: owner | receptionist), no una
    // suposición: este alta crea los dos.
    //
    // Un fallo de envío NO deshace el alta — el usuario quedó creado y el
    // reenvío existe para eso. Se registra y sigue.
    const businessName = await tenantDisplayName(tenantId)
    const envio = await sendAccessEmail({
      to:            normalizedEmail,
      role:          input.role,
      kind:          link.kind,
      accessUrl:     link.url,
      businessName,
      recipientName: input.name,
    })
    if (!envio.ok) {
      console.error('[auth:invite:create] el usuario quedó creado pero el email no salió', {
        email: normalizedEmail, tenantId, role: input.role, reason: envio.reason,
      })
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
    .select('id, email, active, role, name')
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

  const email = authData.user.email ?? tu.email

  // El reenvío SÍ puede terminar en recovery, como hasta ahora: si la cuenta
  // ya está confirmada, el email cambia de copy y el link lleva al flujo de
  // contraseña nueva. Nunca se le dice "te invitaron" a alguien que ya entró.
  let link: AccessLink
  try {
    link = await issueAccessLink(email, { allowRecoveryForConfirmed: true })
  } catch (err) {
    const msg    = err instanceof Error ? err.message : ''
    const mapped = remapAccessLinkError(msg)
    console.error('[auth:resend-access] issueAccessLink failed', { userId, tenantId, email, error: msg })
    if (mapped) throw new Error(mapped)
    throw err
  }

  const businessName = await tenantDisplayName(tenantId)
  const envio = await sendAccessEmail({
    to:            email,
    role:          tu.role,
    kind:          link.kind,
    accessUrl:     link.url,
    businessName,
    recipientName: tu.name,
  })

  // Se conserva el contrato que la action ya interpreta: 'email_not_sent'
  // dispara el aviso de "no se pudo enviar automáticamente".
  const mode: EnsureInvitedStatus = !envio.ok
    ? 'email_not_sent'
    : link.kind === 'recovery' ? 'recovery_sent' : 'invited'

  console.log('[auth:resend-access]', { userId, tenantId, email, kind: link.kind, mode })

  return { mode }
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
  // Fase 3E-C3A1 — administrar el catálogo gastronómico es una decisión
  // comercial (fija precios), distinta de la operación del salón.
  can_manage_menu:          boolean
  // Fase 3E-C3B0 — aceptar/rechazar pedidos. Cierra el último legacy: hasta
  // acá order_request se autorizaba con can_confirm_reservations.
  can_manage_orders:        boolean
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

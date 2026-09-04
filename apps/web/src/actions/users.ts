'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/lib/auth/require-owner'
import {
  createTenantUserSchema,
  updateTenantUserSchema,
  assignWorkspacesSchema,
} from '@orderflow/validators'
import * as repo from '@/lib/repositories/users.repository'
import {
  OWNER_UNIQUE_VIOLATION,
  ALREADY_IN_TENANT,
  ALREADY_IN_TENANT_INACTIVE,
  AUTH_USER_CONFIRMED_NO_TENANT,
  INVITE_RATE_LIMIT,
  INVITE_REDIRECT_URL_INVALID,
} from '@/lib/repositories/users.repository'
import type { ReceptionistPermissions } from '@/lib/repositories/users.repository'
import type { ActionResult } from '@/lib/action-result'

const REVALIDATE = '/dashboard/users'

function mapInviteError(msg: string): string {
  switch (msg) {
    case OWNER_UNIQUE_VIOLATION:
      return 'Este tenant ya tiene el máximo de administradores permitidos por el plan.'
    case ALREADY_IN_TENANT:
      return 'Este email ya pertenece a este tenant. Si el usuario no puede acceder, usá el botón "Reenviar acceso" en la tabla.'
    case ALREADY_IN_TENANT_INACTIVE:
      return 'Este usuario está desactivado en este tenant. Reactivalo desde la tabla.'
    case AUTH_USER_CONFIRMED_NO_TENANT:
      return 'Este email ya tiene una cuenta activa en el sistema pero no pertenece a este tenant. Contactá a soporte.'
    case INVITE_RATE_LIMIT:
      return 'Supabase limitó el envío de emails temporalmente. Esperá unos minutos y volvé a intentar.'
    case INVITE_REDIRECT_URL_INVALID:
      return 'La URL de redirección de Auth no está habilitada en Supabase. Revisá Authentication → URL Configuration → Redirect URLs y agregá la URL de la app.'
    default:
      return null as unknown as string // signals unknown error
  }
}

export async function createTenantUserAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const { tenantId } = await requireOwner()

  const parsed = createTenantUserSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const limits = await repo.getTenantLimits(tenantId)

  // Check per-role limits
  if (parsed.data.role === 'owner') {
    const ownerCount = await repo.countActiveOwners(tenantId)
    if (ownerCount >= limits.maxOwners) {
      return {
        success: false,
        error: 'Este tenant ya tiene el máximo de administradores permitidos por el plan.',
      }
    }
  }

  if (parsed.data.role === 'receptionist') {
    const receptionistCount = await repo.countActiveReceptionists(tenantId)
    if (receptionistCount >= limits.maxReceptionists) {
      return {
        success: false,
        error: `Tu plan permite hasta ${limits.maxReceptionists} agentes. Para sumar más usuarios, necesitás cambiar de plan.`,
      }
    }
  }

  // Check total user limit
  const totalCount = await repo.countActiveTenantUsers(tenantId)
  if (totalCount >= limits.maxTotalUsers) {
    return {
      success: false,
      error: 'Tu plan llegó al límite de usuarios disponibles. Para sumar más, necesitás cambiar de plan.',
    }
  }

  const workspaceIds =
    parsed.data.role === 'owner' ? undefined : (parsed.data.workspaceIds ?? [])

  if (workspaceIds && workspaceIds.length > 0) {
    const valid = await repo.validateWorkspacesInTenant(tenantId, workspaceIds)
    if (!valid) {
      return { success: false, error: 'Uno o más workspaces no pertenecen a este tenant.' }
    }
  }

  try {
    const user = await repo.createTenantUser(tenantId, { ...parsed.data, workspaceIds })
    revalidatePath(REVALIDATE)
    return { success: true, data: { id: user.id } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    const mapped = mapInviteError(msg)
    if (mapped) return { success: false, error: mapped }
    // Unknown error: logged in repository; show generic message in UI
    console.error('[users:createTenantUserAction] unhandled error', { msg })
    return { success: false, error: 'Error al enviar la invitación. Intentá de nuevo.' }
  }
}

export async function updateTenantUserAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  const parsed = updateTenantUserSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const user = await repo.getTenantUserById(tenantId, id)
  if (!user) return { success: false, error: 'Usuario no encontrado.' }

  if (parsed.data.role === 'owner' && user.role !== 'owner') {
    const [ownerCount, limits] = await Promise.all([
      repo.countActiveOwners(tenantId, id),
      repo.getTenantLimits(tenantId),
    ])
    if (ownerCount >= limits.maxOwners) {
      return {
        success: false,
        error: 'Este tenant ya tiene el máximo de administradores permitidos por el plan.',
      }
    }
  }

  if (parsed.data.role === 'receptionist' && user.role !== 'receptionist') {
    const [receptionistCount, limits] = await Promise.all([
      repo.countActiveReceptionists(tenantId, id),
      repo.getTenantLimits(tenantId),
    ])
    if (receptionistCount >= limits.maxReceptionists) {
      return {
        success: false,
        error: `Tu plan permite hasta ${limits.maxReceptionists} agentes. Para sumar más usuarios, necesitás cambiar de plan.`,
      }
    }
  }

  if (parsed.data.role === 'receptionist' && user.role === 'owner') {
    const otherOwnerCount = await repo.countActiveOwners(tenantId, id)
    if (otherOwnerCount === 0) {
      return { success: false, error: 'No podés cambiar el rol del único owner del tenant.' }
    }
  }

  try {
    await repo.updateTenantUser(tenantId, id, parsed.data)
    revalidatePath(REVALIDATE)
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg === OWNER_UNIQUE_VIOLATION) {
      return { success: false, error: 'Este tenant ya tiene el máximo de administradores permitidos por el plan.' }
    }
    return { success: false, error: 'Error al actualizar el usuario. Intentá de nuevo.' }
  }
}

export async function assignWorkspacesAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  const parsed = assignWorkspacesSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const user = await repo.getTenantUserById(tenantId, id)
  if (!user) return { success: false, error: 'Usuario no encontrado.' }

  if (parsed.data.workspaceIds.length > 0) {
    const valid = await repo.validateWorkspacesInTenant(tenantId, parsed.data.workspaceIds)
    if (!valid) {
      return { success: false, error: 'Uno o más workspaces no pertenecen a este tenant.' }
    }
  }

  try {
    await repo.assignWorkspaces(tenantId, id, parsed.data.workspaceIds)
    revalidatePath(REVALIDATE)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al asignar workspaces. Intentá de nuevo.' }
  }
}

export async function updateReceptionistPermissionsAction(
  id: string,
  permissions: ReceptionistPermissions,
): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  const user = await repo.getTenantUserById(tenantId, id)
  if (!user) return { success: false, error: 'Usuario no encontrado.' }
  if (user.role !== 'receptionist') {
    return { success: false, error: 'Solo se pueden editar permisos de recepcionistas.' }
  }

  try {
    await repo.updateReceptionistPermissions(tenantId, id, permissions)
    revalidatePath(REVALIDATE)
    return { success: true }
  } catch (err) {
    console.error('[users] updateReceptionistPermissionsAction failed:', err)
    return { success: false, error: 'Error al actualizar permisos. Intentá de nuevo.' }
  }
}

export async function deactivateTenantUserAction(id: string): Promise<ActionResult> {
  const { tenantId, userId } = await requireOwner()

  if (id === userId) {
    return { success: false, error: 'No podés desactivar tu propia cuenta.' }
  }

  const user = await repo.getTenantUserById(tenantId, id)
  if (!user) return { success: false, error: 'Usuario no encontrado.' }
  if (!user.active) return { success: false, error: 'El usuario ya está desactivado.' }

  if (user.role === 'owner') {
    const ownerCount = await repo.countActiveOwners(tenantId)
    if (ownerCount <= 1) {
      return { success: false, error: 'No podés desactivar al único owner del tenant.' }
    }
  }

  try {
    await repo.deactivateTenantUser(tenantId, id)
    revalidatePath(REVALIDATE)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al desactivar el usuario. Intentá de nuevo.' }
  }
}

export async function resendUserAccessAction(id: string): Promise<ActionResult> {
  const { tenantId, userId } = await requireOwner()

  if (id === userId) {
    return { success: false, error: 'No podés reenviar acceso a tu propia cuenta.' }
  }

  try {
    const { mode } = await repo.resendUserAccess(tenantId, id)
    if (mode === 'email_not_sent') {
      return {
        success: true,
        warning: 'No se pudo enviar el email automáticamente. El usuario puede solicitar acceso desde el login con su email.',
      }
    }
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg === INVITE_RATE_LIMIT) {
      return {
        success: false,
        error: 'Supabase limitó el envío de emails temporalmente. Esperá unos minutos y volvé a intentar.',
      }
    }
    if (msg === INVITE_REDIRECT_URL_INVALID) {
      return {
        success: false,
        error: 'La URL de redirección de Auth no está habilitada en Supabase. Revisá Authentication → URL Configuration → Redirect URLs.',
      }
    }
    return { success: false, error: msg || 'No se pudo enviar el email. Intentá de nuevo.' }
  }
}

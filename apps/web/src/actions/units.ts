'use server'

import { revalidatePath } from 'next/cache'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createUnitSchema, updateUnitSchema } from '@orderflow/validators'
import * as repo from '@/lib/repositories/units.repository'
import type { ActionResult } from '@/lib/action-result'

function detailPath(propertyId: string) {
  return `/dashboard/properties/${propertyId}`
}

// PERM-04: misma lógica que canManageProperties en properties.ts — mantener en sync.
function canManageProperties(ctx: Awaited<ReturnType<typeof requireTenantContext>>): boolean {
  return ctx.role === 'owner' || ctx.canCreateProperties
}

export async function createUnitAction(
  propertyId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para gestionar unidades.' }
  }

  // Verify property is accessible to this user (respects workspace scoping)
  const canAccess = await repo.validatePropertyAccess(ctx.tenantId, propertyId, ctx.workspaceIds)
  if (!canAccess) return { success: false, error: 'Propiedad no encontrada.' }

  const parsed = createUnitSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  try {
    const unit = await repo.createUnit(ctx.tenantId, propertyId, parsed.data)
    revalidatePath(detailPath(propertyId))
    return { success: true, data: { id: unit.id } }
  } catch {
    return { success: false, error: 'Error al crear la unidad. Intentá de nuevo.' }
  }
}

export async function updateUnitAction(id: string, input: unknown): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para gestionar unidades.' }
  }

  const unit = await repo.getUnitById(ctx.tenantId, id)
  if (!unit) return { success: false, error: 'Unidad no encontrada.' }

  // Verify the parent property is accessible to this user
  const canAccess = await repo.validatePropertyAccess(
    ctx.tenantId,
    unit.property_id,
    ctx.workspaceIds,
  )
  if (!canAccess) return { success: false, error: 'Unidad no encontrada.' }

  const parsed = updateUnitSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  try {
    await repo.updateUnit(ctx.tenantId, id, parsed.data)
    revalidatePath(detailPath(unit.property_id))
    return { success: true }
  } catch {
    return { success: false, error: 'Error al actualizar la unidad. Intentá de nuevo.' }
  }
}

export async function toggleUnitActiveAction(id: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para gestionar unidades.' }
  }

  const unit = await repo.getUnitById(ctx.tenantId, id)
  if (!unit) return { success: false, error: 'Unidad no encontrada.' }

  const canAccess = await repo.validatePropertyAccess(
    ctx.tenantId,
    unit.property_id,
    ctx.workspaceIds,
  )
  if (!canAccess) return { success: false, error: 'Unidad no encontrada.' }

  try {
    await repo.setUnitActive(ctx.tenantId, id, !unit.active)
    revalidatePath(detailPath(unit.property_id))
    return { success: true }
  } catch {
    return { success: false, error: 'Error al cambiar el estado de la unidad. Intentá de nuevo.' }
  }
}

export async function archiveUnitAction(id: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden eliminar unidades.' }
  }

  const unit = await repo.getUnitById(ctx.tenantId, id)
  if (!unit) return { success: false, error: 'Unidad no encontrada.' }

  // Defense-in-depth: verify the parent property is still accessible (it may have been archived)
  const canAccess = await repo.validatePropertyAccess(ctx.tenantId, unit.property_id, null)
  if (!canAccess) return { success: false, error: 'La propiedad padre no existe.' }

  const hasReservations = await repo.hasActiveReservationsForUnit(ctx.tenantId, id)
  if (hasReservations) {
    return {
      success: false,
      error: 'La unidad tiene reservas activas. Cancelalas antes de eliminar.',
    }
  }

  try {
    await repo.archiveUnit(ctx.tenantId, id)
    revalidatePath(detailPath(unit.property_id))
    return { success: true }
  } catch {
    return { success: false, error: 'Error al eliminar la unidad. Intentá de nuevo.' }
  }
}

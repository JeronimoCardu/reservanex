'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import * as repo from '@/lib/repositories/property-availability.repository'
import type { ActionResult } from '@/lib/action-result'

const createBlockSchema = z.object({
  property_id: z.string().uuid('Propiedad inválida'),
  start_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de inicio inválida (YYYY-MM-DD)'),
  end_date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de fin inválida (YYYY-MM-DD)'),
  reason:      z.string().max(500).nullable().optional(),
})

function canManageAvailability(ctx: { role: string; canConfirmReservations: boolean }): boolean {
  return ctx.role === 'owner' || ctx.canConfirmReservations
}

export async function createAvailabilityBlockAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()

  if (!canManageAvailability(ctx)) {
    return { success: false, error: 'No tenés permiso para bloquear disponibilidad.' }
  }

  const parsed = createBlockSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { start_date, end_date, property_id, reason } = parsed.data

  if (end_date <= start_date) {
    return { success: false, error: 'La fecha de fin debe ser posterior a la fecha de inicio.' }
  }

  try {
    const block = await repo.createPropertyAvailabilityBlock(ctx.tenantId, {
      property_id,
      start_date,
      end_date,
      reason: reason ?? null,
      created_by: ctx.userId,
    })
    revalidatePath(`/dashboard/properties/${property_id}`)
    return { success: true, data: { id: block.id } }
  } catch {
    return { success: false, error: 'Error al crear el bloqueo. Intentá de nuevo.' }
  }
}

export async function deleteAvailabilityBlockAction(
  blockId:    string,
  propertyId: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (!canManageAvailability(ctx)) {
    return { success: false, error: 'No tenés permiso para eliminar bloqueos.' }
  }

  try {
    await repo.deletePropertyAvailabilityBlock(ctx.tenantId, blockId)
    revalidatePath(`/dashboard/properties/${propertyId}`)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al eliminar el bloqueo. Intentá de nuevo.' }
  }
}

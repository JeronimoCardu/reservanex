'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/lib/auth/require-owner'
import { createWorkspaceSchema, updateWorkspaceSchema } from '@orderflow/validators'
import * as repo from '@/lib/repositories/workspaces.repository'
import type { ActionResult } from '@/lib/action-result'

const REVALIDATE = '/dashboard/workspaces'

export async function createWorkspaceAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const { tenantId } = await requireOwner()

  const parsed = createWorkspaceSchema.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? 'Datos inválidos'
    return { success: false, error: msg }
  }

  try {
    const workspace = await repo.createWorkspace(tenantId, parsed.data)
    revalidatePath(REVALIDATE)
    return { success: true, data: { id: workspace.id } }
  } catch {
    return { success: false, error: 'Error al crear el workspace. Intentá de nuevo.' }
  }
}

export async function updateWorkspaceAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  const parsed = updateWorkspaceSchema.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message ?? 'Datos inválidos'
    return { success: false, error: msg }
  }

  // Verify the workspace belongs to this tenant before updating
  const workspace = await repo.getWorkspaceById(tenantId, id)
  if (!workspace) return { success: false, error: 'Workspace no encontrado.' }

  try {
    await repo.updateWorkspace(tenantId, id, parsed.data)
    revalidatePath(REVALIDATE)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al actualizar el workspace. Intentá de nuevo.' }
  }
}

export async function archiveWorkspaceAction(id: string): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  // Verify ownership and fetch type in one scoped query
  const workspace = await repo.getWorkspaceById(tenantId, id)
  if (!workspace) return { success: false, error: 'Workspace no encontrado.' }

  if (workspace.type === 'general') {
    return { success: false, error: 'El workspace General no puede ser archivado.' }
  }

  try {
    await repo.archiveWorkspace(tenantId, id)
    revalidatePath(REVALIDATE)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al archivar el workspace. Intentá de nuevo.' }
  }
}

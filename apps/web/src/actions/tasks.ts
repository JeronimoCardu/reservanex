'use server'

import { revalidatePath } from 'next/cache'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  createTaskSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
} from '@orderflow/validators'
import * as taskRepo from '@/lib/repositories/tasks.repository'
import * as convRepo from '@/lib/repositories/conversations.repository'
import { validateAssigneeInTenant } from '@/lib/repositories/conversations.repository'
import type { ActionResult } from '@/lib/action-result'

const TASKS_PATH = '/dashboard/tasks'

// Ownership guard for receptionist mutations.
// Owners can modify any task; receptionists only their own.
function assertCanModify(
  role: string,
  taskCreatedBy: string | null,
  actorId: string,
): ActionResult | null {
  if (role === 'receptionist' && taskCreatedBy !== actorId) {
    return { success: false, error: 'No tenés permisos para modificar esta tarea.' }
  }
  return null
}

export async function createTaskAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()

  const parsed = createTaskSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  if (parsed.data.assigned_to) {
    const valid = await validateAssigneeInTenant(ctx.tenantId, parsed.data.assigned_to)
    if (!valid) {
      return { success: false, error: 'El usuario asignado no existe en tu organización.' }
    }
  }

  let conv: Awaited<ReturnType<typeof convRepo.getConversationById>> = null
  if (parsed.data.conversation_id) {
    conv = await convRepo.getConversationById(
      ctx.tenantId,
      parsed.data.conversation_id,
    )
    if (!conv) return { success: false, error: 'Conversación no encontrada.' }
  }

  // Derive workspace for the task:
  //   - Inherit from conversation when linked
  //   - Receptionist without conversation: use their first workspace
  //   - Owner without conversation: null (global task)
  const workspaceId: string | null =
    conv?.workspace_id ??
    (ctx.role === 'receptionist' && ctx.workspaceIds && ctx.workspaceIds.length > 0
      ? ctx.workspaceIds[0]
      : null) ??
    null

  try {
    const task = await taskRepo.createTask(ctx.tenantId, ctx.userId, workspaceId, parsed.data)
    revalidatePath(TASKS_PATH)
    if (parsed.data.conversation_id) {
      revalidatePath(`/dashboard/conversations/${parsed.data.conversation_id}`)
    }
    if (parsed.data.contact_id) {
      revalidatePath(`/dashboard/contacts/${parsed.data.contact_id}`)
    }
    return { success: true, data: { id: task.id } }
  } catch {
    return { success: false, error: 'Error al crear la tarea. Intentá de nuevo.' }
  }
}

export async function updateTaskAction(id: string, input: unknown): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  const task = await taskRepo.getTaskById(ctx.tenantId, id)
  if (!task) return { success: false, error: 'Tarea no encontrada.' }

  // Ownership rule: receptionist can only edit tasks they created
  const ownershipError = assertCanModify(ctx.role, task.created_by, ctx.userId)
  if (ownershipError) return ownershipError

  const parsed = updateTaskSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  if (parsed.data.assigned_to) {
    const valid = await validateAssigneeInTenant(ctx.tenantId, parsed.data.assigned_to)
    if (!valid) {
      return { success: false, error: 'El usuario asignado no existe en tu organización.' }
    }
  }

  try {
    await taskRepo.updateTask(ctx.tenantId, id, parsed.data)
    revalidatePath(TASKS_PATH)
    if (task.conversation_id) revalidatePath(`/dashboard/conversations/${task.conversation_id}`)
    if (task.contact_id)      revalidatePath(`/dashboard/contacts/${task.contact_id}`)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al actualizar la tarea. Intentá de nuevo.' }
  }
}

export async function updateTaskStatusAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  const task = await taskRepo.getTaskById(ctx.tenantId, id)
  if (!task) return { success: false, error: 'Tarea no encontrada.' }

  // Ownership rule: receptionist can only complete/reopen tasks they created
  const ownershipError = assertCanModify(ctx.role, task.created_by, ctx.userId)
  if (ownershipError) return ownershipError

  const parsed = updateTaskStatusSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Estado inválido' }
  }

  try {
    await taskRepo.updateTaskStatus(ctx.tenantId, id, parsed.data.status)
    revalidatePath(TASKS_PATH)
    if (task.conversation_id) revalidatePath(`/dashboard/conversations/${task.conversation_id}`)
    if (task.contact_id)      revalidatePath(`/dashboard/contacts/${task.contact_id}`)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al actualizar el estado. Intentá de nuevo.' }
  }
}

export async function deleteTaskAction(id: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  const task = await taskRepo.getTaskById(ctx.tenantId, id)
  if (!task) return { success: false, error: 'Tarea no encontrada.' }

  // Ownership rule: receptionist can only delete tasks they created
  const ownershipError = assertCanModify(ctx.role, task.created_by, ctx.userId)
  if (ownershipError) return ownershipError

  try {
    await taskRepo.deleteTask(ctx.tenantId, id)
    revalidatePath(TASKS_PATH)
    if (task.conversation_id) revalidatePath(`/dashboard/conversations/${task.conversation_id}`)
    if (task.contact_id)      revalidatePath(`/dashboard/contacts/${task.contact_id}`)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al eliminar la tarea. Intentá de nuevo.' }
  }
}

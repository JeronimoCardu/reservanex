'use server'

import { revalidatePath } from 'next/cache'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  createConversationSchema,
  updateConversationSchema,
  setAiModeSchema,
} from '@orderflow/validators'
import * as repo from '@/lib/repositories/conversations.repository'
import type { ActionResult } from '@/lib/action-result'

const LIST_PATH   = '/dashboard/conversations'
const DETAIL_PATH = (id: string) => `/dashboard/conversations/${id}`

export async function createConversationAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const parsed = createConversationSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const valid = await repo.validateContactInTenant(ctx.tenantId, parsed.data.contact_id)
  if (!valid) {
    return { success: false, error: 'El contacto no existe en tu organización.' }
  }

  if (ctx.role === 'receptionist') {
    if (!parsed.data.workspace_id) {
      return { success: false, error: 'Debés asignar un workspace a la conversación.' }
    }
    if (!ctx.workspaceIds?.includes(parsed.data.workspace_id)) {
      return { success: false, error: 'No tenés acceso a ese workspace.' }
    }
  }

  if (parsed.data.workspace_id) {
    const validWs = await repo.validateWorkspaceInTenant(ctx.tenantId, parsed.data.workspace_id)
    if (!validWs) {
      return { success: false, error: 'El workspace no existe o no pertenece a tu organización.' }
    }
  }

  try {
    const conversation = await repo.createConversation(ctx.tenantId, parsed.data)
    revalidatePath(LIST_PATH)
    return { success: true, data: { id: conversation.id } }
  } catch (err) {
    console.error('[conversations] create failed:', err)
    return { success: false, error: 'Error al crear la conversación. Intentá de nuevo.' }
  }
}

export async function updateConversationAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden reasignar el workspace de una conversación.' }
  }

  const conversation = await repo.getConversationById(ctx.tenantId, id)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  const parsed = updateConversationSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  if (parsed.data.workspace_id) {
    const valid = await repo.validateWorkspaceInTenant(ctx.tenantId, parsed.data.workspace_id)
    if (!valid) {
      return { success: false, error: 'El workspace no existe o no pertenece a tu organización.' }
    }
  }

  try {
    await repo.updateConversation(ctx.tenantId, id, parsed.data)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[conversations] update failed:', err)
    return { success: false, error: 'Error al actualizar la conversación. Intentá de nuevo.' }
  }
}

export async function assignConversationAction(
  id: string,
  assignedUserId: string | null,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const conversation = await repo.getConversationById(ctx.tenantId, id)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  if (ctx.role === 'receptionist') {
    if (!ctx.canAssignConversations) {
      return { success: false, error: 'No tenés permiso para asignar conversaciones.' }
    }

    const isSelfAssign   = assignedUserId === ctx.userId
    const isUnassigned   = conversation.assigned_user_id === null
    const isAlreadyMine  = conversation.assigned_user_id === ctx.userId
    const isSelfRemove   = assignedUserId === null && isAlreadyMine

    if (!((isSelfAssign && (isUnassigned || isAlreadyMine)) || isSelfRemove)) {
      return {
        success: false,
        error: 'Solo podés tomar conversaciones sin asignar o desasignarte de las tuyas.',
      }
    }
  }

  if (assignedUserId !== null) {
    const valid = await repo.validateAssigneeInTenant(ctx.tenantId, assignedUserId)
    if (!valid) {
      return { success: false, error: 'El usuario asignado no existe en tu organización.' }
    }
  }

  try {
    await repo.assignConversation(ctx.tenantId, id, assignedUserId)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[conversations] assign failed:', err)
    return { success: false, error: 'Error al asignar la conversación. Intentá de nuevo.' }
  }
}

export async function closeConversationAction(
  id: string,
  options?: { reactivateAi?: boolean },
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const conversation = await repo.getConversationById(ctx.tenantId, id)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  if (conversation.status === 'closed') {
    return { success: false, error: 'La conversación ya está cerrada.' }
  }

  try {
    await repo.closeConversation(ctx.tenantId, id, { reactivateAi: options?.reactivateAi })
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[conversations] close failed:', err)
    return { success: false, error: 'Error al cerrar la conversación. Intentá de nuevo.' }
  }
}

export async function reopenConversationAction(id: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const conversation = await repo.getConversationById(ctx.tenantId, id)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  if (conversation.status !== 'closed') {
    return { success: false, error: 'La conversación ya está abierta.' }
  }

  try {
    await repo.reopenConversation(ctx.tenantId, id)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[conversations] reopen failed:', err)
    return { success: false, error: 'Error al reabrir la conversación. Intentá de nuevo.' }
  }
}

export async function associatePropertyAction(
  conversationId: string,
  propertyId:     string | null,
  unitId:         string | null,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const conversation = await repo.getConversationById(ctx.tenantId, conversationId)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  if (propertyId) {
    const supabase = await (await import('@orderflow/supabase/server')).createClient()
    const { count } = await supabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('id', propertyId)
      .is('deleted_at', null)
    if (!count) return { success: false, error: 'La propiedad no existe en tu organización.' }
  }

  try {
    await repo.associateProperty(ctx.tenantId, conversationId, propertyId, unitId)
    revalidatePath(DETAIL_PATH(conversationId))
    return { success: true }
  } catch (err) {
    console.error('[conversations] associate-property failed:', err)
    return { success: false, error: 'Error al asociar la propiedad. Intentá de nuevo.' }
  }
}

const VALID_LEAD_STATUSES = new Set([
  'new', 'contacted', 'interested', 'visit_scheduled', 'discarded', 'converted', 'closed',
])

export async function updateConversationLeadStatusAction(
  id:     string,
  status: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (!VALID_LEAD_STATUSES.has(status)) {
    return { success: false, error: 'Estado de lead inválido.' }
  }

  const conversation = await repo.getConversationById(ctx.tenantId, id)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  try {
    await repo.updateLeadStatus(ctx.tenantId, id, status, ctx.userId)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[conversations] update-lead-status failed:', err)
    return { success: false, error: 'Error al actualizar el estado del lead. Intentá de nuevo.' }
  }
}

export async function setAiModeAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && ctx.role !== 'receptionist') {
    return { success: false, error: 'No tenés permiso para cambiar el modo de IA.' }
  }

  const parsed = setAiModeSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Modo inválido' }
  }

  const conversation = await repo.getConversationById(ctx.tenantId, id)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  try {
    await repo.setAiMode(ctx.tenantId, id, parsed.data.mode)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[conversations] set-ai-mode failed:', err)
    return { success: false, error: 'Error al cambiar el modo de IA. Intentá de nuevo.' }
  }
}

export async function reactivateConversationAiAction(
  id: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner' && ctx.role !== 'receptionist') {
    return { success: false, error: 'No tenés permiso para reactivar la IA.' }
  }

  const conversation = await repo.getConversationById(ctx.tenantId, id)
  if (!conversation) return { success: false, error: 'Conversación no encontrada.' }

  try {
    await repo.reactivateConversationAi(ctx.tenantId, id, ctx.userId)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return {
      success: true,
      warning: 'La IA fue reactivada. Volverá a responder automáticamente los próximos mensajes del cliente.',
    }
  } catch (err) {
    console.error('[conversations] reactivate-ai failed:', err)
    return { success: false, error: 'Error al reactivar la IA. Intentá de nuevo.' }
  }
}

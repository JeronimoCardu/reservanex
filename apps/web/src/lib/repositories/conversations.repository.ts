import type { ConversationRow, ContactRow, ConversationStatus, AiMode } from '@orderflow/types'
import type { CreateConversationInput, UpdateConversationInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'
import { humanAttentionAttendedPatch } from '@/lib/human-attention/semantics'

export type ConversationWithContact = ConversationRow & {
  contact: ContactRow
}

export async function listConversations(
  tenantId: string,
  opts?: {
    status?:         ConversationStatus
    aiMode?:         AiMode
    assignedUserId?: string | null
    contactId?:      string
    limit?:          number
    offset?:         number
  },
): Promise<ConversationWithContact[]> {
  const supabase = await createClient()

  let query = supabase
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('tenant_id', tenantId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(opts?.limit ?? 50)

  if (opts?.status)    query = query.eq('status', opts.status)
  if (opts?.aiMode)    query = query.eq('ai_mode', opts.aiMode)
  if (opts?.contactId) query = query.eq('contact_id', opts.contactId)
  if (opts?.offset)    query = query.range(opts.offset, opts.offset + (opts.limit ?? 50) - 1)

  if (opts?.assignedUserId === null) {
    query = query.is('assigned_user_id', null)
  } else if (opts?.assignedUserId) {
    query = query.eq('assigned_user_id', opts.assignedUserId)
  }

  const { data, error } = await query

  if (error) throw new Error(error.message)
  return (data ?? []) as ConversationWithContact[]
}

export type ConversationProperty = {
  id:             string
  title:          string
  city:           string | null
  operation_type: string | null
  slug:           string | null
  published:      boolean | null
}

export type ConversationUnit = {
  id:   string
  name: string
}

export type ConversationWithContactRow = ConversationRow & {
  contact?:  { name: string | null; phone: string | null } | null
  property?: ConversationProperty | null
  unit?:     ConversationUnit     | null
}

export async function getConversationById(
  tenantId: string,
  id: string,
): Promise<ConversationWithContactRow | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('conversations')
    .select('*, contact:contacts(name, phone), property:properties(id, title, city, operation_type, slug, published), unit:units(id, name)')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data as ConversationWithContactRow | null
}

export async function createConversation(
  tenantId: string,
  input: CreateConversationInput,
): Promise<ConversationRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('conversations')
    .insert({
      tenant_id:    tenantId,
      contact_id:   input.contact_id,
      workspace_id: input.workspace_id ?? null,
      channel:      input.channel      ?? 'manual',
      source:       input.source       ?? 'manual',
      ai_mode:      input.ai_mode ?? 'manual',
      status:       'open',
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function updateConversation(
  tenantId: string,
  id: string,
  patch: UpdateConversationInput,
): Promise<ConversationRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('conversations')
    .update({ workspace_id: patch.workspace_id ?? null })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function assignConversation(
  tenantId: string,
  id: string,
  assignedUserId: string | null,
): Promise<ConversationRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('conversations')
    .update({ assigned_user_id: assignedUserId })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function setAiMode(
  tenantId: string,
  id: string,
  mode: AiMode,
): Promise<ConversationRow> {
  const supabase = await createClient()
  const now = new Date().toISOString()

  const patch =
    mode === 'manual'
      ? {
          ai_mode:                      mode,
          needs_human_attention:        true  as const,
          human_attention_requested_at: now,
          ai_handoff_reason:            'manual_takeover' as const,
          ai_handoff_at:                now,
        }
      : { ai_mode: mode }

  const { data, error } = await supabase
    .from('conversations')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

/**
 * Atención humana V2 — "Marcar como atendido" y "reactivar la IA" son la MISMA
 * escritura: una persona declara que se hizo cargo, y el asistente retoma.
 *
 * Además de lo que ya hacía (IA autonomous, contador y motivo del handoff a
 * cero, actor de la reactivación), cierra el ciclo de atención y deja la
 * ventana HUMAN y el contexto coherentes:
 *
 *   - human_attention_resolved_at/by: la única escritura de "atendido" del
 *     sistema. Ni el worker ni el trigger la tocan.
 *   - human_until = null: antes quedaba stale. Con un valor vencido, una toma
 *     manual posterior se revertía sola en el próximo inbound (human_expired).
 *   - ai_context_reset_at = now(): lo que pasó mientras atendía una persona
 *     (incluidos los inbound sin respuesta registrada, porque ReservaNex no ve
 *     lo que se contesta desde WhatsApp Business) no vuelve a entrar al
 *     contexto. Misma semántica que la reactivación por expiración del worker.
 *
 * human_attention_requested_at NO se borra: es el historial del último ciclo, y
 * un ciclo nuevo lo sobreescribe con now() (> resolved_at ⇒ pendiente otra vez).
 * Los mensajes no se tocan.
 */
export async function reactivateConversationAi(
  tenantId:  string,
  id:        string,
  userId:    string,
): Promise<ConversationRow> {
  const supabase = await createClient()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('conversations')
    .update(humanAttentionAttendedPatch(userId, now))
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

// ── Atención humana V2 — la bandeja ─────────────────────────────────────────
//
// Filtra por human_attention_pending, la columna generada que define
// "pendiente" (open ∧ requested_at ∧ no resuelto después). Se lee con el
// cliente del usuario a propósito: las RLS de conversations deciden qué ve un
// receptionist (sin asignar o asignadas a él) y el owner ve todo. Nada acá
// reimplementa esa regla.

export type HumanAttentionRow = Pick<
  ConversationRow,
  | 'id' | 'contact_id' | 'channel' | 'status' | 'ai_mode' | 'human_until'
  | 'ai_handoff_reason' | 'assigned_user_id'
  | 'human_attention_requested_at' | 'human_attention_resolved_at' | 'human_attention_email_sent_at'
  | 'last_message_content' | 'last_message_sender_type' | 'last_message_at'
> & {
  contact: { name: string | null; phone: string | null } | null
}

const HUMAN_ATTENTION_COLUMNS =
  'id, contact_id, channel, status, ai_mode, human_until, ai_handoff_reason, assigned_user_id, ' +
  'human_attention_requested_at, human_attention_resolved_at, human_attention_email_sent_at, ' +
  'last_message_content, last_message_sender_type, last_message_at, ' +
  'contact:contacts(name, phone)'

export async function listPendingHumanAttention(tenantId: string): Promise<HumanAttentionRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('conversations')
    .select(HUMAN_ATTENTION_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('human_attention_pending', true)
    // Más antiguo primero: el que más espera va arriba.
    .order('human_attention_requested_at', { ascending: true })
    .limit(200)

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as HumanAttentionRow[]
}

export async function countPendingHumanAttention(tenantId: string): Promise<number> {
  const supabase = await createClient()
  const { count, error } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('human_attention_pending', true)

  if (error) throw new Error(error.message)
  return count ?? 0
}

export async function closeConversation(
  tenantId: string,
  id: string,
  opts?: { reactivateAi?: boolean },
): Promise<ConversationRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('conversations')
    .update({
      status:                'closed',
      closed_at:             new Date().toISOString(),
      needs_human_attention: false,
      ...(opts?.reactivateAi ? { ai_mode: 'autonomous' as AiMode } : {}),
    })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function reopenConversation(tenantId: string, id: string): Promise<ConversationRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('conversations')
    .update({ status: 'open', closed_at: null })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function associateProperty(
  tenantId:       string,
  conversationId: string,
  propertyId:     string | null,
  unitId:         string | null,
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('conversations')
    .update({ property_id: propertyId, unit_id: unitId })
    .eq('tenant_id', tenantId)
    .eq('id', conversationId)

  if (error) throw new Error(error.message)
}

export async function updateLeadStatus(
  tenantId:       string,
  conversationId: string,
  status:         string,
  updatedBy:      string,
): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('conversations')
    .update({
      lead_status:             status,
      lead_status_updated_at:  new Date().toISOString(),
      lead_status_updated_by:  updatedBy,
    })
    .eq('tenant_id', tenantId)
    .eq('id', conversationId)
  if (error) throw new Error(error.message)
}

export async function validateContactInTenant(
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('id', contactId)
    .is('deleted_at', null)

  if (error) throw new Error(error.message)
  return (count ?? 0) > 0
}

export { validateWorkspaceInTenant } from './shared'

export async function validateAssigneeInTenant(
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from('tenant_users')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('id', userId)
    .eq('active', true)

  if (error) throw new Error(error.message)
  return (count ?? 0) > 0
}

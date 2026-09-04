import type { ConversationRow, ContactRow, ConversationStatus, AiMode } from '@orderflow/types'
import type { CreateConversationInput, UpdateConversationInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'

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

export async function reactivateConversationAi(
  tenantId:  string,
  id:        string,
  userId:    string,
): Promise<ConversationRow> {
  const supabase = await createClient()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('conversations')
    .update({
      ai_mode:               'autonomous',
      ai_auto_replies_count: 0,
      ai_handoff_reason:     null,
      ai_handoff_at:         null,
      ai_reactivated_at:     now,
      ai_reactivated_by:     userId,
      needs_human_attention:  false,
    })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
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

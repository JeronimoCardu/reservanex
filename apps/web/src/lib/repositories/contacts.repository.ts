import type { ContactRow } from '@orderflow/types'
import type { CreateContactInput, UpdateContactInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'

export type { ContactRow }

export async function listContacts(
  tenantId: string,
  opts?: { search?: string; limit?: number },
): Promise<ContactRow[]> {
  const supabase = await createClient()

  let query = supabase
    .from('contacts')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 500)

  if (opts?.search) {
    const q = `%${opts.search}%`
    query = query.or(`name.ilike.${q},email.ilike.${q},phone.ilike.${q}`)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getContactById(
  tenantId: string,
  id: string,
): Promise<ContactRow | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data
}

export async function createContact(
  tenantId: string,
  input: CreateContactInput,
): Promise<ContactRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      tenant_id: tenantId,
      name:      input.name ?? null,
      email:     input.email ?? null,
      phone:     input.phone ?? null,
      source:    input.source ?? 'manual',
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      if (error.message.includes('phone')) throw new Error('DUPLICATE_PHONE')
      if (error.message.includes('email')) throw new Error('DUPLICATE_EMAIL')
    }
    throw new Error(error.message)
  }
  return data
}

export async function updateContact(
  tenantId: string,
  id: string,
  input: UpdateContactInput,
): Promise<ContactRow> {
  const supabase = await createClient()

  const patch: {
    name?: string | null
    email?: string | null
    phone?: string | null
    source?: 'whatsapp' | 'website' | 'manual'
  } = {}

  if ('name' in input)   patch.name   = input.name   ?? null
  if ('email' in input)  patch.email  = input.email  ?? null
  if ('phone' in input)  patch.phone  = input.phone  ?? null
  if ('source' in input) patch.source = input.source

  const { data, error } = await supabase
    .from('contacts')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      if (error.message.includes('phone')) throw new Error('DUPLICATE_PHONE')
      if (error.message.includes('email')) throw new Error('DUPLICATE_EMAIL')
    }
    throw new Error(error.message)
  }
  return data
}

export async function archiveContact(tenantId: string, id: string): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('contacts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .is('deleted_at', null) // previene re-archivar

  if (error) throw new Error(error.message)
}

export async function hasActiveConversations(
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('contact_id', contactId)
    .in('status', ['open', 'waiting'])

  if (error) throw new Error(error.message)
  return (count ?? 0) > 0
}

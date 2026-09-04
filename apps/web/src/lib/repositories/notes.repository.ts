import { createClient } from '@orderflow/supabase/server'

// ─── Shared types ────────────────────────────────────────────────────────────

export type NoteWithAuthor = {
  id:         string
  content:    string
  created_at: string
  created_by: string | null
  deleted_at: string | null
  author:     { id: string; name: string } | null
}

// ─── General listNotes (used by contacts and conversations pages) ─────────────

export async function listNotes(
  tenantId: string,
  options: {
    contactId?:      string
    conversationId?: string
    reservationId?:  string
  },
): Promise<NoteWithAuthor[]> {
  const supabase = await createClient()

  let query = supabase
    .from('notes')
    .select('id, content, created_at, created_by, deleted_at, author:tenant_users(id, name)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (options.contactId)      query = query.eq('contact_id', options.contactId)
  if (options.conversationId) query = query.eq('conversation_id', options.conversationId)
  if (options.reservationId)  query = query.eq('reservation_id', options.reservationId)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as NoteWithAuthor[]
}

// ─── Reservation-specific helpers ────────────────────────────────────────────

export type NoteRow = NoteWithAuthor

export async function listReservationNotes(
  tenantId:      string,
  reservationId: string,
): Promise<NoteWithAuthor[]> {
  return listNotes(tenantId, { reservationId })
}

export async function createReservationNote(
  tenantId:      string,
  reservationId: string,
  content:       string,
  createdById:   string,
): Promise<NoteWithAuthor> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('notes')
    .insert({
      tenant_id:      tenantId,
      reservation_id: reservationId,
      content,
      created_by:     createdById,
    })
    .select('id, content, created_at, created_by, deleted_at, author:tenant_users(id, name)')
    .single()

  if (error) throw new Error(error.message)
  return data as unknown as NoteWithAuthor
}

export async function deleteReservationNote(
  tenantId: string,
  noteId:   string,
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('notes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', noteId)
    .is('deleted_at', null)

  if (error) throw new Error(error.message)
}

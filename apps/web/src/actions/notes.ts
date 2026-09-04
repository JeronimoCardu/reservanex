'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createClient } from '@orderflow/supabase/server'
import * as notesRepo from '@/lib/repositories/notes.repository'
import * as eventsRepo from '@/lib/repositories/reservation-events.repository'
import type { ActionResult } from '@/lib/action-result'
import type { NoteWithAuthor } from '@/lib/repositories/notes.repository'

// ─── General note creation (contacts + conversations) ────────────────────────

const createNoteSchema = z.object({
  content:         z.string().min(1, 'La nota no puede estar vacía').max(5000),
  contact_id:      z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  reservation_id:  z.string().uuid().optional(),
})

export async function createNoteAction(input: unknown): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const parsed = createNoteSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const supabase = await createClient()

  // PERM-02: validar que cada FK opcional pertenezca al tenant y sea accesible al caller.
  // La query de conversations usa createClient() (sesión del usuario) — respeta RLS,
  // por lo que un receptionist solo puede crear notas en conversaciones que ya puede ver.
  if (parsed.data.conversation_id) {
    const { count } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('id', parsed.data.conversation_id)
    if (!count) return { success: false, error: 'Recurso no encontrado o sin permisos.' }
  }

  if (parsed.data.contact_id) {
    const { count } = await supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('id', parsed.data.contact_id)
      .is('deleted_at', null)
    if (!count) return { success: false, error: 'Recurso no encontrado o sin permisos.' }
  }

  if (parsed.data.reservation_id) {
    const { count } = await supabase
      .from('reservations')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('id', parsed.data.reservation_id)
      .is('deleted_at', null)
    if (!count) return { success: false, error: 'Recurso no encontrado o sin permisos.' }
  }

  const { error } = await supabase.from('notes').insert({
    tenant_id:       ctx.tenantId,
    content:         parsed.data.content,
    created_by:      ctx.userId,
    contact_id:      parsed.data.contact_id      ?? null,
    conversation_id: parsed.data.conversation_id ?? null,
    reservation_id:  parsed.data.reservation_id  ?? null,
  })

  if (error) return { success: false, error: 'Error al guardar la nota.' }

  revalidatePath('/dashboard')
  return { success: true }
}

// ─── Reservation-specific note actions ───────────────────────────────────────

const reservationNoteSchema = z.object({
  reservation_id: z.string().uuid(),
  content:        z.string().min(1, 'La nota no puede estar vacía').max(5000),
})

export async function createReservationNoteAction(
  input: unknown,
): Promise<ActionResult<NoteWithAuthor>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const parsed = reservationNoteSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { reservation_id, content } = parsed.data

  // PERM-02: validar que la reserva exista y pertenezca al tenant del caller.
  const supabase = await createClient()
  const { count } = await supabase
    .from('reservations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId)
    .eq('id', reservation_id)
    .is('deleted_at', null)

  if (!count) return { success: false, error: 'Recurso no encontrado o sin permisos.' }

  try {
    const note = await notesRepo.createReservationNote(
      ctx.tenantId,
      reservation_id,
      content,
      ctx.userId,
    )

    await eventsRepo.createReservationEvent(
      ctx.tenantId,
      reservation_id,
      ctx.userId,
      'note_created',
      { content_preview: content.slice(0, 100) },
    )

    revalidatePath('/dashboard/reservations')
    return { success: true, data: note }
  } catch {
    return { success: false, error: 'Error al guardar la nota.' }
  }
}

export async function deleteReservationNoteAction(
  noteId:        string,
  reservationId: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  // PERM-03: verificar que la nota exista, pertenezca a la reserva indicada,
  // y que el caller tenga permiso para eliminarla:
  //   - Owner: puede borrar cualquier nota del tenant.
  //   - Receptionist: solo puede borrar sus propias notas.
  const supabase = await createClient()
  const { data: note } = await supabase
    .from('notes')
    .select('id, created_by, reservation_id')
    .eq('tenant_id', ctx.tenantId)
    .eq('id', noteId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!note) {
    return { success: false, error: 'No tenés permiso para eliminar esta nota.' }
  }
  if (note.reservation_id !== reservationId) {
    return { success: false, error: 'No tenés permiso para eliminar esta nota.' }
  }
  if (ctx.role !== 'owner' && note.created_by !== ctx.userId) {
    return { success: false, error: 'No tenés permiso para eliminar esta nota.' }
  }

  try {
    await notesRepo.deleteReservationNote(ctx.tenantId, noteId)
    revalidatePath('/dashboard/reservations')
    return { success: true }
  } catch {
    return { success: false, error: 'Error al eliminar la nota.' }
  }
}

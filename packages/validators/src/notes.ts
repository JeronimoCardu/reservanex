import { z } from 'zod'

// B4: notes son append-only — solo existe createNoteSchema
export const createNoteSchema = z
  .object({
    content:         z.string().min(1, 'La nota no puede estar vacía').max(5000, 'Máximo 5000 caracteres'),
    contact_id:      z.string().uuid().optional(),
    conversation_id: z.string().uuid().optional(),
    reservation_id:  z.string().uuid().optional(),
  })
  .refine((d) => d.contact_id || d.conversation_id || d.reservation_id, {
    message: 'La nota necesita estar anclada a un contacto, conversación o reserva',
    path: ['contact_id'],
  })

export type CreateNoteInput = z.infer<typeof createNoteSchema>

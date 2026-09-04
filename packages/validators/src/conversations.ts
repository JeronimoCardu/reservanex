import { z } from 'zod'

// 'assisted' is a deprecated legacy value — the MVP only exposes manual and autonomous.
// The PostgreSQL enum still contains 'assisted' for backwards-compatibility with
// existing rows; the web app no longer creates or accepts it.
export const aiModeSchema = z.enum(['manual', 'autonomous'])

export const createConversationSchema = z.object({
  contact_id:   z.string().uuid('ID de contacto inválido'),
  workspace_id: z.string().uuid('ID de workspace inválido').optional(),
  channel:      z.enum(['whatsapp', 'manual']).default('manual'),
  source:       z.enum(['whatsapp_direct', 'website_button', 'manual']).default('manual'),
  ai_mode:      aiModeSchema.default('manual'),
})

export const updateConversationSchema = z.object({
  workspace_id: z.string().uuid().nullable().optional(),
})

export const assignConversationSchema = z.object({
  assigned_user_id: z.string().uuid('ID de usuario inválido').nullable(),
})

export const setAiModeSchema = z.object({
  mode: aiModeSchema,
})

export type CreateConversationInput = z.infer<typeof createConversationSchema>
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>
export type AssignConversationInput = z.infer<typeof assignConversationSchema>
export type SetAiModeInput          = z.infer<typeof setAiModeSchema>

import { z } from 'zod'

export const messageContentTypeSchema = z.enum(['text', 'image', 'document', 'audio', 'video'])

export const sendMessageSchema = z.object({
  content:      z.string().min(1, 'El mensaje no puede estar vacío').max(4000, 'Máximo 4000 caracteres'),
  content_type: messageContentTypeSchema.default('text'),
})

export type SendMessageInput = z.infer<typeof sendMessageSchema>

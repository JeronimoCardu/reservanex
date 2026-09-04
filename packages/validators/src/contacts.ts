import { z } from 'zod'

// "" / null → undefined para que el campo quede vacío sin fallar validación de email
const optionalEmail = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.string().email('Email inválido').max(200, 'Máximo 200 caracteres').optional(),
)

export const createContactSchema = z.object({
  name:   z.string().min(1, 'El nombre es requerido').max(200, 'Máximo 200 caracteres'),
  phone:  z.string().min(1, 'El teléfono es requerido').max(50, 'Máximo 50 caracteres'),
  email:  optionalEmail,
  source: z.enum(['whatsapp', 'website', 'manual']).default('manual'),
})

export const updateContactSchema = z.object({
  name:   z.string().min(1, 'El nombre es requerido').max(200, 'Máximo 200 caracteres').optional(),
  phone:  z.string().min(1, 'El teléfono es requerido').max(50, 'Máximo 50 caracteres').optional(),
  email:  optionalEmail,
  source: z.enum(['whatsapp', 'website', 'manual']).optional(),
})

export type CreateContactInput = z.infer<typeof createContactSchema>
export type UpdateContactInput = z.infer<typeof updateContactSchema>

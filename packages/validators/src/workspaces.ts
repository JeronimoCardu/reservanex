import { z } from 'zod'

export const workspaceTypeSchema = z.enum([
  'general',
  'physical_branch',
  'zone',
  'team',
])

export const createWorkspaceSchema = z.object({
  name: z
    .string({ required_error: 'El nombre es requerido' })
    .min(1, 'El nombre es requerido')
    .max(100, 'Máximo 100 caracteres'),
  type: workspaceTypeSchema,
  city: z.string().max(100, 'Máximo 100 caracteres').optional(),
  address: z.string().max(200, 'Máximo 200 caracteres').optional(),
  phone: z.string().max(50, 'Máximo 50 caracteres').optional(),
  email: z
    .union([z.string().email('Email inválido').max(200), z.literal('')])
    .optional(),
})

export const updateWorkspaceSchema = z.object({
  name: z
    .string()
    .min(1, 'El nombre es requerido')
    .max(100, 'Máximo 100 caracteres')
    .optional(),
  type: workspaceTypeSchema.optional(),
  city: z.string().max(100, 'Máximo 100 caracteres').optional(),
  address: z.string().max(200, 'Máximo 200 caracteres').optional(),
  phone: z.string().max(50, 'Máximo 50 caracteres').optional(),
  email: z
    .union([z.string().email('Email inválido').max(200), z.literal('')])
    .optional(),
})

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>

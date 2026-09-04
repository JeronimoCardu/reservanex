import { z } from 'zod'

export const tenantRoleSchema = z.enum(['owner', 'receptionist'])

export const createTenantUserSchema = z.object({
  name: z
    .string({ required_error: 'El nombre es requerido' })
    .min(1, 'El nombre es requerido')
    .max(200, 'Máximo 200 caracteres'),
  email: z
    .string({ required_error: 'El email es requerido' })
    .email('Email inválido')
    .max(200, 'Máximo 200 caracteres'),
  role: tenantRoleSchema,
  workspaceIds: z.array(z.string().uuid()).optional(),
})

export const updateTenantUserSchema = z.object({
  name: z
    .string()
    .min(1, 'El nombre es requerido')
    .max(200, 'Máximo 200 caracteres')
    .optional(),
  role: tenantRoleSchema.optional(),
})

export const assignWorkspacesSchema = z.object({
  workspaceIds: z.array(z.string().uuid()),
})

export type CreateTenantUserInput = z.infer<typeof createTenantUserSchema>
export type UpdateTenantUserInput = z.infer<typeof updateTenantUserSchema>
export type AssignWorkspacesInput = z.infer<typeof assignWorkspacesSchema>

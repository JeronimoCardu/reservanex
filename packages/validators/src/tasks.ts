import { z } from 'zod'

export const taskStatusSchema   = z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
export const taskPrioritySchema = z.enum(['low', 'medium', 'high'])

export const createTaskSchema = z.object({
  title:           z.string({ required_error: 'El título es requerido' }).min(1).max(300, 'Máximo 300 caracteres'),
  description:     z.string().max(2000, 'Máximo 2000 caracteres').optional(),
  priority:        taskPrioritySchema.default('medium'),
  due_date:        z.string().optional(),
  assigned_to:     z.string().uuid('ID de usuario inválido').optional(),
  contact_id:      z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
})

export const updateTaskSchema = z.object({
  title:           z.string().min(1).max(300).optional(),
  description:     z.string().max(2000).optional(),
  priority:        taskPrioritySchema.optional(),
  due_date:        z.string().nullable().optional(),
  assigned_to:     z.string().uuid().nullable().optional(),
  contact_id:      z.string().uuid().nullable().optional(),
  conversation_id: z.string().uuid().nullable().optional(),
})

export const updateTaskStatusSchema = z.object({
  status: taskStatusSchema,
})

export type CreateTaskInput       = z.infer<typeof createTaskSchema>
export type UpdateTaskInput       = z.infer<typeof updateTaskSchema>
export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusSchema>
export type TaskStatus            = z.infer<typeof taskStatusSchema>
export type TaskPriority          = z.infer<typeof taskPrioritySchema>

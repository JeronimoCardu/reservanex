import { z } from 'zod'

export const currencySchema = z.enum(['ARS', 'USD', 'EUR', 'BRL'])

export const createUnitSchema = z.object({
  name: z
    .string({ required_error: 'El nombre es requerido' })
    .min(1, 'El nombre es requerido')
    .max(200, 'Máximo 200 caracteres'),
  capacity: z.coerce
    .number({ invalid_type_error: 'La capacidad es requerida' })
    .int('Debe ser un número entero')
    .min(1, 'Mínimo 1')
    .max(999, 'Máximo 999'),
  price: z.preprocess(
    (v) => (v === '' || v == null ? undefined : Number(v)),
    z.number().min(0, 'Mínimo 0').max(99999999, 'Máximo 99.999.999').optional(),
  ),
  currency: currencySchema.default('ARS'),
})

export const updateUnitSchema = z.object({
  name:     z.string().min(1, 'El nombre es requerido').max(200, 'Máximo 200 caracteres').optional(),
  capacity: z.coerce.number().int().min(1, 'Mínimo 1').max(999, 'Máximo 999').optional(),
  price:    z.preprocess(
    (v) => (v === '' || v == null ? undefined : Number(v)),
    z.number().min(0).max(99999999).optional(),
  ),
  currency: currencySchema.optional(),
})

export type CreateUnitInput = z.infer<typeof createUnitSchema>
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>

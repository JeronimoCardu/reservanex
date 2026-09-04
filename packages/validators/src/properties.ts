import { z } from 'zod'

const positiveIntOpt = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().int().min(1, 'Debe ser mayor a 0').optional(),
)

const positiveNumOpt = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().positive('Debe ser mayor a 0').optional(),
)

const optionalUrl = (label: string) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().url(`URL de ${label} inválida`).max(1000).optional(),
  )

export const customFieldSchema = z.object({
  key:   z.string().min(1, 'La clave no puede estar vacía').max(100),
  value: z.string().min(1, 'El valor no puede estar vacío').max(500),
})

export const propertyImageSchema = z.object({
  url:          z.string().url('URL de imagen inválida').max(1000),
  alt:          z.string().max(200).optional(),
  storage_path: z.string().optional(),
})

export const createPropertySchema = z.object({
  title: z
    .string({ required_error: 'El título es requerido' })
    .min(1, 'El título es requerido')
    .max(200, 'Máximo 200 caracteres'),

  description: z.string().max(2000, 'Máximo 2000 caracteres').optional(),

  location_label: z
    .string({ required_error: 'La ubicación es requerida' })
    .min(1, 'La ubicación es requerida')
    .max(300, 'Máximo 300 caracteres'),

  internal_address: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().max(300, 'Máximo 300 caracteres').optional(),
  ),

  google_maps_url:          optionalUrl('Google Maps'),
  cover_image_url:          optionalUrl('foto principal'),
  cover_image_storage_path: z.string().optional(),

  capacity: positiveIntOpt,
  area_m2:  positiveNumOpt,

  custom_fields: z
    .array(customFieldSchema)
    .optional()
    .default([]),

  images: z
    .array(propertyImageSchema)
    .optional()
    .default([]),

  // ── Operation type & pricing ────────────────────────────────────────────────
  operation_type: z.enum(['sale', 'long_term_rental', 'temporary_rental']).default('temporary_rental'),
  pricing_mode:   z.enum(['fixed', 'consult']).default('consult'),
  currency:       z.string().regex(/^[A-Z]{3}$/, 'Moneda inválida').default('ARS'),
  show_price_public: z.boolean().default(true),

  // Sale
  // null means "explicitly cleared"; undefined means "not submitted" (partial update)
  sale_price: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : Number(v)),
    z.number().positive().nullable().optional(),
  ),

  // Long-term
  monthly_rent_price: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : Number(v)),
    z.number().positive().nullable().optional(),
  ),
  expenses_amount: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : Number(v)),
    z.number().min(0).nullable().optional(),
  ),
  long_term_deposit_amount: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : Number(v)),
    z.number().min(0).nullable().optional(),
  ),
  long_term_price_notes: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : v),
    z.string().max(500).nullable().optional(),
  ),

  // Temporary
  base_price_per_night: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : Number(v)),
    z.number().positive().nullable().optional(),
  ),
  minimum_stay_nights: z.preprocess(v => (v === '' || v == null ? undefined : Number(v)), z.number().int().min(1).default(1)),
  cleaning_fee:        z.preprocess(v => (v === '' || v == null ? 0 : Number(v)), z.number().min(0).default(0)),
  temporary_deposit_amount: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : Number(v)),
    z.number().min(0).nullable().optional(),
  ),
  temporary_deposit_percent: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : Number(v)),
    z.number().min(0.01).max(100).nullable().optional(),
  ),
  temporary_price_notes: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : v),
    z.string().max(500).nullable().optional(),
  ),

  check_in_time: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : v),
    z.string().max(8).nullable().optional(),
  ),
  check_out_time: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : v),
    z.string().max(8).nullable().optional(),
  ),

  // ── Public site ────────────────────────────────────────────────────────────
  published: z.boolean().optional(),
  slug: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : String(v).toLowerCase().trim()),
    z.string().max(200).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Solo letras minúsculas, números y guiones').nullable().optional(),
  ),
  public_code: z.preprocess(
    v => v === undefined ? undefined : (v === '' || v === null ? null : v),
    z.string().max(20).nullable().optional(),
  ),
  show_exact_address_public: z.boolean().optional(),
})

export const updatePropertySchema = createPropertySchema.partial()

export type CreatePropertyInput = z.infer<typeof createPropertySchema>
export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>

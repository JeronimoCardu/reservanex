import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════════
// Fase 3A — Motor de formularios dinámicos.
//
// Este archivo es el CONTRATO de los formularios: qué campos existen, cuándo
// aparecen, y cómo se validan. Definiciones y validación viven juntas a
// propósito: si los campos que se renderizan y los que se validan vivieran en
// paquetes distintos, se desincronizarían silenciosamente y el servidor
// terminaría aceptando (o rechazando) algo distinto de lo que el cliente vio.
//
// El RENDER (Tailwind, inputs, layout) NO vive acá — eso es apps/web.
// Acá solo hay datos y reglas, sin dependencias de React ni del DOM.
// ═══════════════════════════════════════════════════════════════════════════

// ── Verticales ─────────────────────────────────────────────────────────────
// Dos, no quince. Se agregan cuando exista un rubro real, no antes.
// Debe coincidir EXACTAMENTE con el CHECK de tenants.vertical.
export const tenantVerticalSchema = z.enum(['real_estate', 'food_service'])

// ── Intents ────────────────────────────────────────────────────────────────
// Taxonomía centralizada. Ningún string suelto de intent en la app: todo
// pasa por acá. Debe coincidir con el CHECK de form_submissions.intent.
export const formIntentSchema = z.enum([
  // real_estate
  'property_inquiry',
  'property_visit',
  'monthly_rental_inquiry',
  'temporary_rental',
  // food_service
  'general_inquiry',
  'table_reservation',
  'food_order',
])

// De qué vertical es cada intent. Sirve para rechazar un intent que no
// corresponde al rubro del tenant (una inmobiliaria no recibe reservas de mesa).
const INTENT_VERTICAL: Record<FormIntent, TenantVertical> = {
  property_inquiry:       'real_estate',
  property_visit:         'real_estate',
  monthly_rental_inquiry: 'real_estate',
  temporary_rental:       'real_estate',
  general_inquiry:        'food_service',
  table_reservation:      'food_service',
  food_order:             'food_service',
}

export function verticalForIntent(intent: FormIntent): TenantVertical {
  return INTENT_VERTICAL[intent]
}

export function isIntentAllowedForVertical(intent: FormIntent, vertical: TenantVertical): boolean {
  return INTENT_VERTICAL[intent] === vertical
}

export function intentsForVertical(vertical: TenantVertical): FormIntent[] {
  return (Object.keys(INTENT_VERTICAL) as FormIntent[]).filter((i) => INTENT_VERTICAL[i] === vertical)
}

// ── De dónde salió el formulario ───────────────────────────────────────────
// Lo mínimo para saber el origen de la operación. NO es tracking de marketing.
export const formSourceSchema = z.enum(['public_site', 'ai_whatsapp', 'direct_link'])

// ── Estados de submission ──────────────────────────────────────────────────
// Fase 3A opera realmente solo con 'submitted'. Los demás existen para que la
// máquina de estados esté completa desde el principio y 3B no tenga que
// migrar. OJO: 'confirmed' acá significa "el cliente confirmó los datos por
// WhatsApp", NO "la reserva está confirmada" — son cosas distintas.
export const submissionStatusSchema = z.enum([
  'draft',
  'submitted',
  'confirmed',
  'expired',
  'cancelled',
])

// ── Campos ─────────────────────────────────────────────────────────────────

export const formFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'date',
  'time',
  'number',
  'select',
  'boolean',
])

export interface FormFieldOption {
  value: string
  label: string
}

// Condición para mostrar un campo. Deliberadamente mínima: un campo depende
// de UN campo anterior con UN valor esperado. Alcanza para delivery→address y
// has_pets→pet_details, y no es un motor de reglas que nadie pueda mantener.
// Si algún día hace falta AND/OR, se amplía acá y en evaluateFieldVisibility.
export interface FormFieldCondition {
  field:  string
  equals: string | number | boolean
}

export interface FormField {
  name:         string
  type:         z.infer<typeof formFieldTypeSchema>
  label:        string
  placeholder?: string
  help?:        string
  required:     boolean
  options?:     FormFieldOption[]
  min?:         number
  max?:         number
  showIf?:      FormFieldCondition
}

export interface FormDefinition {
  intent:      FormIntent
  vertical:    TenantVertical
  title:       string
  description: string
  submitLabel: string
  fields:      FormField[]
}

// ── Campos reutilizados ────────────────────────────────────────────────────
// PRINCIPIO: pedir la menor cantidad de datos posible. No pedimos teléfono ni
// email — el teléfono lo obtenemos de WhatsApp cuando la conversación llega
// (Fase 3B), y el email no lo necesita ninguna de estas operaciones.

const nameField: FormField = {
  name:        'name',
  type:        'text',
  label:       'Tu nombre',
  placeholder: 'Nombre y apellido',
  required:    true,
}

const notesField: FormField = {
  name:        'notes',
  type:        'textarea',
  label:       'Observaciones',
  placeholder: '¿Algo que debamos tener en cuenta?',
  required:    false,
}

// ── Definiciones ───────────────────────────────────────────────────────────

const DEFINITIONS: Record<FormIntent, FormDefinition> = {
  temporary_rental: {
    intent:      'temporary_rental',
    vertical:    'real_estate',
    title:       'Consultar disponibilidad',
    description: 'Contanos las fechas y en breve te confirmamos.',
    submitLabel: 'Enviar consulta',
    fields: [
      nameField,
      { name: 'check_in',  type: 'date',   label: 'Check-in',  required: true },
      { name: 'check_out', type: 'date',   label: 'Check-out', required: true },
      { name: 'adults',    type: 'number', label: 'Adultos',   required: true,  min: 1,  max: 30 },
      { name: 'children',  type: 'number', label: 'Niños',     required: false, min: 0,  max: 30 },
      { name: 'infants',   type: 'number', label: 'Bebés',     required: false, min: 0,  max: 10 },
      { name: 'has_pets',  type: 'boolean', label: '¿Viajás con mascotas?', required: false },
      {
        name:     'pet_details',
        type:     'text',
        label:    '¿Qué mascotas?',
        placeholder: 'Ej: un perro chico',
        required: false,
        showIf:   { field: 'has_pets', equals: true },
      },
      notesField,
    ],
  },

  property_visit: {
    intent:      'property_visit',
    vertical:    'real_estate',
    title:       'Coordinar una visita',
    description: 'Decinos cuándo te queda cómodo y te contactamos para confirmar.',
    submitLabel: 'Solicitar visita',
    fields: [
      nameField,
      { name: 'preferred_date', type: 'date', label: 'Día preferido', required: true },
      {
        name:     'preferred_time_range',
        type:     'select',
        label:    'Horario preferido',
        required: true,
        options: [
          { value: 'morning',   label: 'Mañana (9 a 12)' },
          { value: 'afternoon', label: 'Tarde (12 a 18)' },
          { value: 'evening',   label: 'Tardecita (18 a 20)' },
        ],
      },
      notesField,
    ],
  },

  property_inquiry: {
    intent:      'property_inquiry',
    vertical:    'real_estate',
    title:       'Consultar por esta propiedad',
    description: 'Dejanos tu consulta y te respondemos a la brevedad.',
    submitLabel: 'Enviar consulta',
    fields: [
      nameField,
      { name: 'message', type: 'textarea', label: 'Tu consulta', placeholder: '¿Qué querés saber?', required: true },
    ],
  },

  monthly_rental_inquiry: {
    intent:      'monthly_rental_inquiry',
    vertical:    'real_estate',
    title:       'Consultar alquiler mensual',
    description: 'Contanos qué buscás y te respondemos a la brevedad.',
    submitLabel: 'Enviar consulta',
    fields: [
      nameField,
      { name: 'move_in_date', type: 'date',   label: 'Fecha estimada de mudanza', required: false },
      { name: 'occupants',    type: 'number', label: '¿Cuántas personas vivirían?', required: false, min: 1, max: 30 },
      notesField,
    ],
  },

  table_reservation: {
    intent:      'table_reservation',
    vertical:    'food_service',
    title:       'Reservar una mesa',
    description: 'Elegí día, hora y cuántos son.',
    submitLabel: 'Solicitar reserva',
    fields: [
      nameField,
      { name: 'date',   type: 'date',   label: 'Fecha',              required: true },
      { name: 'time',   type: 'time',   label: 'Hora',               required: true },
      { name: 'people', type: 'number', label: 'Cantidad de personas', required: true, min: 1, max: 50 },
      notesField,
    ],
  },

  general_inquiry: {
    intent:      'general_inquiry',
    vertical:    'food_service',
    title:       'Hacernos una consulta',
    description: 'Dejanos tu mensaje y te respondemos.',
    submitLabel: 'Enviar consulta',
    fields: [
      nameField,
      { name: 'message', type: 'textarea', label: 'Tu consulta', required: true },
    ],
  },

  // Fase 3A NO construye el carrito. Lo que sí queda demostrado acá es que el
  // motor soporta la forma que food_order va a necesitar: fulfillment con un
  // campo condicional (address solo si es delivery) y método de pago. Los
  // items/cantidades/variantes llegan en 3B+ como una lista en el payload —
  // el schema de payload ya la acepta opcionalmente (ver foodOrderPayload).
  food_order: {
    intent:      'food_order',
    vertical:    'food_service',
    title:       'Hacer un pedido',
    description: 'Contanos qué necesitás y cómo lo querés recibir.',
    submitLabel: 'Enviar pedido',
    fields: [
      nameField,
      {
        name:     'fulfillment',
        type:     'select',
        label:    '¿Cómo lo querés recibir?',
        required: true,
        options: [
          { value: 'delivery', label: 'Delivery' },
          { value: 'takeaway', label: 'Retiro en el local' },
        ],
      },
      {
        name:        'address',
        type:        'text',
        label:       'Dirección de entrega',
        placeholder: 'Calle, número, piso/depto',
        required:    true,
        showIf:      { field: 'fulfillment', equals: 'delivery' },
      },
      {
        name:     'payment_method',
        type:     'select',
        label:    'Método de pago',
        required: true,
        options: [
          { value: 'cash',     label: 'Efectivo' },
          { value: 'transfer', label: 'Transferencia' },
          { value: 'card',     label: 'Tarjeta' },
        ],
      },
      notesField,
    ],
  },
}

// §13 — las definiciones viven en código tipado. No hay form builder para el
// owner todavía; queremos formularios consistentes y seguros primero.
export function getFormDefinition(params: { intent: FormIntent }): FormDefinition {
  return DEFINITIONS[params.intent]
}

// ── Visibilidad condicional ────────────────────────────────────────────────
// Una sola función, usada por el render Y por la validación. Que las dos
// caras usen exactamente la misma lógica es lo que evita que el servidor
// exija un campo que el cliente nunca mostró.
export function isFieldVisible(field: FormField, values: Record<string, unknown>): boolean {
  if (!field.showIf) return true
  return values[field.showIf.field] === field.showIf.equals
}

export function visibleFields(definition: FormDefinition, values: Record<string, unknown>): FormField[] {
  return definition.fields.filter((f) => isFieldVisible(f, values))
}

// ── Validación del payload ─────────────────────────────────────────────────
// Server-side, por intent. Nunca confiamos en la validación del browser.

const nameValue  = z.string().trim().min(1, 'Necesitamos tu nombre.').max(120, 'El nombre es demasiado largo.')
const notesValue = z.string().trim().max(1000, 'Las observaciones son demasiado largas.').optional()
const isoDate    = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida.')
const isoTime    = z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida.')

const temporaryRentalPayload = z.object({
  name:        nameValue,
  check_in:    isoDate,
  check_out:   isoDate,
  adults:      z.coerce.number().int().min(1, 'Tiene que haber al menos un adulto.').max(30),
  children:    z.coerce.number().int().min(0).max(30).optional(),
  infants:     z.coerce.number().int().min(0).max(10).optional(),
  has_pets:    z.boolean().optional(),
  pet_details: z.string().trim().max(200).optional(),
  notes:       notesValue,
})
  .refine((v) => v.check_out > v.check_in, {
    message: 'El check-out tiene que ser posterior al check-in.',
    path:    ['check_out'],
  })
  // Coherencia del campo condicional: si no viaja con mascotas, no puede
  // mandar el detalle (sería un campo que el formulario nunca le mostró).
  .refine((v) => v.has_pets === true || !v.pet_details, {
    message: 'No corresponde detallar mascotas.',
    path:    ['pet_details'],
  })

const propertyVisitPayload = z.object({
  name:                 nameValue,
  preferred_date:       isoDate,
  preferred_time_range: z.enum(['morning', 'afternoon', 'evening']),
  notes:                notesValue,
})

const propertyInquiryPayload = z.object({
  name:    nameValue,
  message: z.string().trim().min(1, 'Escribinos tu consulta.').max(1000),
})

const monthlyRentalInquiryPayload = z.object({
  name:         nameValue,
  move_in_date: isoDate.optional(),
  occupants:    z.coerce.number().int().min(1).max(30).optional(),
  notes:        notesValue,
})

const tableReservationPayload = z.object({
  name:   nameValue,
  date:   isoDate,
  time:   isoTime,
  people: z.coerce.number().int().min(1, 'Tiene que ser al menos una persona.').max(50),
  notes:  notesValue,
})

const generalInquiryPayload = z.object({
  name:    nameValue,
  message: z.string().trim().min(1, 'Escribinos tu consulta.').max(1000),
})

const foodOrderPayload = z.object({
  name:           nameValue,
  fulfillment:    z.enum(['delivery', 'takeaway']),
  address:        z.string().trim().max(300).optional(),
  payment_method: z.enum(['cash', 'transfer', 'card']),
  notes:          notesValue,
  // Todavía sin carrito (Fase 3A). La forma queda aceptada para que 3B+ pueda
  // empezar a mandar items sin migrar el schema ni la tabla.
  items: z.array(z.object({
    name:     z.string().trim().min(1).max(200),
    quantity: z.coerce.number().int().min(1).max(99),
    variant:  z.string().trim().max(120).optional(),
    notes:    z.string().trim().max(300).optional(),
  })).max(100).optional(),
})
  .refine((v) => v.fulfillment !== 'delivery' || (v.address && v.address.length > 0), {
    message: 'Necesitamos la dirección para el delivery.',
    path:    ['address'],
  })
  .refine((v) => v.fulfillment === 'delivery' || !v.address, {
    message: 'No corresponde una dirección para retiro en el local.',
    path:    ['address'],
  })

const PAYLOAD_SCHEMAS = {
  temporary_rental:       temporaryRentalPayload,
  property_visit:         propertyVisitPayload,
  property_inquiry:       propertyInquiryPayload,
  monthly_rental_inquiry: monthlyRentalInquiryPayload,
  table_reservation:      tableReservationPayload,
  general_inquiry:        generalInquiryPayload,
  food_order:             foodOrderPayload,
} as const

export function getPayloadSchema(intent: FormIntent) {
  return PAYLOAD_SCHEMAS[intent]
}

// Valida un payload contra el intent que dice ser. Devuelve el objeto ya
// parseado (con los number coercionados) o los errores por campo.
export function validateSubmissionPayload(
  intent:  FormIntent,
  payload: unknown,
):
  | { ok: true;  data: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> } {
  const parsed = PAYLOAD_SCHEMAS[intent].safeParse(payload)
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> }

  const errors: Record<string, string> = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.') || '_form'
    if (!errors[key]) errors[key] = issue.message
  }
  return { ok: false, errors }
}

// ── Request pública ────────────────────────────────────────────────────────
// Lo que el browser manda. Nunca incluye tenant_id: el servidor resuelve el
// tenant desde el slug público. Un id de tenant enviado por el cliente sería
// confiar en el browser para el aislamiento multi-tenant.
export const createSubmissionRequestSchema = z.object({
  tenant_slug:     z.string().trim().min(1).max(120),
  intent:          formIntentSchema,
  source:          formSourceSchema.default('public_site'),
  // Referencia pública de la publicación que originó el formulario
  // (properties.public_code, formato OF-XXXXXX). Opcional: un formulario
  // genérico del tenant no viene de ninguna publicación.
  publication_ref: z.string().trim().regex(/^OF-[A-Z0-9]{6}$/i, 'Referencia inválida.').optional(),
  idempotency_key: z.string().trim().uuid('Clave de idempotencia inválida.'),
  payload:         z.record(z.unknown()),
})

// ── Tipos ──────────────────────────────────────────────────────────────────

export type TenantVertical           = z.infer<typeof tenantVerticalSchema>
export type FormIntent               = z.infer<typeof formIntentSchema>
export type FormSource               = z.infer<typeof formSourceSchema>
export type SubmissionStatus         = z.infer<typeof submissionStatusSchema>
export type FormFieldType            = z.infer<typeof formFieldTypeSchema>
export type CreateSubmissionRequest  = z.infer<typeof createSubmissionRequestSchema>

// Fase 3D — cómo se muestra una solicitud.
//
// Los labels de los campos NO se duplican acá: salen de las FormDefinitions
// reales de @orderflow/validators, el mismo módulo que definió el formulario
// que completó el cliente y que validó el servidor. apps/web sí puede
// importarlo (a diferencia del worker, que no tiene deps de workspace en
// runtime y por eso tiene su copia con un test que la fija).
//
// Consecuencia práctica: si mañana se renombra un campo del formulario, la
// bandeja lo muestra con el nombre nuevo sin tocar nada acá.

import {
  formIntentSchema,
  getFormDefinition,
  isFieldVisible,
  type FormIntent,
} from '@orderflow/validators'

export type OperationKind =
  | 'reservation_request'
  | 'visit_request'
  | 'table_request'
  | 'order_request'
  | 'inquiry'

export type OperationStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled'

// Qué es la solicitud, en el idioma del producto.
export const KIND_LABELS: Record<OperationKind, string> = {
  reservation_request: 'Solicitud de reserva',
  visit_request:       'Solicitud de visita',
  table_request:       'Solicitud de mesa',
  order_request:       'Pedido',
  inquiry:             'Consulta',
}

// El estado, en términos de negocio. "Aprobada" y no "confirmed": lo que el
// owner ve es su propia decisión, no el nombre de la columna.
export const STATUS_LABELS: Record<OperationStatus, string> = {
  pending:   'Pendiente',
  confirmed: 'Aprobada',
  rejected:  'Rechazada',
  cancelled: 'Cancelada',
}

// Fase 3E-B1 — el estado interno es el mismo para todos los kinds
// (pending/confirmed/rejected, sin migrar el enum), pero lo que significa NO lo
// es: "Consulta aprobada" no quiere decir nada. Una consulta se gestiona o se
// descarta; una reserva se aprueba o se rechaza.
//
// Solo se sobrescribe lo que difiere. Lo que no está acá cae en STATUS_LABELS.
const STATUS_LABELS_BY_KIND: Partial<
  Record<OperationKind, Partial<Record<OperationStatus, string>>>
> = {
  inquiry: {
    confirmed: 'Gestionada',
    rejected:  'Descartada',
  },
  // visit_request queda deliberadamente sin override: su label depende de si
  // una visita aprobada se materializa como visita agendada, y eso se decide en
  // 3E-B2. Hasta entonces muestra "Aprobada", igual que antes de esta fase.
}

// Los verbos de los botones, por kind. Mismo criterio: el estado interno no
// cambia, la acción que el usuario cree que está haciendo sí.
interface DecisionActions {
  confirm:       string
  reject:        string
  /** Título del diálogo de confirmación. */
  confirmTitle:  string
  rejectTitle:   string
  /** Qué se le explica antes de decidir. */
  confirmBody:   string
  rejectBody:    string
  /** Cómo se llama el campo de notas. */
  notesLabel:    string
}

const DECISION_ACTIONS_DEFAULT: DecisionActions = {
  confirm:      'Aprobar',
  reject:       'Rechazar',
  confirmTitle: 'Aprobar solicitud',
  rejectTitle:  'Rechazar solicitud',
  confirmBody:  'La solicitud queda aprobada y el cliente pasa a estar a la espera de la confirmación de la empresa.',
  rejectBody:   'La solicitud queda rechazada. No se crea ninguna reserva.',
  notesLabel:   'Motivo (opcional)',
}

const DECISION_ACTIONS_BY_KIND: Partial<Record<OperationKind, DecisionActions>> = {
  inquiry: {
    confirm:      'Marcar como gestionada',
    reject:       'Descartar',
    confirmTitle: 'Marcar la consulta como gestionada',
    rejectTitle:  'Descartar la consulta',
    confirmBody:  'Queda registrado que ya atendiste esta consulta. No se crea ninguna reserva ni ninguna otra operación.',
    rejectBody:   'La consulta queda descartada. No se crea ni se modifica nada más.',
    notesLabel:   'Nota interna (opcional)',
  },
}

export function decisionActions(kind: string): DecisionActions {
  return DECISION_ACTIONS_BY_KIND[kind as OperationKind] ?? DECISION_ACTIONS_DEFAULT
}

/** true si la solicitud es una consulta: no materializa ninguna entidad. */
export function isInquiry(kind: string): boolean {
  return kind === 'inquiry'
}

export const STATUS_TONE: Record<OperationStatus, 'amber' | 'green' | 'red' | 'zinc'> = {
  pending:   'amber',
  confirmed: 'green',
  rejected:  'red',
  cancelled: 'zinc',
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as OperationKind] ?? kind
}

/**
 * Estado en el idioma del kind.
 *
 * `kind` es opcional a propósito: hay lugares —el filtro de la bandeja, por
 * ejemplo— donde el estado se muestra sin una solicitud concreta detrás. Sin
 * kind se usa el vocabulario genérico, que es el de reservas.
 */
export function statusLabel(status: string, kind?: string): string {
  const byKind = kind
    ? STATUS_LABELS_BY_KIND[kind as OperationKind]?.[status as OperationStatus]
    : undefined
  return byKind ?? STATUS_LABELS[status as OperationStatus] ?? status
}

export function statusTone(status: string): 'amber' | 'green' | 'red' | 'zinc' {
  return STATUS_TONE[status as OperationStatus] ?? 'zinc'
}

// ── Resumen legible del snapshot ────────────────────────────────────────────

export interface SnapshotLine {
  label: string
  value: string
}

function formatIsoDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return value
  // Se parten los componentes en vez de construir un Date: un huso al oeste
  // mostraría el día anterior. Mismo criterio que el resumen del worker.
  return `${m[3]}/${m[2]}/${m[1]}`
}

/**
 * Convierte payload_snapshot en líneas legibles, en el orden del formulario.
 *
 * §2 y §12: el JSON crudo no es la UX. Se recorren SOLO los campos de la
 * definición, así que una clave extra en el snapshot no puede filtrarse a la
 * pantalla, y los campos condicionales ocultos no se muestran.
 */
export function buildSnapshotLines(
  intent: string,
  snapshot: Record<string, unknown> | null | undefined,
  /**
   * Fase 3E-B1 — si se pasa, se emiten SOLO esos campos, en el orden del
   * formulario. Lo usa la fila de la bandeja para destacar dos o tres datos sin
   * abrir el detalle, sin reimplementar el formateo de valores.
   */
  onlyFields?: readonly string[],
): SnapshotLine[] {
  const parsed = formIntentSchema.safeParse(intent)
  const payload = snapshot ?? {}

  // Un intent que no reconocemos no debería existir (la DB tiene un CHECK),
  // pero si pasara, mejor mostrar los datos crudos que no mostrar nada.
  if (!parsed.success) {
    return Object.entries(payload).map(([k, v]) => ({ label: k, value: String(v) }))
  }

  const definition = getFormDefinition({ intent: parsed.data as FormIntent })
  const lines: SnapshotLine[] = []

  for (const field of definition.fields) {
    if (onlyFields && !onlyFields.includes(field.name)) continue
    if (!isFieldVisible(field, payload)) continue
    const raw = payload[field.name]
    if (raw === null || raw === undefined) continue

    let value: string
    if (field.type === 'boolean') {
      value = raw === true ? 'Sí' : 'No'
    } else if (field.type === 'select') {
      const opt = field.options?.find((o) => o.value === String(raw))
      value = opt ? opt.label : String(raw)
    } else {
      const text = String(raw).trim()
      if (text === '') continue
      value = field.type === 'date' ? formatIsoDate(text) : text
    }

    lines.push({ label: field.label, value })
  }

  return lines
}

// ── Qué tipo de solicitud es, para la fila ──────────────────────────────────
//
// Fase 3E-B1: property_inquiry y monthly_rental_inquiry comparten kind
// ('inquiry'), así que "Consulta" sola no distingue una de otra en el listado.
// Acá se afina por intent. Solo para consultas: reservas y visitas siguen
// usando su label de kind, sin cambios.
const INQUIRY_TYPE_LABELS: Record<string, string> = {
  property_inquiry:       'Consulta por propiedad',
  monthly_rental_inquiry: 'Consulta alquiler mensual',
  general_inquiry:        'Consulta general',
}

export function requestTypeLabel(kind: string, intent: string): string {
  if (isInquiry(kind)) return INQUIRY_TYPE_LABELS[intent] ?? kindLabel(kind)
  return kindLabel(kind)
}

// Qué datos del formulario vale la pena ver sin abrir el detalle. Se listan por
// nombre de campo; las etiquetas y el formato salen de la FormDefinition.
const ROW_HIGHLIGHT_FIELDS: Record<string, readonly string[]> = {
  monthly_rental_inquiry: ['move_in_date', 'occupants'],
}

/**
 * Líneas destacadas para la fila del listado. Vacío para los intents que no
 * declaran ninguno — property_inquiry no lo necesita: su único dato es el
 * mensaje, que va en el detalle.
 */
export function rowHighlights(
  intent: string,
  snapshot: Record<string, unknown> | null | undefined,
): SnapshotLine[] {
  const fields = ROW_HIGHLIGHT_FIELDS[intent]
  if (!fields) return []
  return buildSnapshotLines(intent, snapshot, fields)
}

/** Título corto de la definición del formulario, para el encabezado. */
export function intentTitle(intent: string): string {
  const parsed = formIntentSchema.safeParse(intent)
  if (!parsed.success) return intent
  return getFormDefinition({ intent: parsed.data as FormIntent }).title
}

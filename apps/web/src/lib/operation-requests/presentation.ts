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

export const STATUS_TONE: Record<OperationStatus, 'amber' | 'green' | 'red' | 'zinc'> = {
  pending:   'amber',
  confirmed: 'green',
  rejected:  'red',
  cancelled: 'zinc',
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as OperationKind] ?? kind
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as OperationStatus] ?? status
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

/** Título corto de la definición del formulario, para el encabezado. */
export function intentTitle(intent: string): string {
  const parsed = formIntentSchema.safeParse(intent)
  if (!parsed.success) return intent
  return getFormDefinition({ intent: parsed.data as FormIntent }).title
}

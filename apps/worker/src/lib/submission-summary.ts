// Fase 3B — resumen determinístico de una submission.
//
// §10 es tajante: el LLM NO puede inventar ni reinterpretar estos datos.
// "2 adultos" no puede volverse "3 personas", ni una fecha cambiar de
// formato/significado. Por eso el resumen se arma acá, con código, a partir
// de intent + payload validado + la definición del formulario. DeepSeek no
// participa: no se lo llama en este camino (§12).
//
// COPIA STANDALONE de los labels de packages/validators/src/forms.ts, por la
// misma razón que lib/phone.ts y lib/submission-reference.ts: el worker no
// tiene dependencias de workspace en runtime (@orderflow/types es
// devDependency porque es `import type` y se borra al compilar), y no hay
// config de deploy en el repo para verificar que agregar una no rompa nada.
//
// La tabla de abajo NO fue transcrita a mano: se generó desde las
// FormDefinitions reales. Y submission-summary.test.ts importa
// @orderflow/validators (devDependency, solo para tests) y compara campo por
// campo — nombre, label, orden, condición y opciones. Si alguien edita un
// formulario y no actualiza esta copia, el test del worker falla. La
// divergencia es imposible de pasar por alto, que es exactamente lo que §10
// necesita.

export type SummaryIntent =
  | 'property_inquiry'
  | 'property_visit'
  | 'monthly_rental_inquiry'
  | 'temporary_rental'
  | 'table_reservation'
  | 'general_inquiry'
  | 'food_order'

export interface SummaryFieldOption {
  value: string
  label: string
}

export interface SummaryField {
  name:     string
  label:    string
  type:     'text' | 'textarea' | 'date' | 'time' | 'number' | 'select' | 'boolean'
  showIf?:  { field: string; equals: string | number | boolean }
  options?: SummaryFieldOption[]
}

export const SUMMARY_FIELDS: Record<SummaryIntent, SummaryField[]> = {
  property_inquiry: [
    { name: "name", label: "Tu nombre", type: "text" },
    { name: "message", label: "Tu consulta", type: "textarea" },
  ],
  property_visit: [
    { name: "name", label: "Tu nombre", type: "text" },
    { name: "preferred_date", label: "Día preferido", type: "date" },
    { name: "preferred_time_range", label: "Horario preferido", type: "select", options: [{ value: "morning", label: "Mañana (9 a 12)" }, { value: "afternoon", label: "Tarde (12 a 18)" }, { value: "evening", label: "Tardecita (18 a 20)" }] },
    { name: "notes", label: "Observaciones", type: "textarea" },
  ],
  monthly_rental_inquiry: [
    { name: "name", label: "Tu nombre", type: "text" },
    { name: "move_in_date", label: "Fecha estimada de mudanza", type: "date" },
    { name: "occupants", label: "¿Cuántas personas vivirían?", type: "number" },
    { name: "notes", label: "Observaciones", type: "textarea" },
  ],
  temporary_rental: [
    { name: "name", label: "Tu nombre", type: "text" },
    { name: "check_in", label: "Check-in", type: "date" },
    { name: "check_out", label: "Check-out", type: "date" },
    { name: "adults", label: "Adultos", type: "number" },
    { name: "children", label: "Niños", type: "number" },
    { name: "infants", label: "Bebés", type: "number" },
    { name: "has_pets", label: "¿Viajás con mascotas?", type: "boolean" },
    { name: "pet_details", label: "¿Qué mascotas?", type: "text", showIf: { field: "has_pets", equals: true } },
    { name: "notes", label: "Observaciones", type: "textarea" },
  ],
  general_inquiry: [
    { name: "name", label: "Tu nombre", type: "text" },
    { name: "message", label: "Tu consulta", type: "textarea" },
  ],
  table_reservation: [
    { name: "name", label: "Tu nombre", type: "text" },
    { name: "date", label: "Fecha", type: "date" },
    { name: "time", label: "Hora", type: "time" },
    { name: "people", label: "Cantidad de personas", type: "number" },
    { name: "notes", label: "Observaciones", type: "textarea" },
  ],
  food_order: [
    { name: "name", label: "Tu nombre", type: "text" },
    { name: "fulfillment", label: "¿Cómo lo querés recibir?", type: "select", options: [{ value: "delivery", label: "Delivery" }, { value: "takeaway", label: "Retiro en el local" }] },
    { name: "address", label: "Dirección de entrega", type: "text", showIf: { field: "fulfillment", equals: "delivery" } },
    { name: "payment_method", label: "Método de pago", type: "select", options: [{ value: "cash", label: "Efectivo" }, { value: "transfer", label: "Transferencia" }, { value: "card", label: "Tarjeta" }] },
    { name: "notes", label: "Observaciones", type: "textarea" },
  ],
}

const SUMMARY_INTENTS = new Set<string>(Object.keys(SUMMARY_FIELDS))

export function isSummaryIntent(intent: string): intent is SummaryIntent {
  return SUMMARY_INTENTS.has(intent)
}

// Misma semántica que isFieldVisible() en packages/validators: comparación
// estricta contra UN campo anterior. Un campo condicional oculto NO se
// imprime (§10).
function isVisible(field: SummaryField, payload: Record<string, unknown>): boolean {
  if (!field.showIf) return true
  return payload[field.showIf.field] === field.showIf.equals
}

// Las fechas se guardan ISO (YYYY-MM-DD, validado por Zod en el formulario).
// Al cliente se le muestran como las escribió mentalmente: DD/MM/AAAA.
// Es un reformateo puro, sin zona horaria de por medio — se parten los
// componentes, NO se construye un Date, justamente para que un huso no pueda
// correr la fecha un día.
function formatIsoDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return value
  return `${m[3]}/${m[2]}/${m[1]}`
}

function formatValue(field: SummaryField, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null

  if (field.type === 'boolean') {
    // Un booleano SIEMPRE se muestra, incluso en false: "Mascotas: No" es
    // información que el cliente tiene que poder verificar.
    return raw === true ? 'Sí' : 'No'
  }

  if (field.type === 'select') {
    // Se muestra la etiqueta legible, no el valor interno: "Mañana (9 a 12)",
    // nunca "morning".
    const opt = field.options?.find((o) => o.value === String(raw))
    return opt ? opt.label : String(raw)
  }

  const text = String(raw).trim()
  if (text === '') return null

  if (field.type === 'date') return formatIsoDate(text)

  return text
}

export interface SubmissionSummaryLine {
  label: string
  value: string
  /**
   * El valor ocupa varias líneas y va DEBAJO del label, no al lado.
   *
   * Fase 3E-C3B1 — lo necesita el detalle del pedido: "Pedido: 2 × Muzzarella…"
   * en un solo renglón es ilegible en cuanto hay más de un producto.
   */
  block?: boolean
}

// ── Plata (Fase 3E-C3B1) ────────────────────────────────────────────────────
//
// COPIA STANDALONE de formatMoneyString() de packages/validators/src/money.ts,
// por la misma razón que la tabla de labels de arriba: el worker no tiene
// dependencias de workspace en runtime. submission-summary.test.ts compara las
// dos implementaciones sobre una tabla de casos, así que no pueden divergir.
//
// Es manipulación de string pura y NO usa Intl a propósito: el formato del
// resumen no puede depender del ICU que traiga el runtime del worker.
const MONEY_STRING_PATTERN = /^\d{1,12}\.\d{2}$/

export function formatMoneyString(value: string, currency: string): string {
  if (typeof value !== 'string' || !MONEY_STRING_PATTERN.test(value)) {
    return `${currency} ${value}`
  }
  const punto     = value.indexOf('.')
  const enteros   = value.slice(0, punto)
  const decimales = value.slice(punto + 1)
  const agrupado  = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${currency} ${agrupado},${decimales}`
}

// ── El detalle del pedido ───────────────────────────────────────────────────
//
// §10 sigue mandando: NO se recalcula nada. unit_price, line_total, subtotal y
// currency salen del snapshot que escribió el servidor cuando se creó la
// submission. El catálogo no se vuelve a consultar ni acá ni en la confirmación
// — si mañana sube el precio, este mensaje sigue diciendo lo que el cliente
// aceptó.
//
// Las líneas duplicadas del mismo producto se muestran SEPARADAS, con su
// aclaración debajo: consolidarlas perdería justamente lo que las distingue.
interface LineaPedido {
  name?:       unknown
  quantity?:   unknown
  notes?:      unknown
  line_total?: unknown
}

function renderCartBlock(payload: Record<string, unknown>): string | null {
  const items = payload.items
  if (!Array.isArray(items) || items.length === 0) return null

  const currency = typeof payload.currency === 'string' ? payload.currency : ''
  const renglones: string[] = []

  for (const crudo of items as LineaPedido[]) {
    const nombre = typeof crudo?.name === 'string' ? crudo.name.trim() : ''
    if (!nombre) continue

    const cantidad = typeof crudo.quantity === 'number' ? crudo.quantity : Number(crudo.quantity)
    const total    = typeof crudo.line_total === 'string' ? crudo.line_total : ''

    renglones.push(
      total
        ? `${cantidad} × ${nombre} — ${formatMoneyString(total, currency)}`
        : `${cantidad} × ${nombre}`,
    )

    // La aclaración va TAL CUAL la escribió el cliente: ni recortada ni
    // recapitalizada. Es el texto que tiene que poder verificar.
    const nota = typeof crudo.notes === 'string' ? crudo.notes.trim() : ''
    if (nota) renglones.push(`  ${nota}`)
  }

  return renglones.length > 0 ? renglones.join('\n') : null
}

// Devuelve las líneas del resumen, en el orden en que el cliente completó el
// formulario. Nunca incluye id, tenant_id, contact_id, idempotency_key ni
// ningún campo que no esté en la definición: solo se recorre SUMMARY_FIELDS,
// así que una clave extra en el payload no puede filtrarse al mensaje.
export function buildSummaryLines(
  intent:  SummaryIntent,
  payload: Record<string, unknown>,
): SubmissionSummaryLine[] {
  const lines: SubmissionSummaryLine[] = []

  // El pedido va PRIMERO: es lo que la persona tiene que verificar. Los datos
  // de contacto y entrega van después, en el orden del formulario.
  if (intent === 'food_order') {
    const bloque = renderCartBlock(payload)
    if (bloque) lines.push({ label: 'Pedido', value: bloque, block: true })

    const currency = typeof payload.currency === 'string' ? payload.currency : ''
    const subtotal = typeof payload.subtotal === 'string' ? payload.subtotal : ''
    if (subtotal) lines.push({ label: 'Subtotal', value: formatMoneyString(subtotal, currency) })
  }

  for (const field of SUMMARY_FIELDS[intent]) {
    if (!isVisible(field, payload)) continue
    const value = formatValue(field, payload[field.name])
    if (value === null) continue          // campo vacío: no se imprime (§10)
    lines.push({ label: field.label, value })
  }

  return lines
}

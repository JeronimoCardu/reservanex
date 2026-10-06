'use client'

// Fase 3A — render del formulario dinámico.
//
// Sigue el idioma del árbol /site (raw Tailwind sobre zinc, colores del tenant
// por CSS vars), NO los primitivos shadcn del CRM: nada en /site los usa, y
// dos de ellos (Textarea, SelectTrigger) son text-sm, lo que dispara el zoom
// de foco de iOS Safari en un formulario público. Ver la auditoría de Fase 3A.
//
// Los campos y las condiciones vienen de @orderflow/validators — el mismo
// módulo que valida en el servidor. Este componente no decide reglas, solo
// las dibuja.

import { useMemo, useState } from 'react'
import {
  createSubmissionResponseSchema,
  getFormDefinition,
  isFieldVisible,
  type CreateSubmissionResponse,
  type FormField,
  type FormIntent,
} from '@orderflow/validators'
import { buildSubmissionWhatsAppHref } from '@/lib/site/submission-whatsapp'
import {
  applyFieldValue,
  buildSubmissionPayload,
  initialFormValues,
  type FormValues,
} from '@/lib/forms/form-state'
import { rateLimitNoticeFor } from '@/lib/forms/rate-limit-notice'

type Status = 'idle' | 'submitting' | 'success' | 'error'

interface DynamicFormProps {
  tenantSlug:      string
  intent:          FormIntent
  publicationRef?: string | null
  // Generado por el server component en cada carga de página: una instancia de
  // formulario = una clave. Si el visitante hace doble tap, las dos requests
  // traen la misma clave y el servidor devuelve la misma submission (§19).
  idempotencyKey:  string
  // Fase 3B — número de la cuenta AutoResponder del tenant, solo dígitos.
  // null cuando el tenant no tiene una cuenta activa: entonces NO se muestra
  // el CTA de WhatsApp, se muestra la referencia y listo. Nunca un número
  // inventado ni un link roto.
  whatsappNumber?: string | null

  // ── Fase 3E-C3B1 — tres ganchos genéricos, cero lógica de dominio ────────
  //
  // El carrito gastronómico necesita mandar `items` junto con los campos del
  // formulario y reaccionar a los 409 del servidor. Eso NO se resuelve
  // metiendo el carrito acá adentro ni inventando un tipo de campo
  // array/repeater: se resuelve dejando que un wrapper adjunte payload y
  // atienda errores estructurados. DynamicForm sigue sin saber qué es un
  // pedido.

  /**
   * Claves extra que se mezclan al payload, además de los campos del
   * formulario. Se aplican DESPUÉS de buildSubmissionPayload, así que un
   * wrapper no puede pisar un campo del formulario por accidente: si lo
   * intenta, el schema .strict() del servidor lo rechaza igual.
   */
  extraPayload?: Record<string, unknown>

  /**
   * Recibe el cuerpo de una respuesta de error que trae `code` (hoy: los 409
   * de precio y de carrito). Si devuelve true, el formulario da por manejado
   * el error y no dibuja el suyo.
   */
  onStructuredError?: (body: { code: string } & Record<string, unknown>) => boolean

  /**
   * Se llama una vez, con la RESPUESTA REAL del POST, cuando la submission quedó
   * creada. Incluye `deduplicated`, que no es un error: un reintento idempotente
   * de un pedido ya aceptado llega acá igual, con la misma referencia.
   *
   * El wrapper tiene que guardarse esto: es lo único que sostiene su propia
   * pantalla de éxito. Fase 3E-C3B1 (fix) — antes recibía `string | null` y el
   * "¡Listo!" lo dibujaba el estado interno de ESTE componente, que el wrapper
   * podía remontar y perder.
   */
  /** Fulfillment habilitados del tenant. Sólo aplica a food_order. */
  enabledFulfillments?: readonly string[]
  onSubmitted?: (result: CreateSubmissionResponse) => void
}

// Un solo lugar decide el aspecto de un control, con y sin error.
// text-base en mobile es deliberado: con text-sm iOS Safari hace zoom al
// enfocar y el formulario queda descuadrado.
function controlClasses(hasError: boolean): string {
  const base =
    'w-full rounded-xl border bg-white px-3.5 py-3 text-base text-zinc-900 ' +
    'placeholder:text-zinc-400 shadow-sm outline-none transition ' +
    'focus:ring-2 focus:ring-offset-0 sm:text-sm'
  return hasError
    ? `${base} border-red-400 focus:border-red-500 focus:ring-red-200`
    : `${base} border-zinc-300 focus:border-zinc-400 focus:ring-zinc-200`
}

export function DynamicForm({
  tenantSlug, intent, publicationRef, idempotencyKey, whatsappNumber,
  extraPayload, onStructuredError, onSubmitted, enabledFulfillments,
}: DynamicFormProps) {
  // La definición se filtra por las capacidades del local: si no hace
  // delivery, ese renglón no existe en el select. El servidor valida contra la
  // MISMA función, así que no hay dos listas que puedan separarse.
  const definition = useMemo(
    () => getFormDefinition({ intent, enabledFulfillments }),
    [intent, enabledFulfillments],
  )
  const [values, setValues] = useState<FormValues>(() => initialFormValues(definition))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Status>('idle')
  const [reference, setReference] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // Progressive disclosure (§16): un campo condicional solo existe cuando su
  // condición se cumple. Se calcula con la MISMA función que usa el servidor.
  const fields = definition.fields.filter((f) => isFieldVisible(f, values))

  function setValue(name: string, value: unknown) {
    // La limpieza en cascada de los campos que dejan de estar visibles vive en
    // @/lib/forms/form-state, con sus tests.
    setValues((prev) => applyFieldValue(definition, prev, name, value))
    setErrors((prev) => {
      if (!prev[name]) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (status === 'submitting') return   // guarda de UX; la real es server-side

    setStatus('submitting')
    setFormError(null)
    setErrors({})

    // Solo campos visibles y no vacíos (ver form-state), más lo que adjunte el
    // wrapper. El servidor revalida todo junto contra el schema del intent.
    const payload = { ...buildSubmissionPayload(definition, values), ...(extraPayload ?? {}) }

    try {
      const res = await fetch('/api/public/forms', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          tenant_slug:     tenantSlug,
          intent,
          source:          'public_site',
          publication_ref: publicationRef ?? undefined,
          idempotency_key: idempotencyKey,
          payload,
        }),
      })

      const data = await res.json().catch(() => null)

      if (res.ok && data?.ok) {
        // Se valida la respuesta con el MISMO schema que el endpoint declara, así
        // que el wrapper recibe un objeto con forma garantizada y no un shape
        // adivinado. Si el servidor devolviera algo inesperado, se cae al error
        // genérico de abajo en vez de propagar un éxito a medias.
        const exito = createSubmissionResponseSchema.safeParse(data)

        if (exito.success) {
          setReference(exito.data.reference)
          setStatus('success')
          onSubmitted?.(exito.data)
          return
        }

        console.error('[dynamic-form] respuesta de éxito con forma inesperada')
        setStatus('error')
        setFormError('No pudimos confirmar el envío. Escribinos por WhatsApp para verificarlo.')
        return
      }

      // 429: se decide por el status, no por el cuerpo — si lo corta el WAF de
      // la plataforma, el cuerpo ni siquiera es nuestro JSON. Va ANTES del
      // error estructurado para que un 429 nunca llegue al wrapper del carrito.
      // No se resetea nada: valores, carrito e idempotencyKey quedan iguales,
      // así que el reintento no duplica (ver lib/forms/rate-limit-notice).
      const rateLimitNotice = rateLimitNoticeFor(res.status, res.headers.get('retry-after'), data)
      if (rateLimitNotice) {
        setStatus('error')
        setFormError(rateLimitNotice)
        return
      }

      // Error estructurado (409): el wrapper sabe qué hacer con él —actualizar
      // precios, marcar productos— y el formulario no.
      if (typeof data?.code === 'string' && onStructuredError?.(data)) {
        setStatus('idle')
        return
      }

      if (data?.reason === 'invalid_fields' && data.errors) {
        const fieldErrors = { ...(data.errors as Record<string, string>) }

        // validateSubmissionPayload agrupa bajo _form los errores sin path.
        // Si lo dejáramos en el mapa por campo no se dibujaría en ningún lado
        // y el visitante vería "revisá los campos marcados" sin nada marcado.
        const formLevel = fieldErrors._form
        delete fieldErrors._form

        setErrors(fieldErrors)
        setStatus('idle')
        setFormError(
          formLevel ??
            (Object.keys(fieldErrors).length > 0
              ? 'Revisá los campos marcados.'
              : 'No pudimos validar el formulario. Revisá los datos e intentá de nuevo.'),
        )
        return
      }

      setStatus('error')
      setFormError('No pudimos enviar el formulario. Probá de nuevo en un momento.')
    } catch {
      setStatus('error')
      setFormError('No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.')
    }
  }

  if (status === 'success') {
    // Fase 3B — el formulario ya no termina acá: continúa por WhatsApp.
    // El CTA solo existe si hay número Y referencia; sin alguno de los dos se
    // muestra la referencia sola, que sigue siendo un estado válido.
    const waHref = buildSubmissionWhatsAppHref(whatsappNumber, reference)

    return (
      <div
        role="status"
        className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm"
      >
        <h2 className="text-lg font-semibold text-zinc-900">¡Listo! Recibimos tu consulta.</h2>
        <p className="mt-2 text-sm text-zinc-600">
          {waHref
            ? 'Seguí por WhatsApp para que confirmemos los datos.'
            : 'Te vamos a responder a la brevedad.'}
        </p>

        {reference && (
          <p className="mt-4 text-sm text-zinc-600">
            Tu número de referencia:{' '}
            <span className="font-mono font-semibold tracking-wide text-zinc-900">{reference}</span>
          </p>
        )}

        {waHref && (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] px-4 py-3.5 text-base font-medium text-white shadow-sm transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-[#25D366] focus:ring-offset-2"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
              <path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.65-2.05-.17-.3-.02-.46.13-.6.14-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.6-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.23 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z" />
              <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.15h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.82c0 4.54-3.7 8.23-8.24 8.23z" />
            </svg>
            Continuar por WhatsApp
          </a>
        )}

        {reference && !waHref && (
          // Estado controlado (§2): el tenant no tiene una cuenta AutoResponder
          // activa. No se inventa un número ni se ofrece un link roto.
          <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
            Guardá esa referencia: te la vamos a pedir cuando nos contactes.
          </p>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">{definition.title}</h1>
        <p className="mt-1 text-sm text-zinc-600">{definition.description}</p>
      </div>

      {formError && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {formError}
        </p>
      )}

      <div className="space-y-4">
        {fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={values[field.name]}
            error={errors[field.name]}
            onChange={(v) => setValue(field.name, v)}
          />
        ))}
      </div>

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="w-full rounded-xl px-4 py-3.5 text-base font-medium text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: 'var(--tenant-primary, #0F766E)' }}
      >
        {status === 'submitting' ? 'Enviando…' : definition.submitLabel}
      </button>
    </form>
  )
}

// ── Un campo ───────────────────────────────────────────────────────────────
// §17 — label real asociado por htmlFor/id, aria-invalid, el error asociado
// por aria-describedby, y foco visible por el ring de Tailwind.

function Field({
  field, value, error, onChange,
}: {
  field:    FormField
  value:    unknown
  error?:   string
  onChange: (value: unknown) => void
}) {
  const id      = `field-${field.name}`
  const errorId = `${id}-error`
  const helpId  = `${id}-help`
  const describedBy = [error ? errorId : null, field.help ? helpId : null].filter(Boolean).join(' ') || undefined

  // El checkbox lleva el label al lado, no arriba: es la única forma en la que
  // un control booleano se lee bien.
  if (field.type === 'boolean') {
    return (
      <div>
        <label htmlFor={id} className="flex items-center gap-3 text-sm text-zinc-800">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className="h-5 w-5 rounded border-zinc-300 text-zinc-900 focus:ring-2 focus:ring-zinc-300"
          />
          {field.label}
        </label>
        {field.help && <p id={helpId} className="mt-1 text-xs text-zinc-500">{field.help}</p>}
        {error && <p id={errorId} className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    )
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-zinc-800">
        {field.label}
        {!field.required && <span className="ml-1 font-normal text-zinc-400">(opcional)</span>}
      </label>

      {field.type === 'textarea' ? (
        <textarea
          id={id}
          rows={3}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={controlClasses(Boolean(error))}
        />
      ) : field.type === 'select' ? (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={controlClasses(Boolean(error))}
        >
          <option value="">Elegí una opción</option>
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'time' ? 'time' : 'text'}
          inputMode={field.type === 'number' ? 'numeric' : undefined}
          min={field.min}
          max={field.max}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={controlClasses(Boolean(error))}
        />
      )}

      {field.help && <p id={helpId} className="mt-1 text-xs text-zinc-500">{field.help}</p>}
      {error && <p id={errorId} className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

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
  getFormDefinition,
  isFieldVisible,
  type FormField,
  type FormIntent,
} from '@orderflow/validators'
import {
  applyFieldValue,
  buildSubmissionPayload,
  initialFormValues,
  type FormValues,
} from '@/lib/forms/form-state'

type Status = 'idle' | 'submitting' | 'success' | 'error'

interface DynamicFormProps {
  tenantSlug:      string
  intent:          FormIntent
  publicationRef?: string | null
  // Generado por el server component en cada carga de página: una instancia de
  // formulario = una clave. Si el visitante hace doble tap, las dos requests
  // traen la misma clave y el servidor devuelve la misma submission (§19).
  idempotencyKey:  string
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

export function DynamicForm({ tenantSlug, intent, publicationRef, idempotencyKey }: DynamicFormProps) {
  const definition = useMemo(() => getFormDefinition({ intent }), [intent])
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

    // Solo campos visibles y no vacíos (ver form-state).
    const payload = buildSubmissionPayload(definition, values)

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
        setReference(data.reference ?? null)
        setStatus('success')
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
    return (
      <div
        role="status"
        className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm"
      >
        <h2 className="text-lg font-semibold text-zinc-900">¡Listo! Recibimos tu consulta.</h2>
        <p className="mt-2 text-sm text-zinc-600">
          Te vamos a responder a la brevedad.
        </p>
        {reference && (
          <p className="mt-4 text-sm text-zinc-600">
            Tu número de referencia:{' '}
            <span className="font-mono font-semibold tracking-wide text-zinc-900">{reference}</span>
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

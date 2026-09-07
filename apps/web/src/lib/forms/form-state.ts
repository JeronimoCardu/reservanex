// Fase 3A — estado del formulario dinámico, sin React.
//
// Estas dos reglas tienen que coincidir EXACTAMENTE con lo que valida el
// servidor (packages/validators/src/forms.ts), así que viven acá, puras y
// testeadas, en vez de adentro del componente:
//
//   1. al ocultarse un campo condicional, su valor se limpia;
//   2. solo se envían los campos visibles.
//
// Si divergen, el visitante recibe un error sobre un campo que el formulario
// no le mostró — exactamente el caso que foodOrderPayload rechaza con
// "No corresponde una dirección para retiro en el local".

import { isFieldVisible, type FormDefinition, type FormField } from '@orderflow/validators'

export type FormValues = Record<string, unknown>

function emptyValueFor(field: FormField): unknown {
  return field.type === 'boolean' ? false : ''
}

export function initialFormValues(definition: FormDefinition): FormValues {
  const values: FormValues = {}
  for (const field of definition.fields) {
    values[field.name] = emptyValueFor(field)
  }
  return values
}

// Aplica un cambio y limpia en cascada lo que haya dejado de estar visible.
// Es un bucle hasta punto fijo, no una sola pasada: si algún día un campo
// condicional controla a otro, limpiar el primero tiene que arrastrar al
// segundo. Con las definiciones actuales converge en una iteración.
export function applyFieldValue(
  definition: FormDefinition,
  values:     FormValues,
  name:       string,
  value:      unknown,
): FormValues {
  const next: FormValues = { ...values, [name]: value }

  let changed = true
  while (changed) {
    changed = false
    for (const field of definition.fields) {
      if (!field.showIf) continue
      if (isFieldVisible(field, next)) continue
      const empty = emptyValueFor(field)
      if (next[field.name] === empty) continue
      next[field.name] = empty
      changed = true
    }
  }

  return next
}

// El payload que se manda: solo campos visibles, sin los vacíos.
// Los <input> producen strings, y la coerción de Zod (z.coerce.number) es la
// que convierte del lado del servidor — acá no se convierte nada, para que
// haya un solo lugar donde se decide qué es un número válido.
export function buildSubmissionPayload(definition: FormDefinition, values: FormValues): FormValues {
  const payload: FormValues = {}
  for (const field of definition.fields) {
    if (!isFieldVisible(field, values)) continue
    const raw = values[field.name]
    if (raw === '' || raw === undefined || raw === null) continue
    payload[field.name] = raw
  }
  return payload
}

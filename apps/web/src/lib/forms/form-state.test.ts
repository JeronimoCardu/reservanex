import { describe, expect, it } from 'vitest'
import { getFormDefinition, validateSubmissionPayload } from '@orderflow/validators'
import { applyFieldValue, buildSubmissionPayload, initialFormValues } from './form-state'

const foodOrder = getFormDefinition({ intent: 'food_order' })
const rental    = getFormDefinition({ intent: 'temporary_rental' })

describe('initialFormValues', () => {
  it('starts every field empty, with booleans false rather than undefined', () => {
    const values = initialFormValues(foodOrder)
    expect(Object.keys(values).sort()).toEqual(
      foodOrder.fields.map((f) => f.name).sort(),
    )
    expect(values.fulfillment).toBe('')
    expect(initialFormValues(rental).has_pets).toBe(false)
  })
})

describe('applyFieldValue', () => {
  it('sets the value it was given', () => {
    const values = applyFieldValue(foodOrder, initialFormValues(foodOrder), 'name', 'Ana')
    expect(values.name).toBe('Ana')
  })

  it('does not mutate the values it was handed', () => {
    const before = initialFormValues(foodOrder)
    applyFieldValue(foodOrder, before, 'name', 'Ana')
    expect(before.name).toBe('')
  })

  // El caso real: elegís delivery, escribís la dirección, cambiás a takeaway.
  // Si la dirección sobreviviera, el servidor rechazaría la submission con un
  // error sobre un campo que ya no está en pantalla.
  it('clears a conditional field when its condition stops holding', () => {
    let values = initialFormValues(foodOrder)
    values = applyFieldValue(foodOrder, values, 'fulfillment', 'delivery')
    values = applyFieldValue(foodOrder, values, 'address', 'Calle Falsa 123')
    expect(values.address).toBe('Calle Falsa 123')

    values = applyFieldValue(foodOrder, values, 'fulfillment', 'takeaway')
    expect(values.address).toBe('')
  })

  it('clears pet details when the guest un-checks the pets box', () => {
    let values = initialFormValues(rental)
    values = applyFieldValue(rental, values, 'has_pets', true)
    values = applyFieldValue(rental, values, 'pet_details', 'un perro chico')
    values = applyFieldValue(rental, values, 'has_pets', false)
    expect(values.pet_details).toBe('')
  })

  it('leaves unconditional fields alone while clearing a conditional one', () => {
    let values = initialFormValues(foodOrder)
    values = applyFieldValue(foodOrder, values, 'name', 'Ana')
    values = applyFieldValue(foodOrder, values, 'payment_method', 'cash')
    values = applyFieldValue(foodOrder, values, 'fulfillment', 'delivery')
    values = applyFieldValue(foodOrder, values, 'address', 'Calle 1')
    values = applyFieldValue(foodOrder, values, 'fulfillment', 'takeaway')

    expect(values.name).toBe('Ana')
    expect(values.payment_method).toBe('cash')
    expect(values.address).toBe('')
  })
})

describe('buildSubmissionPayload', () => {
  it('omits empty optional fields instead of sending empty strings', () => {
    let values = initialFormValues(rental)
    values = applyFieldValue(rental, values, 'name', 'Ana')
    values = applyFieldValue(rental, values, 'check_in', '2026-01-10')
    values = applyFieldValue(rental, values, 'check_out', '2026-01-15')
    values = applyFieldValue(rental, values, 'adults', '2')

    const payload = buildSubmissionPayload(rental, values)
    expect(payload).toEqual({ name: 'Ana', check_in: '2026-01-10', check_out: '2026-01-15', adults: '2', has_pets: false })
    expect(payload).not.toHaveProperty('notes')
    expect(payload).not.toHaveProperty('children')
  })

  it('never includes a hidden conditional field', () => {
    let values = initialFormValues(foodOrder)
    values = applyFieldValue(foodOrder, values, 'fulfillment', 'delivery')
    values = applyFieldValue(foodOrder, values, 'address', 'Calle Falsa 123')
    expect(buildSubmissionPayload(foodOrder, values)).toHaveProperty('address')

    values = applyFieldValue(foodOrder, values, 'fulfillment', 'takeaway')
    expect(buildSubmissionPayload(foodOrder, values)).not.toHaveProperty('address')
  })
})

// El punto de haber extraído esto: lo que el formulario construye tiene que
// pasar la MISMA validación que corre el servidor. Si un día divergen, esto
// falla acá y no en producción con un visitante mirando.
describe('client payload agrees with server validation', () => {
  it('produces a takeaway order the server accepts', () => {
    let values = initialFormValues(foodOrder)
    values = applyFieldValue(foodOrder, values, 'name', 'Ana')
    values = applyFieldValue(foodOrder, values, 'fulfillment', 'delivery')
    values = applyFieldValue(foodOrder, values, 'address', 'Calle Falsa 123')
    values = applyFieldValue(foodOrder, values, 'fulfillment', 'takeaway')
    values = applyFieldValue(foodOrder, values, 'payment_method', 'cash')

    const result = validateSubmissionPayload('food_order', buildSubmissionPayload(foodOrder, values))
    expect(result.ok).toBe(true)
  })

  it('produces a delivery order the server accepts', () => {
    let values = initialFormValues(foodOrder)
    values = applyFieldValue(foodOrder, values, 'name', 'Ana')
    values = applyFieldValue(foodOrder, values, 'fulfillment', 'delivery')
    values = applyFieldValue(foodOrder, values, 'address', 'Calle Falsa 123')
    values = applyFieldValue(foodOrder, values, 'payment_method', 'transfer')

    const result = validateSubmissionPayload('food_order', buildSubmissionPayload(foodOrder, values))
    expect(result.ok).toBe(true)
  })

  it('produces a rental with pets the server accepts, and without pets after unchecking', () => {
    let values = initialFormValues(rental)
    values = applyFieldValue(rental, values, 'name', 'Ana')
    values = applyFieldValue(rental, values, 'check_in', '2026-01-10')
    values = applyFieldValue(rental, values, 'check_out', '2026-01-15')
    values = applyFieldValue(rental, values, 'adults', '2')
    values = applyFieldValue(rental, values, 'has_pets', true)
    values = applyFieldValue(rental, values, 'pet_details', 'un perro chico')
    expect(validateSubmissionPayload('temporary_rental', buildSubmissionPayload(rental, values)).ok).toBe(true)

    values = applyFieldValue(rental, values, 'has_pets', false)
    expect(validateSubmissionPayload('temporary_rental', buildSubmissionPayload(rental, values)).ok).toBe(true)
  })
})

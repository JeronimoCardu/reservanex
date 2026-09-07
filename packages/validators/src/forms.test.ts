import { describe, expect, it } from 'vitest'
import {
  createSubmissionRequestSchema,
  formIntentSchema,
  getFormDefinition,
  intentsForVertical,
  isFieldVisible,
  isIntentAllowedForVertical,
  validateSubmissionPayload,
  verticalForIntent,
  visibleFields,
  type FormIntent,
} from './forms'

const ALL_INTENTS = formIntentSchema.options as FormIntent[]

// ── §21 A · Definiciones ───────────────────────────────────────────────────

describe('form definitions', () => {
  it('has a definition for every intent, self-consistent with its key', () => {
    for (const intent of ALL_INTENTS) {
      const def = getFormDefinition({ intent })
      expect(def, intent).toBeDefined()
      expect(def.intent).toBe(intent)
      expect(def.vertical).toBe(verticalForIntent(intent))
      expect(def.fields.length).toBeGreaterThan(0)
      expect(def.title.length).toBeGreaterThan(0)
      expect(def.submitLabel.length).toBeGreaterThan(0)
    }
  })

  it('never repeats a field name inside one definition', () => {
    // Dos campos con el mismo name se pisarían en el payload y el segundo
    // ganaría en silencio.
    for (const intent of ALL_INTENTS) {
      const names = getFormDefinition({ intent }).fields.map((f) => f.name)
      expect(new Set(names).size, intent).toBe(names.length)
    }
  })

  it('only references existing earlier fields in showIf conditions', () => {
    // Una condición sobre un campo inexistente (o posterior) nunca se cumple:
    // el campo quedaría invisible para siempre sin ningún error.
    for (const intent of ALL_INTENTS) {
      const fields = getFormDefinition({ intent }).fields
      fields.forEach((field, index) => {
        if (!field.showIf) return
        const controllerIndex = fields.findIndex((f) => f.name === field.showIf!.field)
        expect(controllerIndex, `${intent}.${field.name}`).toBeGreaterThanOrEqual(0)
        expect(controllerIndex, `${intent}.${field.name}`).toBeLessThan(index)
      })
    }
  })

  it('gives every select field at least one option', () => {
    for (const intent of ALL_INTENTS) {
      for (const field of getFormDefinition({ intent }).fields) {
        if (field.type !== 'select') continue
        expect(field.options?.length, `${intent}.${field.name}`).toBeGreaterThan(0)
      }
    }
  })

  it('describes temporary_rental with the fields the operation actually needs', () => {
    const def = getFormDefinition({ intent: 'temporary_rental' })
    const names = def.fields.map((f) => f.name)
    expect(names).toEqual([
      'name', 'check_in', 'check_out', 'adults', 'children',
      'infants', 'has_pets', 'pet_details', 'notes',
    ])
    expect(def.vertical).toBe('real_estate')
  })

  it('describes property_visit with a bounded time-range choice', () => {
    const def = getFormDefinition({ intent: 'property_visit' })
    const range = def.fields.find((f) => f.name === 'preferred_time_range')
    expect(range?.type).toBe('select')
    expect(range?.options?.map((o) => o.value)).toEqual(['morning', 'afternoon', 'evening'])
  })

  it('describes table_reservation as food_service with date, time and party size', () => {
    const def = getFormDefinition({ intent: 'table_reservation' })
    expect(def.vertical).toBe('food_service')
    expect(def.fields.map((f) => f.name)).toEqual(['name', 'date', 'time', 'people', 'notes'])
  })

  // No pedimos datos de contacto: el teléfono llega por WhatsApp en 3B. Si
  // alguien agrega un campo de teléfono o email, esto lo frena — es una
  // decisión de producto, no un descuido.
  it('asks for no phone or email in any form', () => {
    for (const intent of ALL_INTENTS) {
      for (const field of getFormDefinition({ intent }).fields) {
        expect(field.name, `${intent}.${field.name}`).not.toMatch(/phone|email|telefono|correo/i)
      }
    }
  })
})

// ── §21 B · Rubro ──────────────────────────────────────────────────────────

describe('vertical gating', () => {
  it('allows an intent only in its own vertical', () => {
    expect(isIntentAllowedForVertical('temporary_rental', 'real_estate')).toBe(true)
    expect(isIntentAllowedForVertical('temporary_rental', 'food_service')).toBe(false)
    expect(isIntentAllowedForVertical('table_reservation', 'food_service')).toBe(true)
    expect(isIntentAllowedForVertical('table_reservation', 'real_estate')).toBe(false)
  })

  it('partitions the intents between the two verticals with none left over', () => {
    const realEstate = intentsForVertical('real_estate')
    const foodService = intentsForVertical('food_service')
    expect([...realEstate, ...foodService].sort()).toEqual([...ALL_INTENTS].sort())
    expect(realEstate.some((i) => foodService.includes(i))).toBe(false)
  })
})

// ── §21 C · Campos condicionales ───────────────────────────────────────────

describe('conditional fields', () => {
  const foodOrder = getFormDefinition({ intent: 'food_order' })
  const address = foodOrder.fields.find((f) => f.name === 'address')!

  it('hides the delivery address until delivery is chosen', () => {
    expect(isFieldVisible(address, {})).toBe(false)
    expect(isFieldVisible(address, { fulfillment: 'takeaway' })).toBe(false)
    expect(isFieldVisible(address, { fulfillment: 'delivery' })).toBe(true)
  })

  it('lists the address among the visible fields only for delivery', () => {
    const takeaway = visibleFields(foodOrder, { fulfillment: 'takeaway' }).map((f) => f.name)
    const delivery = visibleFields(foodOrder, { fulfillment: 'delivery' }).map((f) => f.name)
    expect(takeaway).not.toContain('address')
    expect(delivery).toContain('address')
  })

  it('hides pet details until the guest says they travel with pets', () => {
    const petDetails = getFormDefinition({ intent: 'temporary_rental' })
      .fields.find((f) => f.name === 'pet_details')!
    expect(isFieldVisible(petDetails, { has_pets: false })).toBe(false)
    expect(isFieldVisible(petDetails, { has_pets: true })).toBe(true)
    // Un string 'true' no es true: la comparación es estricta a propósito.
    expect(isFieldVisible(petDetails, { has_pets: 'true' })).toBe(false)
  })
})

// ── §21 D · Validación por intent ──────────────────────────────────────────

describe('validateSubmissionPayload', () => {
  const validRental = {
    name:      'Ana Gómez',
    check_in:  '2026-01-10',
    check_out: '2026-01-15',
    adults:    2,
  }

  it('accepts a well-formed temporary_rental payload', () => {
    const result = validateSubmissionPayload('temporary_rental', validRental)
    expect(result.ok).toBe(true)
  })

  it('rejects a check-out that is not after the check-in', () => {
    const result = validateSubmissionPayload('temporary_rental', {
      ...validRental, check_in: '2026-01-15', check_out: '2026-01-10',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.check_out).toBeDefined()
  })

  it('rejects a check-out equal to the check-in (a zero-night stay)', () => {
    const result = validateSubmissionPayload('temporary_rental', {
      ...validRental, check_in: '2026-01-10', check_out: '2026-01-10',
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a malformed date instead of coercing it', () => {
    const result = validateSubmissionPayload('temporary_rental', { ...validRental, check_in: '10/01/2026' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.check_in).toBeDefined()
  })

  it('requires at least one adult', () => {
    const zero = validateSubmissionPayload('temporary_rental', { ...validRental, adults: 0 })
    expect(zero.ok).toBe(false)
    if (zero.ok) return
    expect(zero.errors.adults).toBeDefined()
  })

  it('rejects an absurd guest count rather than storing it', () => {
    expect(validateSubmissionPayload('temporary_rental', { ...validRental, adults: 500 }).ok).toBe(false)
    expect(validateSubmissionPayload('table_reservation', {
      name: 'Ana', date: '2026-01-10', time: '21:00', people: 500,
    }).ok).toBe(false)
  })

  it('rejects a fractional guest count', () => {
    expect(validateSubmissionPayload('temporary_rental', { ...validRental, adults: 2.5 }).ok).toBe(false)
  })

  // El formulario manda todo como string (los <input> no producen numbers).
  // La coerción del schema es lo que hace que eso funcione; si alguien la
  // saca, el formulario deja de andar y este test lo dice.
  it('coerces the numeric strings the browser actually sends', () => {
    const result = validateSubmissionPayload('temporary_rental', {
      ...validRental, adults: '2', children: '1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.adults).toBe(2)
    expect(result.data.children).toBe(1)
  })

  it('rejects pet details when the guest said they have no pets', () => {
    const result = validateSubmissionPayload('temporary_rental', {
      ...validRental, has_pets: false, pet_details: 'un perro',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.pet_details).toBeDefined()
  })

  it('requires an address for delivery and refuses one for takeaway', () => {
    const missing = validateSubmissionPayload('food_order', {
      name: 'Ana', fulfillment: 'delivery', payment_method: 'cash',
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.errors.address).toBeDefined()

    const spurious = validateSubmissionPayload('food_order', {
      name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash', address: 'Calle 1',
    })
    expect(spurious.ok).toBe(false)
    if (!spurious.ok) expect(spurious.errors.address).toBeDefined()

    const good = validateSubmissionPayload('food_order', {
      name: 'Ana', fulfillment: 'delivery', payment_method: 'cash', address: 'Calle Falsa 123',
    })
    expect(good.ok).toBe(true)
  })

  it('rejects a value outside a select field options', () => {
    const result = validateSubmissionPayload('property_visit', {
      name: 'Ana', preferred_date: '2026-01-10', preferred_time_range: 'madrugada',
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a table reservation with a malformed time', () => {
    const result = validateSubmissionPayload('table_reservation', {
      name: 'Ana', date: '2026-01-10', time: '9pm', people: 2,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.time).toBeDefined()
  })

  it('requires a name in every intent', () => {
    for (const intent of ALL_INTENTS) {
      const result = validateSubmissionPayload(intent, {})
      expect(result.ok, intent).toBe(false)
      if (result.ok) continue
      expect(result.errors.name, intent).toBeDefined()
    }
  })

  it('trims and bounds free text instead of storing whatever arrives', () => {
    const tooLong = validateSubmissionPayload('property_inquiry', {
      name: 'Ana', message: 'x'.repeat(1001),
    })
    expect(tooLong.ok).toBe(false)

    const padded = validateSubmissionPayload('property_inquiry', {
      name: '  Ana  ', message: '  hola  ',
    })
    expect(padded.ok).toBe(true)
    if (!padded.ok) return
    expect(padded.data.name).toBe('Ana')
  })

  it('rejects a whitespace-only name (it would pass a naive min(1))', () => {
    expect(validateSubmissionPayload('property_inquiry', { name: '   ', message: 'hola' }).ok).toBe(false)
  })
})

// ── §21 E · Request pública ────────────────────────────────────────────────

describe('createSubmissionRequestSchema', () => {
  const valid = {
    tenant_slug:     'demo',
    intent:          'property_inquiry',
    source:          'public_site',
    idempotency_key: 'a1b2c3d4-0000-4000-8000-000000000000',
    payload:         { name: 'Ana', message: 'hola' },
  }

  it('accepts a well-formed request', () => {
    expect(createSubmissionRequestSchema.safeParse(valid).success).toBe(true)
  })

  // El aislamiento multi-tenant NO puede depender de un id que mande el
  // browser. Si el schema empezara a aceptarlo, cualquiera podría escribir en
  // el tenant de otro.
  it('never lets the browser choose the tenant by id', () => {
    const parsed = createSubmissionRequestSchema.safeParse({
      ...valid,
      tenant_id: '00000000-0000-4000-8000-000000000000',
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).not.toHaveProperty('tenant_id')
  })

  it('rejects an intent that does not exist', () => {
    expect(createSubmissionRequestSchema.safeParse({ ...valid, intent: 'drop_table' }).success).toBe(false)
    expect(formIntentSchema.safeParse('drop_table').success).toBe(false)
  })

  it('rejects an unknown source', () => {
    expect(createSubmissionRequestSchema.safeParse({ ...valid, source: 'curl' }).success).toBe(false)
  })

  it('requires a tenant slug and an idempotency key', () => {
    expect(createSubmissionRequestSchema.safeParse({ ...valid, tenant_slug: '' }).success).toBe(false)
    const { idempotency_key: _omitted, ...withoutKey } = valid
    expect(createSubmissionRequestSchema.safeParse(withoutKey).success).toBe(false)
  })
})

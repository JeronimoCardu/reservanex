import { describe, expect, it } from 'vitest'
import {
  formIntentSchema,
  getFormDefinition,
  formatMoneyString as formatMoneyStringReal,
  type FormIntent,
} from '@orderflow/validators'
import {
  buildSummaryLines,
  isSummaryIntent,
  formatMoneyString,
  SUMMARY_FIELDS,
  type SummaryIntent,
} from './submission-summary'
import { renderSummaryMessage } from './submission-messages'

// ════════════════════════════════════════════════════════════════════════════
// EL TEST QUE IMPORTA: la copia del worker vs. la fuente de verdad.
//
// submission-summary.ts es una copia standalone de los labels que viven en
// packages/validators (el worker no tiene deps de workspace en runtime). Este
// bloque importa las FormDefinitions REALES —@orderflow/validators es
// devDependency solo para tests— y las compara campo por campo.
//
// Si alguien agrega un campo a un formulario, le cambia el label, reordena o
// toca una opción de select, esto falla acá. Es lo que hace que el resumen
// determinístico del §10 no pueda quedar desactualizado en silencio.
// ════════════════════════════════════════════════════════════════════════════

describe('la copia del worker está sincronizada con @orderflow/validators', () => {
  const intents = formIntentSchema.options as FormIntent[]

  it('cubre exactamente los mismos intents', () => {
    expect(Object.keys(SUMMARY_FIELDS).sort()).toEqual([...intents].sort())
  })

  it('cada intent tiene los mismos campos, en el mismo orden, con los mismos labels', () => {
    for (const intent of intents) {
      const real = getFormDefinition({ intent }).fields
      const copia = SUMMARY_FIELDS[intent as SummaryIntent]

      expect(copia, intent).toBeDefined()
      expect(copia.map((f) => f.name), `${intent}: nombres/orden`).toEqual(real.map((f) => f.name))
      expect(copia.map((f) => f.label), `${intent}: labels`).toEqual(real.map((f) => f.label))
      expect(copia.map((f) => f.type), `${intent}: tipos`).toEqual(real.map((f) => f.type))
    }
  })

  it('replica las condiciones showIf exactamente', () => {
    for (const intent of intents) {
      const real = getFormDefinition({ intent }).fields
      const copia = SUMMARY_FIELDS[intent as SummaryIntent]
      for (let i = 0; i < real.length; i++) {
        expect(copia[i]!.showIf ?? null, `${intent}.${real[i]!.name}`).toEqual(real[i]!.showIf ?? null)
      }
    }
  })

  it('replica las opciones de los select exactamente (valor y etiqueta)', () => {
    for (const intent of intents) {
      const real = getFormDefinition({ intent }).fields
      const copia = SUMMARY_FIELDS[intent as SummaryIntent]
      for (let i = 0; i < real.length; i++) {
        expect(copia[i]!.options ?? null, `${intent}.${real[i]!.name}`).toEqual(real[i]!.options ?? null)
      }
    }
  })

  it('formatMoneyString da EXACTAMENTE lo mismo que el de @orderflow/validators', () => {
    // Fase 3E-C3B1 — segunda copia standalone del worker, misma defensa que la
    // tabla de labels: si alguien cambia el formato en validators y no acá, el
    // cliente vería un total escrito distinto en el sitio y en WhatsApp.
    const casos: Array<[string, string]> = [
      ['0.00', 'ARS'],
      ['0.05', 'ARS'],
      ['999.99', 'ARS'],
      ['1000.50', 'ARS'],
      ['18000.90', 'ARS'],
      ['20000.00', 'ARS'],
      ['1234567.89', 'USD'],
      ['999999999999.99', 'ARS'],
      ['12500.50', 'EUR'],
      // No canónicos: los dos tienen que degradar igual, sin inventar formato.
      ['10000', 'ARS'],
      ['', 'ARS'],
      ['x', 'BRL'],
    ]
    for (const [valor, moneda] of casos) {
      expect(formatMoneyString(valor, moneda), `${valor} ${moneda}`)
        .toBe(formatMoneyStringReal(valor, moneda))
    }
  })

  it('isSummaryIntent acepta todos los intents reales y nada más', () => {
    for (const intent of intents) expect(isSummaryIntent(intent), intent).toBe(true)
    expect(isSummaryIntent('no_existe')).toBe(false)
    expect(isSummaryIntent('')).toBe(false)
  })
})

// ── §26 G/H/I — resúmenes exactos ───────────────────────────────────────────

describe('G. temporary_rental', () => {
  it('renderiza exactamente los datos cargados, sin reinterpretarlos', () => {
    const lines = buildSummaryLines('temporary_rental', {
      name: 'Juan Pérez', check_in: '2026-10-15', check_out: '2026-10-20',
      adults: 2, children: 1, has_pets: false,
    })

    expect(lines).toEqual([
      { label: 'Tu nombre', value: 'Juan Pérez' },
      { label: 'Check-in',  value: '15/10/2026' },
      { label: 'Check-out', value: '20/10/2026' },
      { label: 'Adultos',   value: '2' },
      { label: 'Niños',     value: '1' },
      { label: '¿Viajás con mascotas?', value: 'No' },
    ])
  })

  // El riesgo concreto que §10 nombra: "2 adultos → 3 personas". Acá no hay
  // nadie que pueda sumar: no se agrega ni se combina nada.
  it('NO agrega huéspedes ni inventa un total', () => {
    const lines = buildSummaryLines('temporary_rental', {
      name: 'Ana', check_in: '2026-01-10', check_out: '2026-01-15',
      adults: 2, children: 1, infants: 1,
    })
    const valores = lines.map((l) => `${l.label}: ${l.value}`)
    expect(valores).toContain('Adultos: 2')
    expect(valores).toContain('Niños: 1')
    expect(valores).toContain('Bebés: 1')
    expect(valores.join(' ')).not.toMatch(/personas|total|4/i)
  })

  it('muestra el campo condicional solo cuando corresponde', () => {
    const con = buildSummaryLines('temporary_rental', {
      name: 'Ana', check_in: '2026-01-10', check_out: '2026-01-15',
      adults: 1, has_pets: true, pet_details: 'un perro chico',
    })
    expect(con.map((l) => l.label)).toContain('¿Qué mascotas?')

    const sin = buildSummaryLines('temporary_rental', {
      name: 'Ana', check_in: '2026-01-10', check_out: '2026-01-15',
      adults: 1, has_pets: false, pet_details: 'quedó de antes',
    })
    expect(sin.map((l) => l.label)).not.toContain('¿Qué mascotas?')
  })

  it('omite los campos vacíos', () => {
    const lines = buildSummaryLines('temporary_rental', {
      name: 'Ana', check_in: '2026-01-10', check_out: '2026-01-15', adults: 1,
      notes: '', children: undefined,
    })
    const labels = lines.map((l) => l.label)
    expect(labels).not.toContain('Observaciones')
    expect(labels).not.toContain('Niños')
  })
})

describe('H. property_visit', () => {
  it('muestra la etiqueta legible del select, no el valor interno', () => {
    const lines = buildSummaryLines('property_visit', {
      name: 'Bruno Díaz', preferred_date: '2026-12-10', preferred_time_range: 'morning',
    })
    expect(lines).toEqual([
      { label: 'Tu nombre',        value: 'Bruno Díaz' },
      { label: 'Día preferido',    value: '10/12/2026' },
      { label: 'Horario preferido', value: 'Mañana (9 a 12)' },
    ])
    expect(JSON.stringify(lines)).not.toContain('morning')
  })
})

describe('I. table_reservation', () => {
  it('renderiza fecha, hora y cantidad tal cual', () => {
    const lines = buildSummaryLines('table_reservation', {
      name: 'Carla Ruiz', date: '2026-12-20', time: '21:30', people: 4,
    })
    expect(lines).toEqual([
      { label: 'Tu nombre',            value: 'Carla Ruiz' },
      { label: 'Fecha',                value: '20/12/2026' },
      { label: 'Hora',                 value: '21:30' },
      { label: 'Cantidad de personas', value: '4' },
    ])
  })
})

describe('exactitud general', () => {
  // La fecha se reformatea partiendo el string, sin construir un Date. Un
  // Date interpretaría "2026-10-15" como medianoche UTC y en un huso al oeste
  // mostraría el 14.
  it('no corre la fecha un día por zona horaria', () => {
    const lines = buildSummaryLines('table_reservation', {
      name: 'X', date: '2026-01-01', time: '00:30', people: 1,
    })
    expect(lines.find((l) => l.label === 'Fecha')!.value).toBe('01/01/2026')
  })

  // Una clave de más en el payload no puede filtrarse: solo se recorren los
  // campos de la definición.
  it('nunca imprime campos internos aunque estén en el payload', () => {
    const lines = buildSummaryLines('property_inquiry', {
      name: 'Ana', message: 'hola',
      id: 'uuid-secreto', tenant_id: 'tenant-secreto',
      contact_id: 'contacto-secreto', idempotency_key: 'clave-secreta',
      campo_inventado: 'no deberia aparecer',
    })
    const dump = JSON.stringify(lines)
    for (const s of ['uuid-secreto', 'tenant-secreto', 'contacto-secreto', 'clave-secreta', 'no deberia aparecer']) {
      expect(dump).not.toContain(s)
    }
    expect(lines).toHaveLength(2)
  })

  it('un booleano en false se muestra igual (es información verificable)', () => {
    const lines = buildSummaryLines('temporary_rental', {
      name: 'Ana', check_in: '2026-01-10', check_out: '2026-01-15', adults: 1, has_pets: false,
    })
    expect(lines).toContainEqual({ label: '¿Viajás con mascotas?', value: 'No' })
  })
})

describe('renderSummaryMessage', () => {
  it('arma el mensaje completo con la pregunta al final', () => {
    const lines = buildSummaryLines('property_inquiry', { name: 'Ana', message: 'hola' })
    const text = renderSummaryMessage('es', lines)
    expect(text).toBe('Recibí estos datos:\n\nTu nombre: Ana\nTu consulta: hola\n\n¿Es correcto?')
  })
})

// ── §19 — el resumen determinístico de un pedido (Fase 3E-C3B1) ────────────

describe('food_order — resumen del pedido', () => {
  // El payload es el RESUELTO: el que escribió el servidor y quedó congelado.
  const PEDIDO = {
    name: 'Ana',
    fulfillment: 'delivery',
    address: 'Calle Falsa 123',
    payment_method: 'cash',
    notes: 'Tocar timbre',
    items: [
      { item_id: 'a', name: 'Muzzarella', quantity: 2, notes: 'sin cebolla',   unit_price: '10000.00', line_total: '20000.00' },
      { item_id: 'a', name: 'Muzzarella', quantity: 1, notes: 'sin aceitunas', unit_price: '10000.00', line_total: '10000.00' },
      { item_id: 'b', name: 'Agua 500ml', quantity: 1, unit_price: '2000.00', line_total: '2000.00' },
    ],
    currency: 'ARS',
    subtotal: '32000.00',
  }

  it('arma el detalle exacto, con las líneas duplicadas SEPARADAS', () => {
    const lines = buildSummaryLines('food_order', PEDIDO)

    expect(lines[0]).toEqual({
      label: 'Pedido',
      block: true,
      value: [
        '2 × Muzzarella — ARS 20.000,00',
        '  sin cebolla',
        '1 × Muzzarella — ARS 10.000,00',
        '  sin aceitunas',
        '1 × Agua 500ml — ARS 2.000,00',
      ].join('\n'),
    })
    expect(lines[1]).toEqual({ label: 'Subtotal', value: 'ARS 32.000,00' })
  })

  it('el detalle va primero y después los campos del formulario, en su orden', () => {
    const lines = buildSummaryLines('food_order', PEDIDO)
    expect(lines.map((l) => l.label)).toEqual([
      'Pedido',
      'Subtotal',
      'Tu nombre',
      '¿Cómo lo querés recibir?',
      'Dirección de entrega',
      'Método de pago',
      'Observaciones',
    ])
  })

  it('NO recalcula: usa los montos del snapshot tal como están', () => {
    // Un snapshot con un total "imposible" respecto del unitario se imprime
    // igual. El resumen reproduce la evidencia, no la audita ni la corrige.
    const raro = {
      ...PEDIDO,
      items: [{ item_id: 'a', name: 'Muzzarella', quantity: 3, unit_price: '10000.00', line_total: '11111.11' }],
      subtotal: '11111.11',
    }
    const lines = buildSummaryLines('food_order', raro)
    expect(lines[0]!.value).toBe('3 × Muzzarella — ARS 11.111,11')
    expect(lines[1]!.value).toBe('ARS 11.111,11')
  })

  it('takeaway no imprime dirección (el campo condicional no estaba visible)', () => {
    const lines = buildSummaryLines('food_order', {
      ...PEDIDO, fulfillment: 'takeaway', address: undefined,
    })
    expect(lines.map((l) => l.label)).not.toContain('Dirección de entrega')
  })

  it('una línea sin aclaración no agrega renglón vacío', () => {
    const lines = buildSummaryLines('food_order', {
      ...PEDIDO,
      items: [{ item_id: 'b', name: 'Agua 500ml', quantity: 1, unit_price: '2000.00', line_total: '2000.00' }],
    })
    expect(lines[0]!.value).toBe('1 × Agua 500ml — ARS 2.000,00')
  })

  it('la moneda sale del snapshot, no de una constante', () => {
    const lines = buildSummaryLines('food_order', { ...PEDIDO, currency: 'USD' })
    expect(lines[0]!.value).toContain('USD 20.000,00')
    expect(lines[1]!.value).toBe('USD 32.000,00')
  })

  it('nunca filtra item_id ni claves internas del snapshot', () => {
    const lines = buildSummaryLines('food_order', {
      ...PEDIDO,
      tenant_id: 'tenant-secreto',
      items: [{ item_id: 'uuid-secreto', name: 'Muzzarella', quantity: 1, unit_price: '10000.00', line_total: '10000.00' }],
    })
    const dump = JSON.stringify(lines)
    expect(dump).not.toContain('uuid-secreto')
    expect(dump).not.toContain('tenant-secreto')
  })

  it('un pedido sin items no rompe: imprime lo que tenga', () => {
    const lines = buildSummaryLines('food_order', {
      name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash',
    })
    expect(lines.map((l) => l.label)).not.toContain('Pedido')
    expect(lines[0]).toEqual({ label: 'Tu nombre', value: 'Ana' })
  })

  it('el mensaje completo se lee bien', () => {
    const text = renderSummaryMessage('es', buildSummaryLines('food_order', PEDIDO))
    expect(text).toBe([
      'Recibí estos datos:',
      '',
      'Pedido:',
      '2 × Muzzarella — ARS 20.000,00',
      '  sin cebolla',
      '1 × Muzzarella — ARS 10.000,00',
      '  sin aceitunas',
      '1 × Agua 500ml — ARS 2.000,00',
      'Subtotal: ARS 32.000,00',
      'Tu nombre: Ana',
      '¿Cómo lo querés recibir?: Delivery',
      'Dirección de entrega: Calle Falsa 123',
      'Método de pago: Efectivo',
      'Observaciones: Tocar timbre',
      '',
      '¿Es correcto?',
    ].join('\n'))
  })
})

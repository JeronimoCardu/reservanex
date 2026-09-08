import { describe, expect, it } from 'vitest'
import { formIntentSchema, getFormDefinition, type FormIntent } from '@orderflow/validators'
import {
  buildSnapshotLines,
  intentTitle,
  kindLabel,
  statusLabel,
  statusTone,
  KIND_LABELS,
  STATUS_LABELS,
} from './presentation'

describe('etiquetas', () => {
  it('cubre los 5 kinds y los 4 estados', () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual(
      ['inquiry', 'order_request', 'reservation_request', 'table_request', 'visit_request'],
    )
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      ['cancelled', 'confirmed', 'pending', 'rejected'],
    )
  })

  // El owner ve su propia decisión, no el nombre de la columna.
  it('traduce el estado al idioma del negocio', () => {
    expect(statusLabel('confirmed')).toBe('Aprobada')
    expect(statusLabel('rejected')).toBe('Rechazada')
    expect(statusLabel('pending')).toBe('Pendiente')
  })

  it('no rompe con un valor desconocido', () => {
    expect(kindLabel('algo_nuevo')).toBe('algo_nuevo')
    expect(statusLabel('raro')).toBe('raro')
    expect(statusTone('raro')).toBe('zinc')
  })

  it('el título sale de la definición real del formulario', () => {
    for (const intent of formIntentSchema.options as FormIntent[]) {
      expect(intentTitle(intent)).toBe(getFormDefinition({ intent }).title)
    }
  })
})

describe('buildSnapshotLines', () => {
  it('renderiza temporary_rental en el orden del formulario, con labels reales', () => {
    const lines = buildSnapshotLines('temporary_rental', {
      name: 'Ana Gómez', check_in: '2026-10-15', check_out: '2026-10-20',
      adults: 2, children: 1, has_pets: false,
    })

    expect(lines).toEqual([
      { label: 'Tu nombre', value: 'Ana Gómez' },
      { label: 'Check-in',  value: '15/10/2026' },
      { label: 'Check-out', value: '20/10/2026' },
      { label: 'Adultos',   value: '2' },
      { label: 'Niños',     value: '1' },
      { label: '¿Viajás con mascotas?', value: 'No' },
    ])
  })

  it('muestra la etiqueta legible de un select, no el valor interno', () => {
    const lines = buildSnapshotLines('property_visit', {
      name: 'Bruno', preferred_date: '2026-12-10', preferred_time_range: 'morning',
    })
    expect(lines).toContainEqual({ label: 'Horario preferido', value: 'Mañana (9 a 12)' })
    expect(JSON.stringify(lines)).not.toContain('morning')
  })

  it('oculta los campos condicionales que no corresponden', () => {
    const sin = buildSnapshotLines('food_order', {
      name: 'Ana', fulfillment: 'takeaway', payment_method: 'cash', address: 'quedó de antes',
    })
    expect(sin.map((l) => l.label)).not.toContain('Dirección de entrega')

    const con = buildSnapshotLines('food_order', {
      name: 'Ana', fulfillment: 'delivery', payment_method: 'cash', address: 'Calle Falsa 123',
    })
    expect(con.map((l) => l.label)).toContain('Dirección de entrega')
  })

  // §2 / §12 — el JSON crudo no es la UX, y una clave de más en el snapshot no
  // puede aparecer en pantalla: solo se recorren los campos de la definición.
  it('nunca muestra claves que no están en la definición', () => {
    const lines = buildSnapshotLines('property_inquiry', {
      name: 'Ana', message: 'hola',
      tenant_id: 'tenant-secreto', contact_id: 'contacto-secreto',
      idempotency_key: 'clave-secreta', campo_inventado: 'no deberia verse',
    })
    const dump = JSON.stringify(lines)
    for (const s of ['tenant-secreto', 'contacto-secreto', 'clave-secreta', 'no deberia verse']) {
      expect(dump).not.toContain(s)
    }
    expect(lines).toHaveLength(2)
  })

  it('omite los campos vacíos pero muestra los booleanos en false', () => {
    const lines = buildSnapshotLines('temporary_rental', {
      name: 'Ana', check_in: '2026-01-10', check_out: '2026-01-15', adults: 1,
      notes: '', children: null, has_pets: false,
    })
    const labels = lines.map((l) => l.label)
    expect(labels).not.toContain('Observaciones')
    expect(labels).not.toContain('Niños')
    expect(lines).toContainEqual({ label: '¿Viajás con mascotas?', value: 'No' })
  })

  // Mismo criterio que el resumen del worker: se parten los componentes en vez
  // de construir un Date, que en un huso al oeste mostraría el día anterior.
  it('no corre la fecha un día por zona horaria', () => {
    const lines = buildSnapshotLines('table_reservation', {
      name: 'X', date: '2026-01-01', time: '00:30', people: 1,
    })
    expect(lines.find((l) => l.label === 'Fecha')!.value).toBe('01/01/2026')
  })

  it('con un intent desconocido cae a mostrar los datos crudos en vez de nada', () => {
    const lines = buildSnapshotLines('no_existe', { algo: 'valor' })
    expect(lines).toEqual([{ label: 'algo', value: 'valor' }])
  })

  it('con snapshot vacío o nulo devuelve una lista vacía', () => {
    expect(buildSnapshotLines('property_inquiry', {})).toEqual([])
    expect(buildSnapshotLines('property_inquiry', null)).toEqual([])
  })
})

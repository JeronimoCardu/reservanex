import { describe, expect, it } from 'vitest'
import { formIntentSchema, getFormDefinition, type FormIntent } from '@orderflow/validators'
import {
  buildSnapshotLines,
  decisionActions,
  displayContactName,
  timezoneCityLabel,
  intentTitle,
  isInquiry,
  kindLabel,
  requestTypeLabel,
  requiresScheduling,
  rowHighlights,
  formatVisitMoment,
  visitStatusLabel,
  visitStatusTone,
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

// ── Fase 3E-B1 ───────────────────────────────────────────────────────────────
// El estado interno es el mismo para todos los kinds (pending/confirmed/
// rejected, sin migrar el enum). Lo que cambia es el vocabulario visible.

describe('estados por kind (3E-B1)', () => {
  it('una consulta se gestiona o se descarta, no se aprueba ni se rechaza', () => {
    expect(statusLabel('pending',   'inquiry')).toBe('Pendiente')
    expect(statusLabel('confirmed', 'inquiry')).toBe('Gestionada')
    expect(statusLabel('rejected',  'inquiry')).toBe('Descartada')
  })

  it('una reserva sigue diciendo Aprobada / Rechazada — no se tocó', () => {
    expect(statusLabel('pending',   'reservation_request')).toBe('Pendiente')
    expect(statusLabel('confirmed', 'reservation_request')).toBe('Aprobada')
    expect(statusLabel('rejected',  'reservation_request')).toBe('Rechazada')
  })

  // Fase 3E-B2 cerró este pendiente: ahora visit_request tiene su propio
  // vocabulario. Lo que sigue fijo es que las reservas NO cambiaron.
  it('visit_request ya tiene vocabulario propio desde 3E-B2', () => {
    expect(statusLabel('confirmed', 'visit_request')).toBe('Agendada')
    expect(statusLabel('rejected',  'visit_request')).toBe('Descartada')
  })

  it('sin kind usa el vocabulario genérico, como el filtro de la bandeja', () => {
    expect(statusLabel('confirmed')).toBe('Aprobada')
  })

  it('un kind desconocido no rompe: cae al vocabulario genérico', () => {
    expect(statusLabel('confirmed', 'algo_raro')).toBe('Aprobada')
    expect(statusLabel('vaya_estado', 'inquiry')).toBe('vaya_estado')
  })
})

describe('acciones por kind (3E-B1)', () => {
  it('para una consulta los verbos son gestionar y descartar', () => {
    const a = decisionActions('inquiry')
    expect(a.confirm).toBe('Marcar como gestionada')
    expect(a.reject).toBe('Descartar')
    // El copy tiene que decir la verdad: una consulta gestionada no crea nada.
    expect(a.confirmBody).toContain('No se crea ninguna reserva')
  })

  it('para una reserva los verbos siguen siendo aprobar y rechazar', () => {
    expect(decisionActions('reservation_request').confirm).toBe('Aprobar')
    expect(decisionActions('reservation_request').reject).toBe('Rechazar')
  })

  it('un kind sin override cae al vocabulario de reservas', () => {
    // visit_request dejó de estar en este grupo en 3E-B2 (tiene el suyo).
    expect(decisionActions('table_request').confirm).toBe('Aprobar')
    expect(decisionActions('cualquiera').confirm).toBe('Aprobar')
  })

  it('isInquiry distingue solo las consultas', () => {
    expect(isInquiry('inquiry')).toBe(true)
    expect(isInquiry('reservation_request')).toBe(false)
    expect(isInquiry('visit_request')).toBe(false)
  })
})

describe('tipo de solicitud por intent (3E-B1)', () => {
  it('distingue las dos consultas inmobiliarias, que comparten kind', () => {
    expect(requestTypeLabel('inquiry', 'property_inquiry')).toBe('Consulta por propiedad')
    expect(requestTypeLabel('inquiry', 'monthly_rental_inquiry')).toBe('Consulta alquiler mensual')
  })

  it('los kinds que no son consulta conservan su label de kind', () => {
    expect(requestTypeLabel('reservation_request', 'temporary_rental')).toBe('Solicitud de reserva')
    expect(requestTypeLabel('visit_request', 'property_visit')).toBe('Solicitud de visita')
  })

  it('una consulta con intent inesperado cae al label del kind', () => {
    expect(requestTypeLabel('inquiry', 'lo_que_sea')).toBe('Consulta')
  })
})

describe('datos destacados en la fila (3E-B1)', () => {
  it('el alquiler mensual destaca mudanza y ocupantes, con labels del formulario', () => {
    const lines = rowHighlights('monthly_rental_inquiry', {
      name: 'Ana', move_in_date: '2027-03-01', occupants: 3, notes: 'con garantía',
    })
    expect(lines).toEqual([
      { label: 'Fecha estimada de mudanza', value: '01/03/2027' },
      { label: '¿Cuántas personas vivirían?', value: '3' },
    ])
  })

  it('omite los opcionales que el cliente no completó', () => {
    expect(rowHighlights('monthly_rental_inquiry', { name: 'Ana' })).toEqual([])
  })

  it('property_inquiry no destaca nada: su único dato es el mensaje, y va al detalle', () => {
    expect(rowHighlights('property_inquiry', { name: 'Ana', message: 'hola' })).toEqual([])
  })

  it('no destaca nada para los intents que no lo declaran', () => {
    expect(rowHighlights('temporary_rental', { check_in: '2027-01-01' })).toEqual([])
  })
})

describe('detalle de las consultas (3E-B1 §5)', () => {
  it('property_inquiry muestra nombre y consulta con labels humanos', () => {
    expect(buildSnapshotLines('property_inquiry', {
      name: 'Ana Pérez', message: '¿Acepta mascotas?',
    })).toEqual([
      { label: 'Tu nombre', value: 'Ana Pérez' },
      { label: 'Tu consulta', value: '¿Acepta mascotas?' },
    ])
  })

  it('monthly_rental_inquiry muestra los cuatro campos en el orden del formulario', () => {
    expect(buildSnapshotLines('monthly_rental_inquiry', {
      name: 'Ana Pérez', move_in_date: '2027-03-01', occupants: 3, notes: 'con garantía propietaria',
    })).toEqual([
      { label: 'Tu nombre', value: 'Ana Pérez' },
      { label: 'Fecha estimada de mudanza', value: '01/03/2027' },
      { label: '¿Cuántas personas vivirían?', value: '3' },
      { label: 'Observaciones', value: 'con garantía propietaria' },
    ])
  })
})

// ── Fase 3E-B2 ───────────────────────────────────────────────────────────────

describe('estados y acciones de visita (3E-B2)', () => {
  it('una solicitud de visita aprobada queda Agendada, no Aprobada', () => {
    expect(statusLabel('pending',   'visit_request')).toBe('Pendiente')
    expect(statusLabel('confirmed', 'visit_request')).toBe('Agendada')
    expect(statusLabel('rejected',  'visit_request')).toBe('Descartada')
  })

  it('no se rompieron los otros dos kinds', () => {
    expect(statusLabel('confirmed', 'reservation_request')).toBe('Aprobada')
    expect(statusLabel('rejected',  'reservation_request')).toBe('Rechazada')
    expect(statusLabel('confirmed', 'inquiry')).toBe('Gestionada')
    expect(statusLabel('rejected',  'inquiry')).toBe('Descartada')
  })

  it('los verbos de una visita son agendar y descartar', () => {
    const a = decisionActions('visit_request')
    expect(a.confirm).toBe('Agendar visita')
    expect(a.reject).toBe('Descartar')
    expect(a.confirmBody).toContain('fecha y la hora')
  })

  it('requiresScheduling distingue solo las visitas', () => {
    expect(requiresScheduling('visit_request')).toBe(true)
    expect(requiresScheduling('reservation_request')).toBe(false)
    expect(requiresScheduling('inquiry')).toBe(false)
  })

  it('la fila de una visita destaca el día y la franja preferidos', () => {
    expect(rowHighlights('property_visit', {
      name: 'Ana', preferred_date: '2027-04-09', preferred_time_range: 'afternoon',
    })).toEqual([
      { label: 'Día preferido', value: '09/04/2027' },
      // La etiqueta legible del select, no el valor interno.
      { label: 'Horario preferido', value: 'Tarde (12 a 18)' },
    ])
  })
})

describe('estados de property_visits (3E-B2)', () => {
  it('traduce el ciclo de vida al idioma del negocio', () => {
    expect(visitStatusLabel('scheduled')).toBe('Agendada')
    expect(visitStatusLabel('completed')).toBe('Realizada')
    expect(visitStatusLabel('cancelled')).toBe('Cancelada')
  })

  it('no rompe con un estado desconocido', () => {
    expect(visitStatusLabel('vaya')).toBe('vaya')
    expect(visitStatusTone('vaya')).toBe('zinc')
  })
})

describe('formatVisitMoment (3E-B2)', () => {
  // 2027-04-09T20:30:00Z son las 17:30 en Buenos Aires y las 14:30 en México.
  const INSTANTE = '2027-04-09T20:30:00.000Z'

  it('muestra el instante en la zona con la que se agendó, no en la del navegador', () => {
    expect(formatVisitMoment(INSTANTE, 'America/Argentina/Buenos_Aires')).toContain('17:30')
    expect(formatVisitMoment(INSTANTE, 'America/Mexico_City')).toContain('14:30')
  })

  it('una zona inválida no rompe la pantalla', () => {
    expect(formatVisitMoment(INSTANTE, 'No/Existe')).toContain('2027-04-09')
  })
})

// ── Fase 3E-B2 (UI) ──────────────────────────────────────────────────────────
// Un contacto nacido de un WhatsApp entrante solo tiene teléfono hasta que
// alguien lo completa, pero el cliente SÍ escribió su nombre en el formulario.
// La pantalla mostraba "Sin nombre" teniéndolo a mano.

describe('displayContactName (3E-B2 UI)', () => {
  it('sin nombre en el contacto, usa el que el cliente escribió en el formulario', () => {
    expect(displayContactName(null, { name: 'Ana Gómez' })).toBe('Ana Gómez')
  })

  it('el nombre guardado en el contacto tiene prioridad sobre el del formulario', () => {
    expect(displayContactName('Nombre guardado', { name: 'Ana Gómez' })).toBe('Nombre guardado')
  })

  it('sin ninguno de los dos, cae a "Sin nombre"', () => {
    expect(displayContactName(null, { message: 'hola' })).toBe('Sin nombre')
    expect(displayContactName(undefined, null)).toBe('Sin nombre')
    expect(displayContactName(null, undefined)).toBe('Sin nombre')
  })

  it('no muestra un nombre que no sea texto', () => {
    // Ningún intent debería tener un 'name' numérico, pero el payload es JSONB
    // y la pantalla no puede confiar en eso.
    expect(displayContactName(null, { name: 42 })).toBe('Sin nombre')
    expect(displayContactName(null, { name: null })).toBe('Sin nombre')
    expect(displayContactName(null, { name: { nested: 'x' } })).toBe('Sin nombre')
  })

  it('ignora los valores que son solo espacios', () => {
    expect(displayContactName('   ', { name: 'Ana Gómez' })).toBe('Ana Gómez')
    expect(displayContactName('   ', { name: '   ' })).toBe('Sin nombre')
  })

  it('recorta los espacios sobrantes', () => {
    expect(displayContactName('  Ana  ')).toBe('Ana')
    expect(displayContactName(null, { name: '  Ana Gómez  ' })).toBe('Ana Gómez')
  })
})

describe('timezoneCityLabel (3E-B2 UI)', () => {
  it('convierte una zona IANA en una ciudad legible', () => {
    expect(timezoneCityLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
    expect(timezoneCityLabel('America/Mexico_City')).toBe('Mexico City')
    expect(timezoneCityLabel('Europe/Madrid')).toBe('Madrid')
  })

  it('no rompe con zonas sin barra', () => {
    expect(timezoneCityLabel('UTC')).toBe('UTC')
  })

  it('es genérico: no hay ninguna ciudad hardcodeada', () => {
    expect(timezoneCityLabel('Pacific/Port_Moresby')).toBe('Port Moresby')
  })
})

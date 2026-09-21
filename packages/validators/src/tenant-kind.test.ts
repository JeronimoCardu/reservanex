import { describe, expect, it } from 'vitest'
import {
  TENANT_KINDS,
  TENANT_KIND_LABELS,
  tenantKindSchema,
  clientTypeSchema,
  mappingForTenantKind,
  tenantKindFrom,
  tenantKindLabel,
  planLimitsForTenantKind,
  foodCapabilitiesFrom,
  canAcceptFoodOrders,
  enabledFulfillments,
  isFulfillmentEnabled,
  DEFAULT_FOOD_CAPABILITIES,
  getFormDefinition,
  type TenantKind,
  type FoodCapabilities,
} from './index'

// ════════════════════════════════════════════════════════════════════════════
// Tres tipos comerciales sobre dos verticales, y las capacidades del local.
// ════════════════════════════════════════════════════════════════════════════

describe('tipos de cliente', () => {
  it('28. son exactamente tres, y ninguno es un vertical nuevo', () => {
    expect([...TENANT_KINDS]).toEqual(['agency', 'private_owner', 'food_business'])
    const verticales = new Set(TENANT_KINDS.map((k) => mappingForTenantKind(k).vertical))
    expect([...verticales].sort()).toEqual(['food_service', 'real_estate'])
  })

  it('28. agency y private_owner persisten como real_estate', () => {
    expect(mappingForTenantKind('agency')).toEqual({ vertical: 'real_estate', clientType: 'agency' })
    expect(mappingForTenantKind('private_owner')).toEqual({ vertical: 'real_estate', clientType: 'private_owner' })
  })

  it('28. gastronomía persiste como food_service con client_type NULL', () => {
    // NULL no es "sin definir": es "no aplica". La base lo garantiza con un
    // CHECK de coherencia, esto fija el lado del código.
    expect(mappingForTenantKind('food_business')).toEqual({ vertical: 'food_service', clientType: null })
  })

  it('28. un tipo desconocido falla cerrado en el schema', () => {
    for (const malo of ['car_dealership', 'REAL_ESTATE', 'agency ', '', 'food_service']) {
      expect(tenantKindSchema.safeParse(malo).success, malo).toBe(false)
    }
    expect(clientTypeSchema.safeParse('food_business').success).toBe(false)
  })

  it('ida y vuelta: lo que se guarda se vuelve a leer como el mismo tipo', () => {
    for (const k of TENANT_KINDS) {
      const { vertical, clientType } = mappingForTenantKind(k)
      expect(tenantKindFrom(vertical, clientType), k).toBe(k)
    }
  })

  it('un real_estate sin client_type se lee como agency', () => {
    // Es lo que era todo antes de que la columna existiera. Tolerar el dato
    // viejo en lectura no debilita nada: la coherencia la impone el CHECK.
    expect(tenantKindFrom('real_estate', null)).toBe('agency')
    expect(tenantKindFrom('real_estate', undefined)).toBe('agency')
  })

  it('18. las etiquetas son de producto, nunca valores técnicos', () => {
    expect(TENANT_KIND_LABELS).toEqual({
      agency: 'Inmobiliaria', private_owner: 'Particular', food_business: 'Gastronomía',
    })
    for (const k of TENANT_KINDS) {
      const label = tenantKindLabel(...Object.values(mappingForTenantKind(k)) as [string, string | null])
      expect(label).not.toMatch(/real_estate|food_service|agency|private_owner/)
    }
  })
})

describe('29. topes de plan', () => {
  it('particular: 5 propiedades y 3 usuarios contando al owner', () => {
    expect(planLimitsForTenantKind('private_owner')).toEqual({
      maxProperties: 5, maxUsers: 3, maxOwners: 1, maxReceptionists: 2,
    })
  })

  it('el 1 owner + 2 agentes cierra en el total de 3', () => {
    const l = planLimitsForTenantKind('private_owner')
    expect(l.maxOwners! + l.maxReceptionists!).toBe(l.maxUsers)
  })

  it('agency no hereda esos topes: todo NULL = sin límite', () => {
    expect(planLimitsForTenantKind('agency')).toEqual({
      maxProperties: null, maxUsers: null, maxOwners: null, maxReceptionists: null,
    })
  })

  it('gastronomía tampoco tiene topes de propiedades ni usuarios', () => {
    expect(planLimitsForTenantKind('food_business').maxUsers).toBeNull()
  })

  it('25. sin límite es NULL, no un número enorme', () => {
    // Un centinela grande obligaría a la UI a decidir qué es "demasiado" y
    // terminaría mostrando "3 de 999999".
    for (const k of ['agency', 'food_business'] as TenantKind[]) {
      for (const v of Object.values(planLimitsForTenantKind(k))) expect(v).toBeNull()
    }
  })

  it('los objetos devueltos no se comparten entre llamadas', () => {
    const a = planLimitsForTenantKind('private_owner')
    a.maxProperties = 99
    expect(planLimitsForTenantKind('private_owner').maxProperties).toBe(5)
  })
})

// ── Capacidades gastronómicas ───────────────────────────────────────────────

const caps = (d: boolean, t: boolean, r: boolean): FoodCapabilities =>
  ({ delivery: d, takeaway: t, tableReservations: r })

const fila = (d: boolean, t: boolean, r: boolean) => ({
  vertical: 'food_service',
  delivery_enabled: d, takeaway_enabled: t, table_reservations_enabled: r,
})

describe('30. capacidades del local — las ocho combinaciones', () => {
  const TABLA: Array<[boolean, boolean, boolean, boolean, string[]]> = [
    // D      T      R      ¿toma pedidos?  fulfillments ofrecidos
    [true,  true,  true,  true,  ['delivery', 'takeaway']],
    [true,  false, true,  true,  ['delivery']],
    [false, true,  true,  true,  ['takeaway']],
    [false, false, true,  false, []],
    [true,  true,  false, true,  ['delivery', 'takeaway']],
    [true,  false, false, true,  ['delivery']],
    [false, true,  false, true,  ['takeaway']],
    [false, false, false, false, []],
  ]

  it.each(TABLA)('D=%s T=%s R=%s → pedidos=%s', (d, t, r, tomaPedidos, fulfillments) => {
    const c = foodCapabilitiesFrom(fila(d, t, r))
    expect(c).toEqual(caps(d, t, r))
    expect(canAcceptFoodOrders(c)).toBe(tomaPedidos)
    expect(enabledFulfillments(c)).toEqual(fulfillments)
  })

  it.each(TABLA)('D=%s T=%s R=%s → el checkout ofrece exactamente eso', (d, t, r, _p, fulfillments) => {
    // La MISMA función que dibuja el select la usa el servidor para validar.
    const def = getFormDefinition({
      intent: 'food_order',
      enabledFulfillments: enabledFulfillments(foodCapabilitiesFrom(fila(d, t, r))),
    })
    const campo = def.fields.find((f) => f.name === 'fulfillment')!
    expect(campo.options!.map((o) => o.value)).toEqual(fulfillments)
  })

  it.each(TABLA)('D=%s T=%s R=%s → reservas de mesa = %s', (d, t, r) => {
    expect(foodCapabilitiesFrom(fila(d, t, r)).tableReservations).toBe(r)
  })

  it('un fulfillment deshabilitado nunca se acepta', () => {
    expect(isFulfillmentEnabled(caps(true, false, true), 'takeaway')).toBe(false)
    expect(isFulfillmentEnabled(caps(false, true, true), 'delivery')).toBe(false)
    expect(isFulfillmentEnabled(caps(true, true, true), 'delivery')).toBe(true)
    // Y un valor inventado tampoco.
    expect(isFulfillmentEnabled(caps(true, true, true), 'drone')).toBe(false)
    expect(isFulfillmentEnabled(caps(true, true, true), '')).toBe(false)
  })
})

describe('capacidades: bordes', () => {
  it('un tenant que no es gastronómico no tiene capacidades gastronómicas', () => {
    // Todas en false, no en true: así ninguna pantalla inmobiliaria las use
    // por accidente creyendo que "no configurado" significa "todo permitido".
    const c = foodCapabilitiesFrom({
      vertical: 'real_estate',
      delivery_enabled: true, takeaway_enabled: true, table_reservations_enabled: true,
    })
    expect(c).toEqual(caps(false, false, false))
    expect(canAcceptFoodOrders(c)).toBe(false)
  })

  it('el default de un local nuevo es todo habilitado', () => {
    expect(DEFAULT_FOOD_CAPABILITIES).toEqual(caps(true, true, true))
  })

  it('sin las columnas, se asume habilitado (el default de la base)', () => {
    expect(foodCapabilitiesFrom({ vertical: 'food_service' })).toEqual(caps(true, true, true))
  })

  it('sin capacidades declaradas, la definición del formulario queda completa', () => {
    // Para cualquier lector fuera del contexto de un tenant concreto.
    const def = getFormDefinition({ intent: 'food_order' })
    expect(def.fields.find((f) => f.name === 'fulfillment')!.options!.map((o) => o.value))
      .toEqual(['delivery', 'takeaway'])
  })

  it('el filtro no toca los otros intents', () => {
    const def = getFormDefinition({ intent: 'table_reservation', enabledFulfillments: [] })
    expect(def.fields.length).toBeGreaterThan(0)
  })
})

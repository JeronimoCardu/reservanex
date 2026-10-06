import { describe, expect, it } from 'vitest'
import { formIntentSchema } from '@orderflow/validators'
import {
  FORM_INTENT_GROUPS,
  groupForIntent,
  intentsInGroup,
  PROPOSED_CONTACT_PER_IP_LIMITS,
  PROPOSED_FORM_GROUP_LIMITS,
  PROPOSED_FORMS_PER_IP_LIMITS,
  type WindowLimit,
} from './policy'

describe('grupos de FormIntent', () => {
  it('el mapping completo es exactamente el acordado', () => {
    expect({
      consultas: intentsInGroup('consultas').sort(),
      reservas:  intentsInGroup('reservas').sort(),
      pedidos:   intentsInGroup('pedidos').sort(),
    }).toEqual({
      consultas: ['general_inquiry', 'monthly_rental_inquiry', 'property_inquiry'],
      reservas:  ['property_visit', 'table_reservation', 'temporary_rental'],
      pedidos:   ['food_order'],
    })
  })

  // Si mañana se agrega un intent a formIntentSchema sin asignarle grupo, esto
  // rompe: el nuevo intent no está en ningún grupo.
  it('TODO FormIntent existente cae en exactamente un grupo', () => {
    for (const intent of formIntentSchema.options) {
      const grupos = FORM_INTENT_GROUPS.filter((g) => intentsInGroup(g).includes(intent))
      expect(grupos, intent).toHaveLength(1)
      expect(groupForIntent(intent), intent).toBe(grupos[0])
    }
  })

  it('no hay intents en los grupos que no existan en formIntentSchema', () => {
    const agrupados = FORM_INTENT_GROUPS.flatMap((g) => intentsInGroup(g)).sort()
    expect(agrupados).toEqual([...formIntentSchema.options].sort())
  })

  it('ningún grupo queda vacío', () => {
    for (const g of FORM_INTENT_GROUPS) expect(intentsInGroup(g).length, g).toBeGreaterThan(0)
  })
})

describe('política propuesta (constantes, sin storage)', () => {
  function expectCoherente(limits: readonly WindowLimit[], label: string) {
    expect(limits.length, label).toBeGreaterThan(0)
    for (const l of limits) {
      expect(Number.isInteger(l.windowSeconds) && l.windowSeconds > 0, label).toBe(true)
      expect(l.windowSeconds, label).toBeLessThanOrEqual(86_400)
      expect(Number.isInteger(l.max) && l.max >= 1, label).toBe(true)
    }
    // Una ventana más larga nunca permite MENOS que una más corta.
    for (let i = 1; i < limits.length; i++) {
      expect(limits[i]!.windowSeconds, label).toBeGreaterThan(limits[i - 1]!.windowSeconds)
      expect(limits[i]!.max, label).toBeGreaterThanOrEqual(limits[i - 1]!.max)
    }
  }

  it('cada grupo tiene límites coherentes', () => {
    for (const g of FORM_INTENT_GROUPS) expectCoherente(PROPOSED_FORM_GROUP_LIMITS[g], g)
  })

  it('los límites por IP y de contacto son coherentes', () => {
    expectCoherente(PROPOSED_FORMS_PER_IP_LIMITS, 'forms por IP')
    expectCoherente(PROPOSED_CONTACT_PER_IP_LIMITS, 'contacto por IP')
  })

  it('los pedidos tienen al menos el margen de las consultas (reintentos por 409)', () => {
    expect(PROPOSED_FORM_GROUP_LIMITS.pedidos[0]!.max)
      .toBeGreaterThanOrEqual(PROPOSED_FORM_GROUP_LIMITS.consultas[0]!.max)
  })
})

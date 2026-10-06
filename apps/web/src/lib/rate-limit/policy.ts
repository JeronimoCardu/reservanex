// Rate limiting — Fase 1A: política, SIN storage.
//
// Este módulo no cuenta nada ni habla con ninguna base. Define dos cosas:
//
//   1. a qué GRUPO pertenece cada FormIntent. Los grupos existen porque una
//      persona real no consulta, reserva y pide con la misma cadencia: un
//      pedido puede reintentarse varias veces (409 de precio o de carrito) y
//      una consulta casi nunca.
//   2. los números PROPUESTOS en la auditoría, como constantes testeables.
//      Son una propuesta: no se aplican en ningún lado todavía. El adapter de
//      la Fase 1B los va a leer de acá en vez de duplicarlos en SQL.
//
// Por tenant NO hay tope duro, y no por olvido: un tope que bloquea a todo el
// tenant le da al atacante una forma de dejar sin servicio a los clientes
// reales de ese local. Por tenant sólo se alerta.

import type { FormIntent } from '@orderflow/validators'

/** Endpoints públicos que van a tener limitador. Forman parte de la clave. */
export const RATE_LIMIT_ENDPOINTS = ['public_forms', 'contact'] as const
export type RateLimitEndpoint = (typeof RATE_LIMIT_ENDPOINTS)[number]

export const FORM_INTENT_GROUPS = ['consultas', 'reservas', 'pedidos'] as const
export type FormIntentGroup = (typeof FORM_INTENT_GROUPS)[number]

// Record<FormIntent, …>: si mañana se agrega un intent a formIntentSchema y no
// se lo asigna acá, falla el typecheck — y policy.test.ts falla igual en
// runtime, recorriendo formIntentSchema.options.
const GROUP_BY_INTENT: Readonly<Record<FormIntent, FormIntentGroup>> = {
  general_inquiry:        'consultas',
  property_inquiry:       'consultas',
  monthly_rental_inquiry: 'consultas',
  temporary_rental:       'reservas',
  property_visit:         'reservas',
  table_reservation:      'reservas',
  food_order:             'pedidos',
}

export function groupForIntent(intent: FormIntent): FormIntentGroup {
  return GROUP_BY_INTENT[intent]
}

export function intentsInGroup(group: FormIntentGroup): FormIntent[] {
  return (Object.keys(GROUP_BY_INTENT) as FormIntent[]).filter((i) => GROUP_BY_INTENT[i] === group)
}

// ── Política propuesta (auditoría de Rate Limiting) ─────────────────────────

export interface WindowLimit {
  readonly windowSeconds: number
  readonly max:           number
}

/**
 * Límites por IP + tenant + grupo. Dos ventanas por grupo: la corta frena la
 * ráfaga, la larga el goteo sostenido. Los pedidos tienen más margen porque un
 * 409 (precio o carrito cambiado) más algún reintento suma hasta ~4 envíos
 * legítimos, y porque las operadoras móviles comparten IPs (CGNAT).
 */
export const PROPOSED_FORM_GROUP_LIMITS: Readonly<Record<FormIntentGroup, readonly WindowLimit[]>> = {
  consultas: [{ windowSeconds: 600, max: 5 },  { windowSeconds: 86_400, max: 20 }],
  reservas:  [{ windowSeconds: 600, max: 5 },  { windowSeconds: 86_400, max: 15 }],
  pedidos:   [{ windowSeconds: 600, max: 10 }, { windowSeconds: 86_400, max: 40 }],
}

/** Por IP, sumando todos los intents de todos los tenants. */
export const PROPOSED_FORMS_PER_IP_LIMITS: readonly WindowLimit[] = [
  { windowSeconds: 600, max: 30 },
]

/** /api/contact, por IP. El tope global (cuota de Resend) es de la Fase 1B. */
export const PROPOSED_CONTACT_PER_IP_LIMITS: readonly WindowLimit[] = [
  { windowSeconds: 600,    max: 3 },
  { windowSeconds: 86_400, max: 10 },
]

/** Por tenant: SÓLO alerta en logs. Nunca bloquea (ver arriba). */
export const PROPOSED_TENANT_ALERT = { windowSeconds: 3_600, threshold: 100 } as const

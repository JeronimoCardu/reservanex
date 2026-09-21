import { z } from 'zod'
import { tenantVerticalSchema, type TenantVertical } from './forms'

// ════════════════════════════════════════════════════════════════════════════
// Los TRES tipos de cliente, sobre DOS verticales.
//
// El producto vende Inmobiliaria, Particular y Gastronomía. El sistema tiene
// dos verticales. Particular no es un vertical: es una inmobiliaria con tope.
// Meterlo en `vertical` habría duplicado módulos, guards y formularios por
// intent para no ganar nada — un particular alquila propiedades igual que una
// inmobiliaria, sólo que menos.
//
// La representación es el PAR (vertical, client_type), que en la base tiene un
// CHECK de coherencia para que la combinación inválida no pueda existir:
//
//   real_estate  + 'agency'         → Inmobiliaria
//   real_estate  + 'private_owner'  → Particular
//   food_service + NULL             → Gastronomía
//
// `client_type` es NULL para gastronomía a propósito: no es "sin definir", es
// "no aplica".
//
// Este módulo es el único lugar donde se traduce entre el tipo que elige una
// persona en el alta y el par que se guarda. Todo lo demás lee de acá.
// ════════════════════════════════════════════════════════════════════════════

/** Lo que se guarda en tenants.client_type. NULL en food_service. */
export const clientTypeSchema = z.enum(['agency', 'private_owner'])
export type ClientType = z.infer<typeof clientTypeSchema>

/**
 * Lo que se ELIGE en el alta. Tres opciones, una por tipo comercial.
 *
 * Es distinto de ClientType a propósito: ClientType sólo existe dentro de
 * real_estate, y gastronomía no tiene ninguno. Si se usara el mismo tipo para
 * las dos cosas habría que inventar un 'food' que la base no acepta.
 */
export const tenantKindSchema = z.enum(['agency', 'private_owner', 'food_business'])
export type TenantKind = z.infer<typeof tenantKindSchema>

/** Cómo se llaman de cara a una persona. Nunca se muestran los valores técnicos. */
export const TENANT_KIND_LABELS: Record<TenantKind, string> = {
  agency:        'Inmobiliaria',
  private_owner: 'Particular',
  food_business: 'Gastronomía',
}

/** Una línea de ayuda para el selector del alta. */
export const TENANT_KIND_HINTS: Record<TenantKind, string> = {
  agency:        'Agencia con cartera de propiedades y equipo.',
  private_owner: 'Persona que publica sus propias propiedades. Hasta 5 propiedades y 3 usuarios.',
  food_business: 'Restaurante, bar o similar. Carta, pedidos y reservas de mesa.',
}

/** El orden en que se ofrecen. */
export const TENANT_KINDS: readonly TenantKind[] = ['agency', 'private_owner', 'food_business']

// ── Traducción tipo ↔ (vertical, client_type) ───────────────────────────────

export interface TenantKindMapping {
  vertical:   TenantVertical
  clientType: ClientType | null
}

const MAPPING: Record<TenantKind, TenantKindMapping> = {
  agency:        { vertical: 'real_estate',  clientType: 'agency'        },
  private_owner: { vertical: 'real_estate',  clientType: 'private_owner' },
  food_business: { vertical: 'food_service', clientType: null            },
}

export function mappingForTenantKind(kind: TenantKind): TenantKindMapping {
  return MAPPING[kind]
}

/**
 * El camino inverso: qué tipo es un tenant ya guardado.
 *
 * Tolera datos raros en vez de romper una pantalla: un real_estate sin
 * client_type se lee como 'agency', que es lo que era todo antes de que esta
 * columna existiera. La coherencia de verdad la garantiza el CHECK de la base.
 */
export function tenantKindFrom(
  vertical: string | null | undefined,
  clientType: string | null | undefined,
): TenantKind {
  if (vertical === 'food_service') return 'food_business'
  return clientType === 'private_owner' ? 'private_owner' : 'agency'
}

export function tenantKindLabel(
  vertical: string | null | undefined,
  clientType: string | null | undefined,
): string {
  return TENANT_KIND_LABELS[tenantKindFrom(vertical, clientType)]
}

// ── Los topes de producto de cada tipo ──────────────────────────────────────

/**
 * NULL significa SIN LÍMITE, igual que en la base.
 *
 * No es lo mismo que un número muy grande: la UI de una inmobiliaria no
 * muestra "3 de ∞", simplemente no habla de topes.
 */
export interface TenantPlanLimits {
  maxProperties:    number | null
  maxUsers:         number | null
  maxOwners:        number | null
  maxReceptionists: number | null
}

const SIN_LIMITE: TenantPlanLimits = {
  maxProperties: null, maxUsers: null, maxOwners: null, maxReceptionists: null,
}

/**
 * Particular: 5 propiedades y 3 usuarios EN TOTAL, contando al owner.
 * De ahí sale 1 owner + 2 recepcionistas como máximo por rol.
 */
const LIMITES_PARTICULAR: TenantPlanLimits = {
  maxProperties: 5, maxUsers: 3, maxOwners: 1, maxReceptionists: 2,
}

export function planLimitsForTenantKind(kind: TenantKind): TenantPlanLimits {
  return kind === 'private_owner' ? { ...LIMITES_PARTICULAR } : { ...SIN_LIMITE }
}

// ── Capabilities gastronómicas ──────────────────────────────────────────────

export interface FoodCapabilities {
  delivery:          boolean
  takeaway:          boolean
  tableReservations: boolean
}

export const foodCapabilitiesSchema = z.object({
  delivery:          z.boolean(),
  takeaway:          z.boolean(),
  tableReservations: z.boolean(),
})

/** Un restaurante nuevo arranca con todo disponible y apaga lo que no ofrece. */
export const DEFAULT_FOOD_CAPABILITIES: FoodCapabilities = {
  delivery: true, takeaway: true, tableReservations: true,
}

/**
 * Lee las capabilities de una fila de tenants.
 *
 * Un tenant que no es gastronómico no tiene capacidades gastronómicas: se
 * devuelven todas en false para que ninguna pantalla las use por accidente.
 */
export function foodCapabilitiesFrom(row: {
  vertical?: string | null
  delivery_enabled?: boolean | null
  takeaway_enabled?: boolean | null
  table_reservations_enabled?: boolean | null
}): FoodCapabilities {
  if (row.vertical !== 'food_service') {
    return { delivery: false, takeaway: false, tableReservations: false }
  }
  return {
    delivery:          row.delivery_enabled           !== false,
    takeaway:          row.takeaway_enabled           !== false,
    tableReservations: row.table_reservations_enabled !== false,
  }
}

/** ¿Se pueden generar pedidos nuevos? Con las dos apagadas, no. */
export function canAcceptFoodOrders(caps: FoodCapabilities): boolean {
  return caps.delivery || caps.takeaway
}

export type Fulfillment = 'delivery' | 'takeaway'

/** Los fulfillment habilitados, en el orden en que se ofrecen. */
export function enabledFulfillments(caps: FoodCapabilities): Fulfillment[] {
  const out: Fulfillment[] = []
  if (caps.delivery) out.push('delivery')
  if (caps.takeaway) out.push('takeaway')
  return out
}

export function isFulfillmentEnabled(caps: FoodCapabilities, value: string): boolean {
  if (value === 'delivery') return caps.delivery
  if (value === 'takeaway') return caps.takeaway
  return false
}

// ── Alta de tenant ──────────────────────────────────────────────────────────

/**
 * El vertical NO se elige directamente en el alta: se deriva del tipo. Así no
 * existe la posibilidad de mandar un par incoherente desde el cliente.
 */
export const createTenantKindSchema = z.object({
  kind:         tenantKindSchema,
  capabilities: foodCapabilitiesSchema.optional(),
})

export { tenantVerticalSchema }

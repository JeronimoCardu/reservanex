// ════════════════════════════════════════════════════════════════════════════
// Los topes de plan, del lado de la aplicación.
//
// La AUTORIDAD son los triggers de la base (20260921000001): bloquean la fila
// del tenant y cuentan dentro de la misma transacción del INSERT, así que dos
// altas simultáneas no pueden colarse las dos. Contar en la app y después
// insertar es precisamente el patrón que la concurrencia rompe.
//
// Lo de acá cumple otro papel: dar un mensaje entendible antes de intentar, y
// traducir el error del trigger cuando la carrera efectivamente pasa. Si el
// chequeo previo y el trigger discrepan, gana el trigger — y el usuario ve un
// mensaje de dominio, no un 23514 crudo.
// ════════════════════════════════════════════════════════════════════════════

export type TenantLimitKind = 'properties' | 'users' | 'owners' | 'receptionists'

const MENSAJES: Record<TenantLimitKind, (max: string) => string> = {
  properties:    (max) => `Llegaste al máximo de ${max} propiedades de tu plan.`,
  users:         (max) => `Llegaste al máximo de ${max} usuarios de tu plan. El owner cuenta como uno.`,
  owners:        (max) => `Llegaste al máximo de ${max} administradores de tu plan.`,
  receptionists: (max) => `Llegaste al máximo de ${max} agentes de tu plan.`,
}

const PATRON = /TENANT_LIMIT_(PROPERTIES|USERS|OWNERS|RECEPTIONISTS):(\d+)/

/**
 * Traduce el error que levanta un trigger de límite.
 *
 * Devuelve null si el error es cualquier otra cosa — quien llama decide qué
 * hacer con eso, no se lo disfraza de "llegaste al límite".
 */
export function tenantLimitMessage(err: unknown): string | null {
  const texto =
    typeof err === 'string' ? err
    : err instanceof Error ? err.message
    : typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : ''

  const m = PATRON.exec(texto)
  if (!m) return null

  const kind = m[1]!.toLowerCase() as TenantLimitKind
  return MENSAJES[kind](m[2]!)
}

/**
 * Cuánto queda, para mostrar "3 de 5 utilizadas".
 *
 * Con límite nulo devuelve null: una inmobiliaria no muestra "3 de ∞", no
 * muestra nada.
 */
export interface LimitUsage {
  used:      number
  max:       number
  remaining: number
  reached:   boolean
}

export function limitUsage(used: number, max: number | null): LimitUsage | null {
  if (max === null) return null
  return {
    used,
    max,
    remaining: Math.max(max - used, 0),
    reached:   used >= max,
  }
}

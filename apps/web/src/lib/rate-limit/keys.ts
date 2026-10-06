// Rate limiting — Fase 1A: claves opacas para los buckets.
//
// Una clave es HMAC-SHA256(RATE_LIMIT_KEY_SECRET, material canónico). Nunca un
// SHA simple de la IP: el espacio IPv4 son 2^32 valores y se recorre entero en
// minutos, así que un hash sin secreto es la IP con otro formato. Con HMAC, una
// clave filtrada (logs, tabla de buckets) no dice nada sin el secreto.
//
// MATERIAL CANÓNICO
//
// Cada componente se serializa como `<bytes UTF-8>:<valor>` y se concatenan sin
// separador. El prefijo de longitud hace la codificación inyectiva: no hay dos
// listas de componentes distintas que produzcan el mismo texto, aunque los
// valores contengan ':' o dígitos. Concatenar con un separador fijo ('a|b')
// no lo garantiza.
//
// Los componentes van siempre en el mismo orden:
//   versión, scope, kind de identidad, valor de identidad, [tenant], [endpoint], [grupo]
// El scope está en el material, así que un tenant 'x' y un endpoint 'x' en
// scopes distintos nunca colisionan.
//
// SECRETO
//
// RATE_LIMIT_KEY_SECRET: al menos 32 bytes, ASCII imprimible (en producción,
// 32 bytes aleatorios codificados en hex o base64url: `openssl rand -hex 32`).
// Se mide en BYTES, no en caracteres. Si falta, es corto o trae caracteres
// fuera de ASCII imprimible NO hay fallback: se devuelve un error explícito, y
// qué hacer con él — dejar pasar o cortar — lo decide cada consumidor del
// limiter, no este módulo. El secreto nunca se loguea ni sale de acá.
//
// Rotarlo cambia todas las claves: los buckets arrancan de cero. Es aceptable.

import { createHmac } from 'node:crypto'
import type { ClientIdentity } from './client-ip'
import type { FormIntentGroup, RateLimitEndpoint } from './policy'

export const RATE_LIMIT_KEY_VERSION = 'rl1'

/** Largo mínimo del secreto, en bytes. */
export const MIN_RATE_LIMIT_SECRET_BYTES = 32

// ASCII imprimible sin espacio (0x21–0x7E): cubre hex, base64 y base64url.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

export type RateLimitScope = 'ip' | 'ip_tenant' | 'ip_endpoint' | 'ip_tenant_group'

/**
 * La forma exacta de una clave. La migración de rate_limit_buckets valida con
 * el MISMO patrón (CHECK de la tabla y rate_limit_hit); rate-limit-sql.test.ts
 * falla si divergen.
 */
export const RATE_LIMIT_KEY_PATTERN = /^rl1\.(ip|ip_tenant|ip_endpoint|ip_tenant_group)\.[A-Za-z0-9_-]{43}$/

/**
 * `tenant` es la referencia estable del tenant que elija la Fase 1B (slug
 * normalizado o id). Este módulo no la normaliza: la usa tal cual llega.
 */
export type RateLimitKeySpec =
  | { scope: 'ip';              identity: ClientIdentity }
  | { scope: 'ip_tenant';       identity: ClientIdentity; tenant: string }
  | { scope: 'ip_endpoint';     identity: ClientIdentity; endpoint: RateLimitEndpoint }
  | { scope: 'ip_tenant_group'; identity: ClientIdentity; tenant: string; group: FormIntentGroup }

export type RateLimitKeyError = 'missing_secret' | 'weak_secret' | 'invalid_secret' | 'invalid_component'

export type RateLimitKeyResult =
  | { ok: true;  key: string }
  | { ok: false; error: RateLimitKeyError }

/**
 * Valida RATE_LIMIT_KEY_SECRET. Los espacios en los bordes (un salto de línea
 * pegado con el valor) se descartan; adentro no se admite ninguno.
 */
export function checkRateLimitSecret(
  secret: string | undefined,
): { ok: true; secret: string } | { ok: false; error: 'missing_secret' | 'weak_secret' | 'invalid_secret' } {
  const value = secret?.trim() ?? ''
  if (value === '') return { ok: false, error: 'missing_secret' }
  if (!PRINTABLE_ASCII.test(value)) return { ok: false, error: 'invalid_secret' }
  if (Buffer.byteLength(value, 'utf8') < MIN_RATE_LIMIT_SECRET_BYTES) return { ok: false, error: 'weak_secret' }
  return { ok: true, secret: value }
}

/** Serialización inyectiva: `<bytes UTF-8>:<valor>` por componente, sin separador. */
export function serializeKeyMaterial(components: readonly string[]): string {
  return components.map((c) => `${Buffer.byteLength(c, 'utf8')}:${c}`).join('')
}

function componentsFor(spec: RateLimitKeySpec): string[] {
  const base = [RATE_LIMIT_KEY_VERSION, spec.scope, spec.identity.kind, spec.identity.value]
  switch (spec.scope) {
    case 'ip':              return base
    case 'ip_tenant':       return [...base, spec.tenant]
    case 'ip_endpoint':     return [...base, spec.endpoint]
    case 'ip_tenant_group': return [...base, spec.tenant, spec.group]
  }
}

/**
 * La clave opaca del bucket: `rl1.<scope>.<HMAC en base64url>`.
 *
 * El scope queda visible a propósito (sirve para operar la tabla de buckets);
 * la IP, el tenant, el endpoint y el grupo sólo existen dentro del HMAC.
 */
export function buildRateLimitKey(spec: RateLimitKeySpec, secret: string | undefined): RateLimitKeyResult {
  const checked = checkRateLimitSecret(secret)
  if (!checked.ok) return checked
  const key = checked.secret

  const components = componentsFor(spec)
  if (components.some((c) => c === '')) return { ok: false, error: 'invalid_component' }

  const mac = createHmac('sha256', key).update(serializeKeyMaterial(components), 'utf8').digest('base64url')
  return { ok: true, key: `${RATE_LIMIT_KEY_VERSION}.${spec.scope}.${mac}` }
}

// Rate limiting — Fase 1B: adapter de la RPC rate_limit_hit.
//
// Recibe un plan ya resuelto (plans.ts), deriva las claves HMAC (keys.ts),
// llama a la RPC con timeout y clasifica lo que pasó. NO decide qué hacer con
// eso: dejar pasar o cortar es de cada consumidor (forms deja pasar si el
// limiter falla; contact corta con 503). Por eso los resultados están
// separados en cinco:
//
//   allowed           ningún bucket superó su límite
//   blocked           un límite VÁLIDO se superó — el único caso de 429
//   backend_error     la RPC falló, tiró, tardó más que el timeout o respondió
//                     algo con otra forma
//   config_error      el secreto falta o no sirve, o el plan está fuera de lo
//                     que acepta la RPC — no se llamó a la base
//   unknown_identity  no hay una IP confiable — no se llamó a la base
//
// Nada de acá loguea. Los resultados no llevan IP, slug, secreto ni claves, así
// que rateLimitLogFields() puede ir tal cual a un log. Para diagnosticar un
// bucket puntual existe keyLogTag(): scope + 6 caracteres del HMAC.

import { buildRateLimitKey } from './keys'
import type { RateLimitPlanEntry } from './plans'

export const RATE_LIMIT_RPC_TIMEOUT_MS = 500

// Los mismos topes que valida rate_limit_hit en SQL; rate-limit-sql.test.ts
// falla si divergen de la migración. Chequearlos acá evita un viaje a la base
// con un plan que la RPC rechazaría igual.
export const RATE_LIMIT_MAX_BUCKETS_PER_CALL = 8
export const RATE_LIMIT_MAX_WINDOW_SECONDS   = 86_400
export const RATE_LIMIT_MAX_LIMIT            = 10_000

/** Una entrada de p_buckets, tal como la recibe rate_limit_hit. */
export interface RateLimitRpcBucket {
  bucket_key:     string
  window_seconds: number
  limit:          number
}

export interface RateLimitRpcResult {
  data:  unknown
  error: { code?: string } | null
}

/** La llamada a la base. Inyectable para tests; la real está en supabase-rpc.ts. */
export type RateLimitRpc = (
  buckets: RateLimitRpcBucket[],
  signal:  AbortSignal,
) => PromiseLike<RateLimitRpcResult>

export type RateLimitConfigReason =
  | 'missing_secret'
  | 'weak_secret'
  | 'invalid_secret'
  | 'invalid_component'
  | 'invalid_plan'

export type RateLimitBackendReason = 'timeout' | 'rpc_error' | 'rpc_threw' | 'invalid_response'

export type RateLimitOutcome =
  | { kind: 'allowed' }
  | { kind: 'blocked';          retryAfterSeconds: number }
  | { kind: 'backend_error';    reason: RateLimitBackendReason; errorCode?: string }
  | { kind: 'config_error';     reason: RateLimitConfigReason }
  | { kind: 'unknown_identity' }

type ResolvedBuckets =
  | { ok: true;  buckets: RateLimitRpcBucket[] }
  | { ok: false; reason: RateLimitConfigReason }

function isValidWindow(windowSeconds: number, max: number): boolean {
  return (
    Number.isInteger(windowSeconds) && windowSeconds >= 1 && windowSeconds <= RATE_LIMIT_MAX_WINDOW_SECONDS &&
    Number.isInteger(max) && max >= 1 && max <= RATE_LIMIT_MAX_LIMIT
  )
}

/** Plan → entradas de p_buckets, con las claves ya opacas. */
export function resolveRateLimitBuckets(
  plan:   readonly RateLimitPlanEntry[],
  secret: string | undefined,
): ResolvedBuckets {
  if (plan.length === 0) return { ok: false, reason: 'invalid_plan' }

  const buckets: RateLimitRpcBucket[] = []
  for (const entry of plan) {
    const key = buildRateLimitKey(entry.spec, secret)
    if (!key.ok) return { ok: false, reason: key.error }
    if (entry.limits.length === 0) return { ok: false, reason: 'invalid_plan' }

    for (const limit of entry.limits) {
      if (!isValidWindow(limit.windowSeconds, limit.max)) return { ok: false, reason: 'invalid_plan' }
      buckets.push({ bucket_key: key.key, window_seconds: limit.windowSeconds, limit: limit.max })
    }
  }

  if (buckets.length > RATE_LIMIT_MAX_BUCKETS_PER_CALL) return { ok: false, reason: 'invalid_plan' }

  const unique = new Set(buckets.map((b) => `${b.bucket_key} ${b.window_seconds}`))
  if (unique.size !== buckets.length) return { ok: false, reason: 'invalid_plan' }

  return { ok: true, buckets }
}

type CallResult =
  | { kind: 'settled'; result: RateLimitRpcResult }
  | { kind: 'threw' }
  | { kind: 'timeout' }

// Corre la RPC contra un timeout. Al vencer, aborta el request (el signal
// llega hasta fetch) y resuelve 'timeout'. La rama de la RPC tiene su handler
// de rechazo puesto ANTES de la carrera, así que un rechazo que llegue después
// del timeout queda manejado: no hay unhandled rejections. Un throw
// sincrónico de rpc() también cae ahí, por el Promise.resolve().then().
async function callWithTimeout(
  rpc:       RateLimitRpc,
  buckets:   RateLimitRpcBucket[],
  timeoutMs: number,
): Promise<CallResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<CallResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ kind: 'timeout' })
    }, timeoutMs)
  })

  const call = Promise.resolve()
    .then(() => rpc(buckets, controller.signal))
    .then(
      (result): CallResult => ({ kind: 'settled', result }),
      (): CallResult => ({ kind: 'threw' }),
    )

  try {
    return await Promise.race([call, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// La respuesta tiene que ser exactamente la que promete la RPC. Cualquier otra
// forma es un contrato roto, no un "allowed" por defecto.
function outcomeFromData(data: unknown): RateLimitOutcome {
  const invalid: RateLimitOutcome = { kind: 'backend_error', reason: 'invalid_response' }
  if (typeof data !== 'object' || data === null) return invalid

  const { allowed, retry_after_seconds: retry } = data as Record<string, unknown>
  if (typeof allowed !== 'boolean' || typeof retry !== 'number' || !Number.isInteger(retry)) return invalid

  if (allowed) return retry === 0 ? { kind: 'allowed' } : invalid
  if (retry < 1 || retry > RATE_LIMIT_MAX_WINDOW_SECONDS) return invalid
  return { kind: 'blocked', retryAfterSeconds: retry }
}

export async function checkRateLimit(params: {
  plan:       readonly RateLimitPlanEntry[]
  secret:     string | undefined
  rpc:        RateLimitRpc
  timeoutMs?: number
}): Promise<RateLimitOutcome> {
  // Sin identidad confiable no se arma ninguna clave ni se toca la base.
  if (params.plan.some((entry) => entry.spec.identity.kind === 'unknown')) {
    return { kind: 'unknown_identity' }
  }

  const resolved = resolveRateLimitBuckets(params.plan, params.secret)
  if (!resolved.ok) return { kind: 'config_error', reason: resolved.reason }

  const call = await callWithTimeout(params.rpc, resolved.buckets, params.timeoutMs ?? RATE_LIMIT_RPC_TIMEOUT_MS)

  if (call.kind === 'timeout') return { kind: 'backend_error', reason: 'timeout' }
  if (call.kind === 'threw')   return { kind: 'backend_error', reason: 'rpc_threw' }

  const { data, error } = call.result
  if (error) {
    return typeof error.code === 'string'
      ? { kind: 'backend_error', reason: 'rpc_error', errorCode: error.code }
      : { kind: 'backend_error', reason: 'rpc_error' }
  }

  return outcomeFromData(data)
}

/**
 * Lo que un consumidor puede loguear de un resultado. Sale sólo de
 * RateLimitOutcome, que nunca lleva IP, slug, secreto ni clave.
 */
export function rateLimitLogFields(outcome: RateLimitOutcome): Record<string, string | number> {
  switch (outcome.kind) {
    case 'allowed':
    case 'unknown_identity':
      return { outcome: outcome.kind }
    case 'blocked':
      return { outcome: outcome.kind, retryAfterSeconds: outcome.retryAfterSeconds }
    case 'config_error':
      return { outcome: outcome.kind, reason: outcome.reason }
    case 'backend_error':
      return outcome.errorCode
        ? { outcome: outcome.kind, reason: outcome.reason, errorCode: outcome.errorCode }
        : { outcome: outcome.kind, reason: outcome.reason }
  }
}

/** Etiqueta corta y opaca de una clave para logs: `rl1.<scope>.<6 chars>`. */
export function keyLogTag(key: string): string {
  const lastDot = key.lastIndexOf('.')
  return lastDot < 0 ? 'rl?' : `${key.slice(0, lastDot)}.${key.slice(lastDot + 1, lastDot + 7)}`
}

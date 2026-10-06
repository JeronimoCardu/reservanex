import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientIdentity } from './client-ip'
import { RATE_LIMIT_KEY_PATTERN } from './keys'
import {
  checkRateLimit,
  keyLogTag,
  RATE_LIMIT_MAX_BUCKETS_PER_CALL,
  RATE_LIMIT_RPC_TIMEOUT_MS,
  rateLimitLogFields,
  resolveRateLimitBuckets,
  type RateLimitOutcome,
  type RateLimitRpc,
  type RateLimitRpcBucket,
  type RateLimitRpcResult,
} from './limiter'
import { contactRateLimitPlan, formsRateLimitPlan, type RateLimitPlanEntry } from './plans'

const SECRET = 'k'.repeat(64)
const RAW_IP = '203.0.113.7'
const SLUG   = 'Pizzeria-Demo'
const IP: ClientIdentity = { kind: 'ip', value: RAW_IP }

const FORMS = formsRateLimitPlan({ identity: IP, tenantSlug: SLUG, intent: 'food_order' })

function rpcReturning(result: RateLimitRpcResult) {
  const calls: { buckets: RateLimitRpcBucket[]; signal: AbortSignal }[] = []
  const rpc: RateLimitRpc = async (buckets, signal) => {
    calls.push({ buckets, signal })
    return result
  }
  return { rpc, calls }
}

const ALLOWED = { data: { allowed: true, retry_after_seconds: 0 }, error: null }

afterEach(() => {
  vi.useRealTimers()
})

describe('checkRateLimit — resultados', () => {
  it('allowed', async () => {
    const { rpc, calls } = rpcReturning(ALLOWED)
    expect(await checkRateLimit({ plan: FORMS, secret: SECRET, rpc })).toEqual({ kind: 'allowed' })
    expect(calls).toHaveLength(1)
  })

  it('blocked lleva el retry de la RPC', async () => {
    const { rpc } = rpcReturning({ data: { allowed: false, retry_after_seconds: 120 }, error: null })
    expect(await checkRateLimit({ plan: FORMS, secret: SECRET, rpc }))
      .toEqual({ kind: 'blocked', retryAfterSeconds: 120 })
  })

  it('error de la RPC → backend_error con el código, sin el mensaje', async () => {
    const { rpc } = rpcReturning({ data: null, error: { code: '22023', message: 'detalle interno' } as never })
    const out = await checkRateLimit({ plan: FORMS, secret: SECRET, rpc })
    expect(out).toEqual({ kind: 'backend_error', reason: 'rpc_error', errorCode: '22023' })
    expect(JSON.stringify(out)).not.toContain('detalle interno')
  })

  it('error sin código → backend_error rpc_error', async () => {
    const { rpc } = rpcReturning({ data: null, error: {} })
    expect(await checkRateLimit({ plan: FORMS, secret: SECRET, rpc }))
      .toEqual({ kind: 'backend_error', reason: 'rpc_error' })
  })

  it('la RPC tira sincrónicamente → backend_error rpc_threw', async () => {
    const rpc: RateLimitRpc = () => { throw new Error('boom') }
    expect(await checkRateLimit({ plan: FORMS, secret: SECRET, rpc }))
      .toEqual({ kind: 'backend_error', reason: 'rpc_threw' })
  })

  it('la RPC rechaza → backend_error rpc_threw', async () => {
    const rpc: RateLimitRpc = () => Promise.reject(new Error('network'))
    expect(await checkRateLimit({ plan: FORMS, secret: SECRET, rpc }))
      .toEqual({ kind: 'backend_error', reason: 'rpc_threw' })
  })

  it.each([
    ['null', null],
    ['un string', 'ok'],
    ['allowed no booleano', { allowed: 'yes', retry_after_seconds: 0 }],
    ['sin retry', { allowed: false }],
    ['allowed con retry > 0', { allowed: true, retry_after_seconds: 5 }],
    ['blocked con retry 0', { allowed: false, retry_after_seconds: 0 }],
    ['blocked con retry fraccional', { allowed: false, retry_after_seconds: 1.5 }],
    ['blocked con retry de más de 24 h', { allowed: false, retry_after_seconds: 86_401 }],
  ])('respuesta con otra forma (%s) → backend_error invalid_response', async (_label, data) => {
    const { rpc } = rpcReturning({ data, error: null })
    expect(await checkRateLimit({ plan: FORMS, secret: SECRET, rpc }))
      .toEqual({ kind: 'backend_error', reason: 'invalid_response' })
  })
})

describe('checkRateLimit — timeout', () => {
  it(`a los ${RATE_LIMIT_RPC_TIMEOUT_MS} ms → backend_error timeout, y aborta el request`, async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const rpc: RateLimitRpc = (_b, s) => {
      signal = s
      return new Promise<RateLimitRpcResult>(() => {})
    }

    const pending = checkRateLimit({ plan: FORMS, secret: SECRET, rpc })
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RPC_TIMEOUT_MS - 1)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(await pending).toEqual({ kind: 'backend_error', reason: 'timeout' })
    expect(signal?.aborted).toBe(true)
  })

  it('un rechazo que llega DESPUÉS del timeout queda manejado (sin unhandled rejection)', async () => {
    vi.useFakeTimers()
    const rpc: RateLimitRpc = () =>
      new Promise<RateLimitRpcResult>((_resolve, reject) => setTimeout(() => reject(new Error('tarde')), 2_000))

    const pending = checkRateLimit({ plan: FORMS, secret: SECRET, rpc })
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RPC_TIMEOUT_MS)
    expect(await pending).toEqual({ kind: 'backend_error', reason: 'timeout' })

    // Si el rechazo tardío no tuviera handler, vitest fallaría la corrida.
    await vi.advanceTimersByTimeAsync(2_000)
  })

  it('cuando la RPC responde a tiempo no queda ningún timer pendiente', async () => {
    vi.useFakeTimers()
    const { rpc } = rpcReturning(ALLOWED)
    expect(await checkRateLimit({ plan: FORMS, secret: SECRET, rpc })).toEqual({ kind: 'allowed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('el timeout es configurable', async () => {
    vi.useFakeTimers()
    const rpc: RateLimitRpc = () => new Promise<RateLimitRpcResult>(() => {})
    const pending = checkRateLimit({ plan: FORMS, secret: SECRET, rpc, timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toEqual({ kind: 'backend_error', reason: 'timeout' })
  })
})

describe('checkRateLimit — sin llamar a la base', () => {
  it.each([
    [undefined, 'missing_secret'],
    ['', 'missing_secret'],
    ['corto', 'weak_secret'],
    ['ñ'.repeat(40), 'invalid_secret'],
  ])('secreto %j → config_error %s', async (secret, reason) => {
    const { rpc, calls } = rpcReturning(ALLOWED)
    expect(await checkRateLimit({ plan: FORMS, secret, rpc })).toEqual({ kind: 'config_error', reason })
    expect(calls).toHaveLength(0)
  })

  it('identidad unknown → unknown_identity, aun sin secreto', async () => {
    const { rpc, calls } = rpcReturning(ALLOWED)
    const plan = formsRateLimitPlan({ identity: { kind: 'unknown', value: 'unknown' }, tenantSlug: SLUG, intent: 'food_order' })
    expect(await checkRateLimit({ plan, secret: undefined, rpc })).toEqual({ kind: 'unknown_identity' })
    expect(await checkRateLimit({ plan, secret: SECRET, rpc })).toEqual({ kind: 'unknown_identity' })
    expect(calls).toHaveLength(0)
  })

  it('identidad local SÍ se limita (desarrollo local comparte un bucket)', async () => {
    const { rpc, calls } = rpcReturning(ALLOWED)
    const plan = contactRateLimitPlan({ identity: { kind: 'local', value: 'local' } })
    expect(await checkRateLimit({ plan, secret: SECRET, rpc })).toEqual({ kind: 'allowed' })
    expect(calls).toHaveLength(1)
  })
})

describe('resolveRateLimitBuckets — lo que viaja a SQL', () => {
  it('forms: 3 buckets (IP+endpoint 10 min, IP+tenant+grupo 10 min y 24 h), todos opacos', () => {
    const r = resolveRateLimitBuckets(FORMS, SECRET)
    if (!r.ok) throw new Error(r.reason)
    expect(r.buckets.map((b) => [b.window_seconds, b.limit])).toEqual([[600, 30], [600, 10], [86_400, 40]])
    for (const b of r.buckets) expect(b.bucket_key).toMatch(RATE_LIMIT_KEY_PATTERN)
    expect(r.buckets[0]!.bucket_key.startsWith('rl1.ip_endpoint.')).toBe(true)
    expect(r.buckets[1]!.bucket_key).toBe(r.buckets[2]!.bucket_key)
  })

  it('ni la IP ni el slug ni el secreto llegan a la RPC', async () => {
    const { rpc, calls } = rpcReturning(ALLOWED)
    await checkRateLimit({ plan: FORMS, secret: SECRET, rpc })
    const enviado = JSON.stringify(calls[0]!.buckets)
    for (const sensible of [RAW_IP, SLUG, SLUG.toLowerCase(), SECRET, 'food_order', 'pedidos']) {
      expect(enviado).not.toContain(sensible)
    }
  })

  it('contact: 2 buckets de IP+endpoint (10 min y 24 h)', () => {
    const r = resolveRateLimitBuckets(contactRateLimitPlan({ identity: IP }), SECRET)
    if (!r.ok) throw new Error(r.reason)
    expect(r.buckets.map((b) => [b.window_seconds, b.limit])).toEqual([[600, 3], [86_400, 10]])
  })

  it('el slug se normaliza: mayúsculas y espacios no abren buckets nuevos', () => {
    const a = resolveRateLimitBuckets(formsRateLimitPlan({ identity: IP, tenantSlug: 'Pizzeria-Demo', intent: 'food_order' }), SECRET)
    const b = resolveRateLimitBuckets(formsRateLimitPlan({ identity: IP, tenantSlug: '  pizzeria-demo ', intent: 'food_order' }), SECRET)
    expect(a).toEqual(b)
  })

  it('el bucket IP+endpoint es el mismo para cualquier slug (no se evade variando el slug)', () => {
    const a = resolveRateLimitBuckets(formsRateLimitPlan({ identity: IP, tenantSlug: 'uno', intent: 'general_inquiry' }), SECRET)
    const b = resolveRateLimitBuckets(formsRateLimitPlan({ identity: IP, tenantSlug: 'otro', intent: 'general_inquiry' }), SECRET)
    if (!a.ok || !b.ok) throw new Error('plan inválido')
    expect(a.buckets[0]!.bucket_key).toBe(b.buckets[0]!.bucket_key)
    expect(a.buckets[1]!.bucket_key).not.toBe(b.buckets[1]!.bucket_key)
  })

  const IP_ENTRY = FORMS[0]!.spec
  it.each<[string, RateLimitPlanEntry[]]>([
    ['plan vacío', []],
    ['entrada sin límites', [{ spec: IP_ENTRY, limits: [] }]],
    ['ventana 0', [{ spec: IP_ENTRY, limits: [{ windowSeconds: 0, max: 1 }] }]],
    ['ventana de más de 24 h', [{ spec: IP_ENTRY, limits: [{ windowSeconds: 86_401, max: 1 }] }]],
    ['ventana fraccional', [{ spec: IP_ENTRY, limits: [{ windowSeconds: 1.5, max: 1 }] }]],
    ['límite 0', [{ spec: IP_ENTRY, limits: [{ windowSeconds: 600, max: 0 }] }]],
    ['límite de más de 10 000', [{ spec: IP_ENTRY, limits: [{ windowSeconds: 600, max: 10_001 }] }]],
    ['bucket repetido', [{ spec: IP_ENTRY, limits: [{ windowSeconds: 600, max: 1 }, { windowSeconds: 600, max: 2 }] }]],
    ['más buckets de los que acepta la RPC', [{
      spec:   IP_ENTRY,
      limits: Array.from({ length: RATE_LIMIT_MAX_BUCKETS_PER_CALL + 1 }, (_, i) => ({ windowSeconds: 60 + i, max: 1 })),
    }]],
  ])('%s → invalid_plan, sin llamar a la base', async (_label, plan) => {
    const { rpc, calls } = rpcReturning(ALLOWED)
    expect(await checkRateLimit({ plan, secret: SECRET, rpc })).toEqual({ kind: 'config_error', reason: 'invalid_plan' })
    expect(calls).toHaveLength(0)
  })
})

describe('logs', () => {
  const OUTCOMES: RateLimitOutcome[] = [
    { kind: 'allowed' },
    { kind: 'blocked', retryAfterSeconds: 120 },
    { kind: 'backend_error', reason: 'timeout' },
    { kind: 'backend_error', reason: 'rpc_error', errorCode: '42501' },
    { kind: 'config_error', reason: 'missing_secret' },
    { kind: 'unknown_identity' },
  ]

  it.each(OUTCOMES)('rateLimitLogFields(%j) no lleva nada sensible', (outcome) => {
    const fields = JSON.stringify(rateLimitLogFields(outcome))
    for (const sensible of [RAW_IP, SLUG, SECRET, 'rl1.']) expect(fields).not.toContain(sensible)
    expect(rateLimitLogFields(outcome).outcome).toBe(outcome.kind)
  })

  it('keyLogTag deja scope + 6 caracteres del HMAC, nunca la clave entera', () => {
    const r = resolveRateLimitBuckets(FORMS, SECRET)
    if (!r.ok) throw new Error(r.reason)
    const key = r.buckets[1]!.bucket_key
    const tag = keyLogTag(key)
    expect(tag).toMatch(/^rl1\.ip_tenant_group\.[A-Za-z0-9_-]{6}$/)
    expect(key.startsWith(tag)).toBe(true)
    expect(tag.length).toBeLessThan(key.length)
  })
})

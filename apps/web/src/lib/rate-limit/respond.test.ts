import { describe, expect, it } from 'vitest'
import { MAX_RETRY_AFTER_SECONDS, normalizeRetryAfterSeconds, rateLimitedResponse } from './respond'

describe('rateLimitedResponse', () => {
  it('429 con Retry-After, no-store y exactamente tres campos', async () => {
    const res = rateLimitedResponse(120)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('120')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: false, reason: 'rate_limited', retry_after_seconds: 120 })
  })

  it('el header y el cuerpo dicen lo mismo', async () => {
    const res = rateLimitedResponse(59.2)
    const body = (await res.json()) as { retry_after_seconds: number }
    expect(res.headers.get('retry-after')).toBe(String(body.retry_after_seconds))
    expect(body.retry_after_seconds).toBe(60)
  })

  it('no filtra nada interno: ni IP, ni hash, ni bucket, ni tenant, ni code', async () => {
    const body = (await rateLimitedResponse(30).json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['ok', 'reason', 'retry_after_seconds'])
  })
})

describe('normalizeRetryAfterSeconds', () => {
  it.each([
    [120, 120],
    [0.2, 1],
    [59.1, 60],
    [0, 1],
    [-5, 1],
    [NaN, 1],
    [-Infinity, 1],
    [Infinity, MAX_RETRY_AFTER_SECONDS],
    [10 * MAX_RETRY_AFTER_SECONDS, MAX_RETRY_AFTER_SECONDS],
  ])('%s → %s (entero ≥ 1)', (input, expected) => {
    expect(normalizeRetryAfterSeconds(input)).toBe(expected)
  })
})

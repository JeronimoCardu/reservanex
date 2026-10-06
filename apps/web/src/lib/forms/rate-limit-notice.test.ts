import { describe, expect, it } from 'vitest'
import { parseRetryAfter, rateLimitMessage, rateLimitNoticeFor } from './rate-limit-notice'

const NOW = Date.parse('2026-10-06T12:00:00.000Z')
const GENERICO =
  'Recibimos varios envíos seguidos desde tu conexión. Esperá unos minutos y volvé a intentar; tus datos siguen cargados.'

describe('rateLimitNoticeFor', () => {
  it('sólo reacciona a 429', () => {
    for (const status of [200, 201, 400, 409, 413, 415, 422, 500, 503]) {
      expect(rateLimitNoticeFor(status, '60', { ok: false, reason: 'rate_limited' }, NOW), String(status)).toBeNull()
    }
  })

  it('429 con nuestro JSON y Retry-After → mensaje con el tiempo', () => {
    const msg = rateLimitNoticeFor(429, '300', { ok: false, reason: 'rate_limited', retry_after_seconds: 300 }, NOW)
    expect(msg).toContain('Esperá 5 minutos')
    expect(msg).toContain('tus datos siguen cargados')
  })

  it('429 del WAF con cuerpo no-JSON (data = null) y sin Retry-After → mensaje genérico', () => {
    expect(rateLimitNoticeFor(429, null, null, NOW)).toBe(GENERICO)
  })

  it('429 con cuerpo de texto y Retry-After → usa el header', () => {
    expect(rateLimitNoticeFor(429, '45', 'Too Many Requests', NOW)).toContain('Esperá un minuto')
  })

  it('sin header usable, cae al retry_after_seconds del cuerpo', () => {
    expect(rateLimitNoticeFor(429, 'basura', { retry_after_seconds: 600 }, NOW)).toContain('Esperá 10 minutos')
  })

  it('un 429 con `code` sigue siendo rate limit (no se confunde con un 409 del carrito)', () => {
    expect(rateLimitNoticeFor(429, null, { code: 'price_changed' }, NOW)).toBe(GENERICO)
  })

  it('valores absurdos en el cuerpo se ignoran', () => {
    for (const v of [0, -1, 1.5, 'x', 10 * 86_400]) {
      expect(rateLimitNoticeFor(429, null, { retry_after_seconds: v }, NOW), String(v)).toBe(GENERICO)
    }
  })
})

describe('parseRetryAfter', () => {
  it('segundos', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120)
    expect(parseRetryAfter(' 1 ', NOW)).toBe(1)
  })

  it('fecha HTTP en el futuro', () => {
    expect(parseRetryAfter('Tue, 06 Oct 2026 12:02:30 GMT', NOW)).toBe(150)
  })

  it.each([[null], [''], ['0'], ['-5'], ['1.5'], ['abc'], ['Tue, 06 Oct 2026 11:59:00 GMT'], ['2026-10-06T12:05:00Z'], ['86401']])(
    '%j → null',
    (header) => {
      expect(parseRetryAfter(header, NOW)).toBeNull()
    },
  )
})

describe('rateLimitMessage', () => {
  it.each([
    [null, 'unos minutos'],
    [1, 'un minuto'],
    [60, 'un minuto'],
    [61, '2 minutos'],
    [3_540, '59 minutos'],
    [3_600, 'una hora'],
    [86_400, '24 horas'],
  ])('%s s → "Esperá %s"', (seconds, frase) => {
    expect(rateLimitMessage(seconds)).toBe(
      `Recibimos varios envíos seguidos desde tu conexión. Esperá ${frase} y volvé a intentar; tus datos siguen cargados.`,
    )
  })
})

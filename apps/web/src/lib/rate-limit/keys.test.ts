import { describe, expect, it } from 'vitest'
import type { ClientIdentity } from './client-ip'
import { buildRateLimitKey, MIN_RATE_LIMIT_SECRET_LENGTH, serializeKeyMaterial, type RateLimitKeySpec } from './keys'

const SECRET       = 's'.repeat(MIN_RATE_LIMIT_SECRET_LENGTH)
const OTHER_SECRET = 't'.repeat(MIN_RATE_LIMIT_SECRET_LENGTH)

const IP_A: ClientIdentity = { kind: 'ip', value: '203.0.113.7' }
const IP_B: ClientIdentity = { kind: 'ip', value: '203.0.113.8' }

function key(spec: RateLimitKeySpec, secret: string | undefined = SECRET): string {
  const r = buildRateLimitKey(spec, secret)
  if (!r.ok) throw new Error(`se esperaba una clave, vino ${r.error}`)
  return r.key
}

describe('buildRateLimitKey — determinismo y separación', () => {
  const base: RateLimitKeySpec = { scope: 'ip_tenant_group', identity: IP_A, tenant: 'pizzeria-demo', group: 'pedidos' }

  it('es determinística', () => {
    expect(key(base)).toBe(key(base))
  })

  it('IP distinta → clave distinta', () => {
    expect(key({ ...base, identity: IP_B })).not.toBe(key(base))
  })

  it('tenant distinto → clave distinta', () => {
    expect(key({ ...base, tenant: 'otra-pizzeria' })).not.toBe(key(base))
  })

  it('grupo distinto → clave distinta', () => {
    expect(key({ ...base, group: 'consultas' })).not.toBe(key(base))
  })

  it('endpoint distinto → clave distinta', () => {
    expect(key({ scope: 'ip_endpoint', identity: IP_A, endpoint: 'public_forms' }))
      .not.toBe(key({ scope: 'ip_endpoint', identity: IP_A, endpoint: 'contact' }))
  })

  it('secreto distinto → clave distinta', () => {
    expect(key(base, OTHER_SECRET)).not.toBe(key(base))
  })

  it('los cuatro scopes con la misma IP dan cuatro claves distintas', () => {
    const keys = new Set([
      key({ scope: 'ip', identity: IP_A }),
      key({ scope: 'ip_tenant', identity: IP_A, tenant: 'pizzeria-demo' }),
      key({ scope: 'ip_endpoint', identity: IP_A, endpoint: 'public_forms' }),
      key(base),
    ])
    expect(keys.size).toBe(4)
  })

  it('el mismo texto en scopes distintos no colisiona (tenant "contact" vs endpoint "contact")', () => {
    expect(key({ scope: 'ip_tenant', identity: IP_A, tenant: 'contact' }))
      .not.toBe(key({ scope: 'ip_endpoint', identity: IP_A, endpoint: 'contact' }))
  })

  it('las identidades local y unknown no colisionan entre sí ni con una IP', () => {
    const keys = new Set([
      key({ scope: 'ip', identity: { kind: 'local', value: 'local' } }),
      key({ scope: 'ip', identity: { kind: 'unknown', value: 'unknown' } }),
      key({ scope: 'ip', identity: IP_A }),
    ])
    expect(keys.size).toBe(3)
  })
})

describe('buildRateLimitKey — opacidad', () => {
  it('la clave no contiene IP, tenant, grupo ni endpoint', () => {
    const k = key({ scope: 'ip_tenant_group', identity: IP_A, tenant: 'pizzeria-demo', group: 'pedidos' })
    for (const secreto of ['203.0.113.7', '203', 'pizzeria-demo', 'pizzeria', 'pedidos', 'public_forms']) {
      expect(k).not.toContain(secreto)
    }
  })

  it('una IPv6 /64 tampoco aparece', () => {
    const k = key({ scope: 'ip', identity: { kind: 'ip', value: '2001:db8:abcd:12::/64' } })
    expect(k).not.toContain('2001')
    expect(k).not.toContain('db8')
  })

  it('formato: rl1.<scope>.<HMAC-SHA256 en base64url>', () => {
    const k = key({ scope: 'ip_tenant', identity: IP_A, tenant: 'pizzeria-demo' })
    expect(k).toMatch(/^rl1\.ip_tenant\.[A-Za-z0-9_-]{43}$/)
  })
})

describe('buildRateLimitKey — secreto', () => {
  const spec: RateLimitKeySpec = { scope: 'ip', identity: IP_A }

  it.each([[undefined], [''], ['   ']])('sin secreto (%j) → missing_secret, sin clave', (secret) => {
    expect(buildRateLimitKey(spec, secret)).toEqual({ ok: false, error: 'missing_secret' })
  })

  it('un secreto corto → weak_secret', () => {
    expect(buildRateLimitKey(spec, 'x'.repeat(MIN_RATE_LIMIT_SECRET_LENGTH - 1)))
      .toEqual({ ok: false, error: 'weak_secret' })
  })

  it('los espacios alrededor del secreto no cambian la clave', () => {
    expect(key(spec, `  ${SECRET}\n`)).toBe(key(spec, SECRET))
  })

  it('un componente vacío → invalid_component', () => {
    expect(buildRateLimitKey({ scope: 'ip_tenant', identity: IP_A, tenant: '' }, SECRET))
      .toEqual({ ok: false, error: 'invalid_component' })
  })
})

describe('serializeKeyMaterial — canónica e inyectiva', () => {
  it('prefija cada componente con su largo en bytes UTF-8', () => {
    expect(serializeKeyMaterial(['rl1', 'ip', 'ñ'])).toBe('3:rl12:ip2:ñ')
  })

  it.each([
    [['ab', 'c'], ['a', 'bc']],
    [['a|b', 'c'], ['a', 'b|c']],
    [['1:a', 'b'], ['1', ':ab']],
    [['', 'ab'], ['ab', '']],
    [['a', 'b', 'c'], ['a', 'bc']],
  ])('%j y %j no colisionan', (left, right) => {
    expect(serializeKeyMaterial(left)).not.toBe(serializeKeyMaterial(right))
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeIpForRateLimit, resolveClientIdentity, VERCEL_CLIENT_IP_HEADER } from './client-ip'

const ON_VERCEL  = { VERCEL: '1' }
const OFF_VERCEL = {}

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('resolveClientIdentity — en Vercel', () => {
  it('IPv4 válida en x-vercel-forwarded-for', () => {
    expect(resolveClientIdentity(headers({ [VERCEL_CLIENT_IP_HEADER]: '203.0.113.7' }), ON_VERCEL))
      .toEqual({ kind: 'ip', value: '203.0.113.7' })
  })

  it('IPv6 válida → su prefijo /64', () => {
    expect(resolveClientIdentity(headers({ [VERCEL_CLIENT_IP_HEADER]: '2001:db8:abcd:12:1:2:3:4' }), ON_VERCEL))
      .toEqual({ kind: 'ip', value: '2001:db8:abcd:12::/64' })
  })

  it('sin el header → unknown', () => {
    expect(resolveClientIdentity(headers({}), ON_VERCEL)).toEqual({ kind: 'unknown', value: 'unknown' })
  })

  it('header inválido → unknown', () => {
    expect(resolveClientIdentity(headers({ [VERCEL_CLIENT_IP_HEADER]: 'not-an-ip' }), ON_VERCEL))
      .toEqual({ kind: 'unknown', value: 'unknown' })
  })

  it('una lista de IPs → unknown (no se elige ningún elemento)', () => {
    expect(resolveClientIdentity(headers({ [VERCEL_CLIENT_IP_HEADER]: '203.0.113.7, 198.51.100.1' }), ON_VERCEL))
      .toEqual({ kind: 'unknown', value: 'unknown' })
  })

  it('el header repetido (Headers lo une con coma) → unknown', () => {
    const h = new Headers()
    h.append(VERCEL_CLIENT_IP_HEADER, '203.0.113.7')
    h.append(VERCEL_CLIENT_IP_HEADER, '198.51.100.1')
    expect(resolveClientIdentity(h, ON_VERCEL)).toEqual({ kind: 'unknown', value: 'unknown' })
  })

  it('no lee x-forwarded-for ni x-real-ip: la única fuente es x-vercel-forwarded-for', () => {
    const h = headers({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.7' })
    expect(resolveClientIdentity(h, ON_VERCEL)).toEqual({ kind: 'unknown', value: 'unknown' })
  })

  it('VERCEL tiene que ser exactamente "1"', () => {
    const h = headers({ [VERCEL_CLIENT_IP_HEADER]: '203.0.113.7' })
    expect(resolveClientIdentity(h, { VERCEL: 'true' })).toEqual({ kind: 'local', value: 'local' })
    expect(resolveClientIdentity(h, { VERCEL: '0' })).toEqual({ kind: 'local', value: 'local' })
  })
})

describe('resolveClientIdentity — fuera de Vercel', () => {
  it('ignora todos los headers de IP falsificables → local', () => {
    const h = headers({
      [VERCEL_CLIENT_IP_HEADER]: '203.0.113.7',
      'x-forwarded-for':         '198.51.100.1',
      'x-real-ip':               '198.51.100.2',
      'cf-connecting-ip':        '198.51.100.3',
    })
    expect(resolveClientIdentity(h, OFF_VERCEL)).toEqual({ kind: 'local', value: 'local' })
  })
})

describe('normalizeIpForRateLimit — IPv4', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['  203.0.113.7  ', '203.0.113.7'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeIpForRateLimit(raw)).toBe(expected)
  })

  it.each(['256.1.1.1', '1.2.3', '1.2.3.4.5', '010.0.0.1', '1.2.3.4:8080', '1.2.3.-4', '1..2.3'])(
    'rechaza %j',
    (raw) => {
      expect(normalizeIpForRateLimit(raw)).toBeNull()
    },
  )
})

describe('normalizeIpForRateLimit — IPv4-mapped IPv6', () => {
  it.each(['::ffff:203.0.113.7', '::FFFF:203.0.113.7', '::ffff:cb00:7107', '0:0:0:0:0:ffff:203.0.113.7'])(
    '%j se trata como la IPv4 203.0.113.7',
    (raw) => {
      expect(normalizeIpForRateLimit(raw)).toBe('203.0.113.7')
    },
  )

  it('cae en el mismo bucket que la IPv4 directa', () => {
    expect(normalizeIpForRateLimit('::ffff:203.0.113.7')).toBe(normalizeIpForRateLimit('203.0.113.7'))
  })
})

describe('normalizeIpForRateLimit — IPv6 /64', () => {
  it('dos direcciones del mismo /64 dan el mismo valor', () => {
    expect(normalizeIpForRateLimit('2001:db8:abcd:12::1'))
      .toBe(normalizeIpForRateLimit('2001:db8:abcd:12:ffff:ffff:ffff:ffff'))
  })

  it('distintas formas de escribir el mismo /64 dan el mismo valor', () => {
    const a = normalizeIpForRateLimit('2001:0DB8:ABCD:0012:0000:0000:0000:0001')
    const b = normalizeIpForRateLimit('2001:db8:abcd:12::1')
    expect(a).toBe('2001:db8:abcd:12::/64')
    expect(a).toBe(b)
  })

  it('/64 distintos dan valores distintos', () => {
    expect(normalizeIpForRateLimit('2001:db8:abcd:12::1'))
      .not.toBe(normalizeIpForRateLimit('2001:db8:abcd:13::1'))
  })

  it.each([
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1', 'fe80:0:0:0::/64'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4::/64'],
    ['1::', '1:0:0:0::/64'],
    ['64:ff9b::203.0.113.7', '64:ff9b:0:0::/64'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeIpForRateLimit(raw)).toBe(expected)
  })

  it.each([
    '2001:db8::1::2',
    '1:2:3:4:5:6:7:8:9',
    '1::2:3:4:5:6:7:8',
    'gggg::1',
    '12345::1',
    '[2001:db8::1]',
    '[2001:db8::1]:443',
    'fe80::1%eth0',
    ':1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:',
    ':::',
    '::ffff:256.0.0.1',
    '1:2:3:4:5:6:7:1.2.3.4',
  ])('rechaza %j', (raw) => {
    expect(normalizeIpForRateLimit(raw)).toBeNull()
  })
})

describe('normalizeIpForRateLimit — entradas inválidas', () => {
  it.each(['', '   ', 'not-an-ip', 'localhost', '203.0.113.7, 198.51.100.1', '203.0.113.7 198.51.100.1', 'a'.repeat(46)])(
    'rechaza %j',
    (raw) => {
      expect(normalizeIpForRateLimit(raw)).toBeNull()
    },
  )
})

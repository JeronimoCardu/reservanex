// Rate limiting — Fase 1A: identidad de red del cliente.
//
// CONTRATO
//
//   · En Vercel (process.env.VERCEL === '1') la única fuente es
//     x-vercel-forwarded-for. Vercel lo escribe en su edge y no reenvía IPs
//     externas, así que el cliente no puede falsificarlo. Si falta o no es UNA
//     IP válida → 'unknown'.
//   · Fuera de Vercel (local, tests, cualquier otro host) los headers de IP los
//     controla quien manda el request: no se lee ninguno → 'local'.
//   · NO hay soporte de proxy de confianza (Cloudflare u otro CDN delante de
//     Vercel). Si algún día se agrega, va acá y con su propio contrato.
//
// NORMALIZACIÓN
//
//   · IPv4: la dirección completa, en forma canónica.
//   · IPv4-mapped IPv6 (::ffff:a.b.c.d): se trata como la IPv4 que es. Si no,
//     la misma persona caería en dos buckets según cómo llegó.
//   · IPv6: el prefijo /64. Una conexión hogareña o móvil suele controlar un
//     /64 entero, así que limitar por dirección exacta se evade rotando.
//
// `value` de kind 'ip' es dato personal: se usa para derivar claves con HMAC
// (keys.ts) y NUNCA se loguea ni se persiste tal cual.

export type ClientIdentity =
  | { kind: 'ip';      value: string }
  | { kind: 'unknown'; value: 'unknown' }
  | { kind: 'local';   value: 'local' }

export const VERCEL_CLIENT_IP_HEADER = 'x-vercel-forwarded-for'

const UNKNOWN: ClientIdentity = { kind: 'unknown', value: 'unknown' }
const LOCAL:   ClientIdentity = { kind: 'local',   value: 'local' }

// La forma textual más larga de una IPv6 válida
// (ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255) tiene 45 caracteres.
const MAX_IP_TEXT_LENGTH = 45

export function resolveClientIdentity(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClientIdentity {
  if (env.VERCEL !== '1') return LOCAL

  const raw = headers.get(VERCEL_CLIENT_IP_HEADER)
  if (raw === null) return UNKNOWN

  const normalized = normalizeIpForRateLimit(raw)
  return normalized === null ? UNKNOWN : { kind: 'ip', value: normalized }
}

/**
 * La forma canónica de UNA IP para limitar, o null si el texto no es
 * exactamente una IPv4 o IPv6 válida. Conservador a propósito: una lista
 * ("a, b"), un puerto, corchetes o una zona (%eth0) devuelven null — nunca se
 * elige un elemento de una lista que podría controlar el cliente.
 */
export function normalizeIpForRateLimit(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || text.length > MAX_IP_TEXT_LENGTH) return null

  const v4 = parseIPv4(text)
  if (v4) return v4.join('.')

  const v6 = parseIPv6(text)
  if (!v6) return null

  if (isIPv4Mapped(v6)) {
    const [hi = 0, lo = 0] = v6.slice(6)
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
  }

  return `${v6.slice(0, 4).map((h) => h.toString(16)).join(':')}::/64`
}

// Cuatro octetos decimales 0..255. Sin ceros a la izquierda: '010' es octal
// para algunos parsers y decimal para otros, y esa ambigüedad no se acepta.
function parseIPv4(text: string): number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null

  const out: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

// Ocho grupos de 16 bits. Acepta '::' (una sola vez) y una IPv4 embebida al
// final. Rechaza todo lo demás.
function parseIPv6(text: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text) || !text.includes(':')) return null

  let head = text
  let tail: number[] = []

  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':')
    const v4 = parseIPv4(text.slice(lastColon + 1))
    if (!v4) return null
    const [a = 0, b = 0, c = 0, d = 0] = v4
    tail = [(a << 8) | b, (c << 8) | d]
    head = text.slice(0, lastColon + 1)
    // '1:2:3:4:5:6:' → '1:2:3:4:5:6', pero '::' queda como está.
    if (!head.endsWith('::')) head = head.slice(0, -1)
  }

  const needed = 8 - tail.length
  const halves = head.split('::')
  if (halves.length > 2) return null

  const [left = '', right] = halves
  const leftGroups = parseHextets(left)
  if (!leftGroups) return null

  if (right === undefined) {
    return leftGroups.length === needed ? [...leftGroups, ...tail] : null
  }

  const rightGroups = parseHextets(right)
  if (!rightGroups) return null

  const zeros = needed - leftGroups.length - rightGroups.length
  if (zeros < 1) return null

  return [...leftGroups, ...new Array<number>(zeros).fill(0), ...rightGroups, ...tail]
}

function parseHextets(text: string): number[] | null {
  if (text === '') return []
  const out: number[] = []
  for (const group of text.split(':')) {
    if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return null
    out.push(parseInt(group, 16))
  }
  return out
}

function isIPv4Mapped(groups: number[]): boolean {
  return groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
}

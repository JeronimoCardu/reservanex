// ════════════════════════════════════════════════════════════════════════════
// La base de los links que se le MANDAN A UN CLIENTE por WhatsApp.
//
// Hasta acá tres lugares del worker (el responder y los dos tools de links)
// armaban URLs con SITE_URL ?? NEXT_PUBLIC_SITE_URL ?? 'https://reservanex.com'.
// En desarrollo NEXT_PUBLIC_SITE_URL es http://localhost:3001 —el origen del
// NAVEGADOR de quien desarrolla—, así que un cliente real recibió por
// WhatsApp un link a localhost. Un teléfono en la calle no puede abrirlo.
//
// Son tres orígenes distintos y no hay que mezclarlos:
//
//   NEXT_PUBLIC_SITE_URL          el navegador del desarrollador / redirects
//                                 de auth (web). NUNCA sale por WhatsApp.
//   AUTORESPONDER_PUBLIC_BASE_URL a dónde el ANDROID postea los webhooks
//                                 (ingreso). Es infraestructura, no producto.
//   CUSTOMER_SITE_BASE_URL        a dónde un CLIENTE abre el sitio público
//                                 desde su propio teléfono (egreso). Esta.
//
// Que en desarrollo físico las dos últimas apunten al mismo túnel es una
// coincidencia de topología, no una identidad semántica: por eso no se
// reutiliza la del webhook automáticamente. Se configura explícita.
//
// Precedencia: CUSTOMER_SITE_BASE_URL → SITE_URL → NEXT_PUBLIC_SITE_URL →
// https://reservanex.com. Y después de resolver, la regla que no se negocia:
// si el resultado es localhost, NO HAY LINK. Se devuelve null y quien lo
// pide tiene que degradar con gracia (derivar a una persona), nunca mandar
// una URL que el cliente no puede abrir.
// ════════════════════════════════════════════════════════════════════════════

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export function isCustomerReachable(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (LOOPBACK.has(host)) return false
  if (host.endsWith('.local') || host.endsWith('.localhost')) return false
  return true
}

/** La base canónica, o null si lo configurado no es alcanzable por un cliente. */
export function getCustomerSiteBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidato =
    env.CUSTOMER_SITE_BASE_URL ??
    env.SITE_URL ??
    env.NEXT_PUBLIC_SITE_URL ??
    'https://reservanex.com'

  const limpio = candidato.trim().replace(/\/+$/, '')
  return isCustomerReachable(limpio) ? limpio : null
}

/** `${base}${path}`, o null si no hay base alcanzable. path empieza con "/". */
export function customerSiteUrl(path: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = getCustomerSiteBaseUrl(env)
  if (!base) return null
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/** Las rutas públicas que el worker manda, en un solo lugar. */
export const PUBLIC_PATHS = {
  site:             (slug: string) => `/site/${slug}`,
  property:         (slug: string, propertySlug: string) => `/site/${slug}/properties/${propertySlug}`,
  tableReservation: (slug: string) => `/site/${slug}/formulario/table_reservation`,
} as const

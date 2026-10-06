// Rate limiting — Fase 1A: endurecimiento de los POST públicos y anónimos que
// reciben JSON (/api/public/forms y /api/contact).
//
// COPIA IDÉNTICA en apps/marketing/src/lib/public-post-guard.ts: esa app es
// independiente a propósito (no importa nada de apps/web ni de los paquetes
// del monorepo), así que no puede compartir este módulo por import. Un test de
// apps/web (public-post-guard-parity.test.ts) compara los dos archivos byte a
// byte y falla si divergen. Cualquier cambio se hace en los dos.
//
// Todo lo de acá ocurre ANTES de parsear el JSON y antes de cualquier acceso a
// la base o a un servicio externo. El orden es deliberado y está fijado por
// tests:
//
//   1. Content-Type   → 415  (sin leer el body)
//   2. Sec-Fetch-Site → 403  (sin leer el body)
//   3. Content-Length → 413  (sin leer el body)
//   4. lectura        → 400  si el body no se puede leer
//   5. bytes reales   → 413
//
// Por qué Content-Type: un POST "simple" (text/plain, form-urlencoded) no
// dispara preflight de CORS, así que cualquier página de terceros podía hacer
// que los navegadores de SUS visitantes mandaran formularios acá, cada uno con
// una IP distinta — exactamente lo que un límite por IP no puede frenar.
// Exigir application/json fuerza el preflight, que el navegador no pasa porque
// estas rutas no responden CORS.
//
// Por qué Sec-Fetch-Site sólo como refuerzo: lo mandan los navegadores
// modernos y un script no. Se rechaza únicamente 'cross-site'; su ausencia NO
// es motivo de rechazo (curl, navegadores viejos, llamadas server-to-server).

export type PublicPostRejection =
  | { ok: false; status: 415; reason: 'unsupported_media_type' }
  | { ok: false; status: 403; reason: 'cross_site_request' }
  | { ok: false; status: 413; reason: 'payload_too_large' }
  | { ok: false; status: 400; reason: 'invalid_body' }

export type PublicPostBody = { ok: true; raw: string } | PublicPostRejection

// token de RFC 9110 §5.6.2.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// quoted-string simplificado: sin comillas ni barras sueltas adentro.
const QUOTED = /^"[^"\\]*"$/
// Etiquetas que la WHATWG Encoding Standard resuelve a UTF-8 y que un cliente
// real manda. JSON es UTF-8 por definición (RFC 8259 §8.1): otro charset se
// decodificaría mal, así que se rechaza en vez de adivinar.
const UTF8_LABELS = new Set(['utf-8', 'utf8'])

/**
 * true sólo para `application/json`, con parámetros opcionales bien formados.
 *
 * Acepta mayúsculas en type/subtype, espacios opcionales alrededor de `;` y
 * parámetros vacíos (RFC 9110 §8.3.1 los permite). Si viene `charset`, tiene
 * que ser UTF-8. NO acepta sufijos (`application/vnd.api+json`), ni
 * `application/jsonp`, ni dos media types unidos por coma.
 */
export function isJsonContentType(header: string | null): boolean {
  if (header === null) return false

  const [mediaType = '', ...params] = header.split(';')
  if (mediaType.trim().toLowerCase() !== 'application/json') return false

  for (const segment of params) {
    const param = segment.trim()
    if (param === '') continue

    const eq = param.indexOf('=')
    if (eq <= 0) return false

    const name  = param.slice(0, eq)
    const value = param.slice(eq + 1)
    if (!TOKEN.test(name)) return false
    if (!TOKEN.test(value) && !QUOTED.test(value)) return false

    if (name.toLowerCase() === 'charset') {
      const charset = (QUOTED.test(value) ? value.slice(1, -1) : value).toLowerCase()
      if (!UTF8_LABELS.has(charset)) return false
    }
  }

  return true
}

/** true sólo si el navegador declaró que el request es cross-site. */
export function isCrossSiteRequest(header: string | null): boolean {
  return header !== null && header.trim().toLowerCase() === 'cross-site'
}

/**
 * El Content-Length declarado, o null si no vino o no es un entero decimal
 * válido. Un valor inválido NO es motivo de rechazo: se ignora y manda la
 * medición real del body.
 */
export function declaredContentLength(header: string | null): number | null {
  if (header === null) return null
  const value = header.trim()
  if (!/^\d+$/.test(value)) return null
  return Number(value)
}

/**
 * Valida el request y devuelve el body como texto UTF-8, o el rechazo que
 * corresponde. Nunca lee el body si ya puede rechazar por headers.
 *
 * `maxBytes` se compara contra BYTES UTF-8 reales, no contra `string.length`
 * (que cuenta unidades UTF-16: una ñ es 1 unidad y 2 bytes).
 */
export async function readPublicJsonBody(request: Request, maxBytes: number): Promise<PublicPostBody> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return { ok: false, status: 415, reason: 'unsupported_media_type' }
  }

  if (isCrossSiteRequest(request.headers.get('sec-fetch-site'))) {
    return { ok: false, status: 403, reason: 'cross_site_request' }
  }

  const declared = declaredContentLength(request.headers.get('content-length'))
  if (declared !== null && declared > maxBytes) {
    return { ok: false, status: 413, reason: 'payload_too_large' }
  }

  let bytes: ArrayBuffer
  try {
    bytes = await request.arrayBuffer()
  } catch {
    return { ok: false, status: 400, reason: 'invalid_body' }
  }

  if (bytes.byteLength > maxBytes) {
    return { ok: false, status: 413, reason: 'payload_too_large' }
  }

  // Misma decodificación que request.text(): UTF-8, BOM descartado, secuencias
  // inválidas reemplazadas por U+FFFD en vez de tirar.
  return { ok: true, raw: new TextDecoder('utf-8').decode(bytes) }
}

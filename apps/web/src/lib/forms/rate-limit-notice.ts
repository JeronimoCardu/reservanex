// Rate limiting — Fase 1A: cómo lee el formulario público un 429.
//
// El 429 puede venir de dos lados: de nuestra ruta (JSON con
// retry_after_seconds) o del WAF de la plataforma, que responde con lo que
// quiera — HTML, texto o nada. Por eso se decide por el STATUS y el cuerpo es
// sólo una fuente más para el tiempo de espera, nunca la condición.
//
// Esto no toca estado: quien lo llama (DynamicForm) sólo muestra el mensaje.
// Valores, carrito y clave de idempotencia quedan como estaban, así que el
// reintento no pierde lo escrito ni duplica la submission.

export const RATE_LIMITED_STATUS = 429

// Más allá de un día, el número no ayuda a nadie a decidir cuándo volver.
const MAX_SECONDS = 86_400

// IMF-fixdate (RFC 9110 §5.6.7): "Sun, 06 Nov 1994 08:49:37 GMT". Date.parse
// solo es demasiado permisivo para un header que puede venir de cualquier lado.
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/

function inRange(seconds: number): number | null {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_SECONDS ? seconds : null
}

/** Segundos de espera según el header Retry-After (segundos o fecha), o null. */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | null {
  if (header === null) return null
  const value = header.trim()

  if (/^\d+$/.test(value)) return inRange(Number(value))

  if (IMF_FIXDATE.test(value)) {
    const at = Date.parse(value)
    if (Number.isNaN(at)) return null
    return inRange(Math.ceil((at - nowMs) / 1000))
  }

  return null
}

function retryAfterFromBody(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const seconds = (body as { retry_after_seconds?: unknown }).retry_after_seconds
  return typeof seconds === 'number' ? inRange(seconds) : null
}

function waitPhrase(seconds: number | null): string {
  if (seconds === null) return 'unos minutos'
  if (seconds <= 60) return 'un minuto'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} minutos`
  const hours = Math.ceil(minutes / 60)
  return hours === 1 ? 'una hora' : `${hours} horas`
}

export function rateLimitMessage(retryAfterSeconds: number | null): string {
  return (
    'Recibimos varios envíos seguidos desde tu conexión. ' +
    `Esperá ${waitPhrase(retryAfterSeconds)} y volvé a intentar; tus datos siguen cargados.`
  )
}

/**
 * El mensaje para el visitante si la respuesta fue un 429; null si no lo fue.
 *
 * El tiempo sale del header Retry-After y, si falta o no sirve, de
 * `retry_after_seconds` en el cuerpo. Sin ninguno de los dos, "unos minutos".
 */
export function rateLimitNoticeFor(
  status: number,
  retryAfterHeader: string | null,
  body: unknown,
  nowMs: number = Date.now(),
): string | null {
  if (status !== RATE_LIMITED_STATUS) return null
  const seconds = parseRetryAfter(retryAfterHeader, nowMs) ?? retryAfterFromBody(body)
  return rateLimitMessage(seconds)
}

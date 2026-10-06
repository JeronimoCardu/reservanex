// Rate limiting — Fase 1A: la respuesta 429. Todavía NO la usa ninguna ruta;
// la integra el adapter de la Fase 1B.
//
// El cuerpo tiene exactamente tres campos. No lleva IP, hash, bucket, tenant
// ni clave interna: la firma sólo recibe un número, así que no hay forma de
// colarlos. Tampoco lleva `code`: en /api/public/forms ese campo es de los 409
// estructurados que maneja el carrito, y un 429 no es uno de ellos.

import { NextResponse } from 'next/server'

/** La ventana más larga de la política propuesta: 24 h. */
export const MAX_RETRY_AFTER_SECONDS = 86_400

export interface RateLimitedBody {
  ok:                  false
  reason:              'rate_limited'
  retry_after_seconds: number
}

/**
 * Segundos enteros en [1, MAX_RETRY_AFTER_SECONDS]. Redondea hacia arriba: si
 * faltan 0,2 s, decir 0 invita a reintentar antes de tiempo.
 */
export function normalizeRetryAfterSeconds(seconds: number): number {
  if (Number.isNaN(seconds)) return 1
  if (seconds === Infinity) return MAX_RETRY_AFTER_SECONDS
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)))
}

export function rateLimitedResponse(retryAfterSeconds: number): NextResponse<RateLimitedBody> {
  const seconds = normalizeRetryAfterSeconds(retryAfterSeconds)
  return NextResponse.json(
    { ok: false, reason: 'rate_limited', retry_after_seconds: seconds },
    {
      status:  429,
      headers: {
        'Retry-After':   String(seconds),
        'Cache-Control': 'no-store',
      },
    },
  )
}

/**
 * Rate limiting Fase 1B — a qué base puede apuntar validate-rate-limit.ts.
 *
 * Ese validator escribe buckets, crea roles si faltan y crea/borra un schema
 * de prueba: SOLO puede correr contra un Postgres LOCAL. Este guard es la
 * única puerta, y es deliberadamente estrecho:
 *
 *   · protocolo postgres:// o postgresql://
 *   · host loopback: 127.0.0.1, localhost o ::1
 *   · ningún parámetro de query salvo sslmode — libpq acepta `host=` y
 *     `hostaddr=` en la query y REEMPLAZAN al host de la URL, así que una URL
 *     "local" con ?host=db.xxx.supabase.co terminaría en el remoto
 *   · nada que mencione supabase.co / supabase.com
 *
 * No hay override. Para validar contra el remoto no se usa este script.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const ALLOWED_QUERY_PARAMS = new Set(['sslmode'])

export type LocalTargetResult =
  | { ok: true; label: string }
  | { ok: false; reason: string }

/** Valida la URL. `label` es host:puerto/base, sin usuario ni contraseña. */
export function checkLocalDatabaseUrl(raw: string | undefined): LocalTargetResult {
  const value = raw?.trim() ?? ''
  if (value === '') {
    return { ok: false, reason: 'falta RATE_LIMIT_VALIDATE_DB_URL (ej.: postgresql://postgres:postgres@127.0.0.1:54322/postgres)' }
  }

  if (/supabase\.(co|com)/i.test(value)) {
    return { ok: false, reason: 'la URL apunta a Supabase: este validator sólo corre contra una base local' }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'la URL no se puede parsear' }
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return { ok: false, reason: `protocolo no soportado: ${url.protocol}` }
  }

  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: `host no local: ${url.hostname}` }
  }

  for (const param of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMS.has(param.toLowerCase())) {
      return { ok: false, reason: `parámetro de conexión no permitido: ${param}` }
    }
  }

  const port = url.port || '5432'
  const db   = url.pathname.replace(/^\//, '') || 'postgres'
  return { ok: true, label: `${url.hostname}:${port}/${db}` }
}

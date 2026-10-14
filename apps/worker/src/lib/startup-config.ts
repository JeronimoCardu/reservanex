// MVP PROD-A1 — fail-fast de configuración.
//
// Sin esto el worker "arrancaba bien" aunque le faltara lo que lo hace útil:
// sin DEEPSEEK_* cada mensaje fallaba recién al llamar al LLM, y sin
// WORKER_INTERNAL_SECRET el endpoint síncrono rechazaba TODO con un 500
// mientras el health daba verde. En producción eso es peor que no arrancar:
// la plataforma ve un proceso sano y nadie se entera.
//
// Pura (recibe el env, no lo lee) y sin valores en los mensajes: sólo
// nombres de variables y qué se espera de ellas. Nunca un secreto ni una URL.
//
// Exige únicamente lo que el MVP usa. GROQ_API_KEY (transcripción de audio de
// Meta), CUSTOMER_SITE_BASE_URL y HUMAN_HANDOFF_TIMEOUT_MS tienen default o
// degradan solos.

export interface StartupConfigCheck {
  ok:       boolean
  problems: string[]
  warnings: string[]
}

/** En producción el endpoint interno es público por HTTPS: el secret tiene que ser largo. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32

function present(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function isHttpUrl(value: string, requireHttps: boolean): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (requireHttps) return url.protocol === 'https:'
  return url.protocol === 'https:' || url.protocol === 'http:'
}

function isIntegerInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) return false
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= min && n <= max
}

export function validateWorkerConfig(env: NodeJS.ProcessEnv): StartupConfigCheck {
  const production = env.NODE_ENV === 'production'
  const problems: string[] = []
  const warnings: string[] = []

  // ── Supabase ──────────────────────────────────────────────────────────────
  // Mismo orden de precedencia que lib/supabase.ts.
  const supabaseUrlName = present(env, 'SUPABASE_URL') ? 'SUPABASE_URL' : 'NEXT_PUBLIC_SUPABASE_URL'
  const supabaseUrl = present(env, supabaseUrlName)
  if (!supabaseUrl) {
    problems.push('falta SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL)')
  } else if (!isHttpUrl(supabaseUrl, production)) {
    problems.push(`${supabaseUrlName} no es una URL ${production ? 'https' : 'http(s)'} válida`)
  }
  if (!present(env, 'SUPABASE_SERVICE_ROLE_KEY')) problems.push('falta SUPABASE_SERVICE_ROLE_KEY')

  // ── LLM ───────────────────────────────────────────────────────────────────
  if (!present(env, 'DEEPSEEK_API_KEY')) problems.push('falta DEEPSEEK_API_KEY')
  if (!present(env, 'DEEPSEEK_MODEL'))   problems.push('falta DEEPSEEK_MODEL')
  const deepseekBase = present(env, 'DEEPSEEK_BASE_URL')
  if (deepseekBase && !isHttpUrl(deepseekBase, production)) {
    problems.push(`DEEPSEEK_BASE_URL no es una URL ${production ? 'https' : 'http(s)'} válida`)
  }

  // ── Endpoint interno (lo llama apps/web) ──────────────────────────────────
  const secret = present(env, 'WORKER_INTERNAL_SECRET')
  if (!secret) {
    problems.push('falta WORKER_INTERNAL_SECRET (el mismo valor que en apps/web)')
  } else if (production && secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    problems.push(`WORKER_INTERNAL_SECRET es demasiado corto para producción (mínimo ${MIN_PRODUCTION_SECRET_LENGTH} caracteres)`)
  }

  const port = present(env, 'WORKER_INTERNAL_PORT')
  if (port && !isIntegerInRange(port, 1, 65_535)) {
    problems.push('WORKER_INTERNAL_PORT tiene que ser un entero entre 1 y 65535')
  }

  // NaN acá hacía que cada request "venciera" al instante.
  const syncTimeout = present(env, 'AUTORESPONDER_SYNC_TIMEOUT_MS')
  if (syncTimeout && !isIntegerInRange(syncTimeout, 1_000, 60_000)) {
    problems.push('AUTORESPONDER_SYNC_TIMEOUT_MS tiene que ser un entero entre 1000 y 60000 (ms)')
  }

  // ── Opcionales: sólo avisos ───────────────────────────────────────────────
  // Misma precedencia que lib/customer-site-url.ts.
  if (production && !['CUSTOMER_SITE_BASE_URL', 'SITE_URL', 'NEXT_PUBLIC_SITE_URL'].some((n) => present(env, n))) {
    warnings.push('CUSTOMER_SITE_BASE_URL no está definida: los links a clientes usan el default del código')
  }

  return { ok: problems.length === 0, problems, warnings }
}

/**
 * Property Videos 2B1 — guard anti-producción para todo lo que toca la base
 * del proyecto de LABORATORIO (reservanex-lab).
 *
 * Es la única puerta: los scripts de scripts/lab/ y los validadores
 * validate-property-video-uploads.ts / validate-property-video-storage.ts lo
 * llaman ANTES de abrir cualquier conexión, y si falla no conectan. La parte
 * HTTP (resolveLabHttpTarget / assertLabRequest) está más abajo.
 * Deliberadamente estrecho, sin override:
 *
 *   · RESERVANEX_ALLOW_LAB_DB tiene que ser exactamente "1";
 *   · RESERVANEX_LAB_PROJECT_REF: 20 letras minúsculas y distinto del ref
 *     productivo;
 *   · RESERVANEX_LAB_DATABASE_URL: postgres:// o postgresql://, base
 *     "postgres", puerto 5432 y con contraseña;
 *   · el host demuestra que es el lab: directo db.<ref-lab>.supabase.co, o
 *     Session pooler <region>.pooler.supabase.com con usuario <rol>.<ref-lab>
 *     (en el pooler el ref NO está en el host: está en el usuario);
 *   · ningún parámetro de query salvo sslmode (libpq y pg-connection-string
 *     aceptan host= en la query, que reemplaza al host de la URL);
 *   · el ref productivo no aparece en NINGUNA parte de la URL.
 *
 * Los motivos de rechazo nunca incluyen valores (URL, usuario, contraseña,
 * ref): se pueden imprimir tal cual.
 */

import fs from 'node:fs'

export const PRODUCTION_PROJECT_REF = 'tjqfysbcmpqlwmzdvynr'

export interface LabEnv {
  RESERVANEX_LAB_DATABASE_URL?: string
  RESERVANEX_LAB_PROJECT_REF?: string
  RESERVANEX_ALLOW_LAB_DB?: string
  RESERVANEX_LAB_SUPABASE_URL?: string
  RESERVANEX_LAB_SECRET_KEY?: string
}

export type LabTarget =
  | {
      ok: true
      databaseUrl: string
      /** Para redactar salidas de herramientas: URL, contraseña, usuario, host y ref. */
      secrets: string[]
      hostKind: 'pooler' | 'directo'
    }
  | { ok: false; reason: string }

const PROJECT_REF = /^[a-z]{20}$/

export function resolveLabDatabaseTarget(env: LabEnv): LabTarget {
  const fail = (reason: string): LabTarget => ({ ok: false, reason })
  const rawUrl = env.RESERVANEX_LAB_DATABASE_URL?.trim() ?? ''
  const labRef = env.RESERVANEX_LAB_PROJECT_REF?.trim() ?? ''

  if (env.RESERVANEX_ALLOW_LAB_DB !== '1') return fail('RESERVANEX_ALLOW_LAB_DB tiene que ser exactamente 1')
  if (!PROJECT_REF.test(labRef)) return fail('RESERVANEX_LAB_PROJECT_REF no tiene formato de ref de Supabase')
  if (labRef === PRODUCTION_PROJECT_REF) return fail('el ref del lab es el ref PRODUCTIVO')
  if (rawUrl === '') return fail('falta RESERVANEX_LAB_DATABASE_URL')
  if (rawUrl.includes(PRODUCTION_PROJECT_REF)) return fail('la URL de la base menciona el ref PRODUCTIVO')

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return fail('RESERVANEX_LAB_DATABASE_URL no se puede parsear')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return fail('la URL no es postgres:// ni postgresql://')
  if (url.pathname !== '/postgres') return fail('la base tiene que ser "postgres"')
  if (url.port !== '5432') return fail('el puerto tiene que ser 5432 (Session pooler o conexión directa)')
  if (!url.password) return fail('la URL no trae contraseña')
  for (const key of url.searchParams.keys()) {
    if (key !== 'sslmode') return fail(`parámetro de query no permitido: ${key}`)
  }

  const host = url.hostname.toLowerCase()
  let user: string
  try {
    user = decodeURIComponent(url.username)
  } catch {
    return fail('el usuario de la URL no se puede decodificar')
  }

  let hostKind: 'pooler' | 'directo'
  if (host === `db.${labRef}.supabase.co`) {
    hostKind = 'directo'
  } else if (/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) {
    const match = /^[a-z_]+\.([a-z]{20})$/.exec(user)
    if (!match || match[1] !== labRef) return fail('en el pooler, el usuario tiene que ser <rol>.<ref del lab>')
    hostKind = 'pooler'
  } else {
    return fail('el host no es ni db.<ref del lab>.supabase.co ni un Session pooler de Supabase')
  }

  const secrets = [rawUrl, url.password, decodeURIComponent(url.password), user, url.username, host, labRef]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)
  return { ok: true, databaseUrl: rawUrl, secrets, hostKind }
}

// ── HTTP (Storage / PostgREST) ───────────────────────────────────────────────
//
// Property Videos 2B1.1 — mismo criterio para las llamadas HTTP al lab con la
// Secret key (server-side, nunca al browser):
//
//   · RESERVANEX_LAB_SUPABASE_URL es EXACTAMENTE https://<ref del lab>.supabase.co
//     (se tolera sólo la barra final): sin puerto, userinfo, query, hash ni path;
//   · RESERVANEX_LAB_SECRET_KEY existe, sin espacios, y no es una publishable
//     key. Si es una key JWT legacy, su payload tiene que decir role
//     service_role y —si trae ref— el ref del lab;
//   · assertLabRequest corre en CADA request: mismo origin que el lab, y el ref
//     productivo en ninguna parte de la URL.

export type LabHttpTarget =
  | {
      ok: true
      origin: string
      secretKey: string
      keyKind: 'secret' | 'service_role_jwt'
      /** URL, key, host y ref, para redactar salidas. */
      secrets: string[]
    }
  | { ok: false; reason: string }

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const payload: unknown = JSON.parse(json)
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function resolveLabHttpTarget(env: LabEnv): LabHttpTarget {
  const fail = (reason: string): LabHttpTarget => ({ ok: false, reason })
  const labRef = env.RESERVANEX_LAB_PROJECT_REF?.trim() ?? ''
  const rawUrl = env.RESERVANEX_LAB_SUPABASE_URL?.trim() ?? ''
  const key = env.RESERVANEX_LAB_SECRET_KEY?.trim() ?? ''

  if (env.RESERVANEX_ALLOW_LAB_DB !== '1') return fail('RESERVANEX_ALLOW_LAB_DB tiene que ser exactamente 1')
  if (!PROJECT_REF.test(labRef)) return fail('RESERVANEX_LAB_PROJECT_REF no tiene formato de ref de Supabase')
  if (labRef === PRODUCTION_PROJECT_REF) return fail('el ref del lab es el ref PRODUCTIVO')
  if (rawUrl === '') return fail('falta RESERVANEX_LAB_SUPABASE_URL')
  if (rawUrl.includes(PRODUCTION_PROJECT_REF)) return fail('la URL HTTP menciona el ref PRODUCTIVO')

  const origin = `https://${labRef}.supabase.co`
  if (rawUrl !== origin && rawUrl !== `${origin}/`) {
    return fail('RESERVANEX_LAB_SUPABASE_URL tiene que ser exactamente https://<ref del lab>.supabase.co')
  }
  // Redundante con la igualdad exacta, a propósito: si alguien afloja la línea
  // de arriba, esto sigue cerrando puerto/userinfo/query/hash/path.
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.hostname !== `${labRef}.supabase.co` || url.port !== '' ||
      url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    return fail('RESERVANEX_LAB_SUPABASE_URL tiene que ser exactamente https://<ref del lab>.supabase.co')
  }

  if (key === '') return fail('falta RESERVANEX_LAB_SECRET_KEY')
  if (/\s/.test(key)) return fail('RESERVANEX_LAB_SECRET_KEY tiene espacios')
  if (key.includes(PRODUCTION_PROJECT_REF)) return fail('la key menciona el ref PRODUCTIVO')
  if (key.startsWith('sb_publishable_')) return fail('RESERVANEX_LAB_SECRET_KEY es una publishable key, no la secret')

  let keyKind: 'secret' | 'service_role_jwt'
  if (key.startsWith('sb_secret_')) {
    keyKind = 'secret'
  } else {
    const payload = decodeJwtPayload(key)
    if (!payload) return fail('RESERVANEX_LAB_SECRET_KEY no es ni sb_secret_… ni una key JWT')
    if (payload.role !== 'service_role') return fail('la key JWT no es service_role')
    if (payload.ref !== undefined && payload.ref !== labRef) return fail('la key JWT es de otro proyecto')
    keyKind = 'service_role_jwt'
  }

  const secrets = [rawUrl, key, origin, `${labRef}.supabase.co`, labRef]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)
  return { ok: true, origin, secretKey: key, keyKind, secrets }
}

/** Corre en CADA request HTTP: tira si el destino no es exactamente el lab. Los mensajes no incluyen la URL. */
export function assertLabRequest(origin: string, target: string): void {
  if (target.includes(PRODUCTION_PROJECT_REF)) throw new Error('request bloqueada: la URL menciona el ref PRODUCTIVO')
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error('request bloqueada: URL no parseable')
  }
  if (url.origin !== origin || url.username !== '' || url.password !== '') {
    throw new Error('request bloqueada: el destino no es el proyecto del lab')
  }
}

/** Lee .env.lab.local (KEY=VALUE, comentarios con #, comillas opcionales). No imprime nada. */
export function readLabEnvFile(path: string): LabEnv {
  const env: Record<string, string> = {}
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
  return env
}

/** Reemplaza cualquier secreto (y el ref productivo) en un texto antes de mostrarlo. */
export function redactLabSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join('<lab-redactado>')
  return out.split(PRODUCTION_PROJECT_REF).join('<REF-PRODUCTIVO>')
}

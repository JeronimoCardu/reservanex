/**
 * Property Videos 2B1 — conexión a la base del LABORATORIO, siempre detrás
 * del guard anti-producción (lab-db-target.ts). No hay otra forma de obtener
 * un cliente: si el guard falla, el proceso termina sin conectar.
 *
 * TLS: igual que la CLI de Supabase (sslmode=require), la conexión va
 * cifrada pero sin verificar la CA — Supabase firma con su propia CA, que no
 * está en el almacén de Node. El destino lo garantiza el guard (host y
 * usuario del lab), y esto es sólo para el proyecto de laboratorio.
 */

import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { assertLabRequest, readLabEnvFile, redactLabSecrets, resolveLabDatabaseTarget, resolveLabHttpTarget } from './lab-db-target'

export function repoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('no encontré la raíz del monorepo (pnpm-workspace.yaml)')
}

export interface LabConnection {
  databaseUrl: string
  secrets: string[]
  redact: (text: string) => string
  connect: (options?: { readOnly?: boolean; applicationName?: string }) => Promise<pg.Client>
}

/** Guard + datos de conexión. Termina el proceso (exit 2) si el guard no pasa. */
export function requireLabConnection(): LabConnection {
  const envPath = path.join(repoRoot(), '.env.lab.local')
  if (!fs.existsSync(envPath)) {
    console.error('LAB GUARD — FAIL: no existe .env.lab.local')
    process.exit(2)
  }
  const target = resolveLabDatabaseTarget(readLabEnvFile(envPath))
  if (!target.ok) {
    console.error(`LAB GUARD — FAIL: ${target.reason}`)
    process.exit(2)
  }
  const { databaseUrl, secrets } = target
  const redact = (text: string) => redactLabSecrets(text, secrets)
  return {
    databaseUrl,
    secrets,
    redact,
    async connect({ readOnly = false, applicationName = 'reservanex-lab-script' } = {}) {
      const client = new pg.Client({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false },
        application_name: applicationName,
        connectionTimeoutMillis: 20_000,
        statement_timeout: 120_000,
      })
      client.on('error', (error) => console.error(redact(`pg: ${error.message}`)))
      await client.connect()
      if (readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
      return client
    },
  }
}

export interface LabHttp {
  origin: string
  /** Sólo para construir clientes server-side; nunca se imprime ni se escribe. */
  secretKey: string
  keyKind: 'secret' | 'service_role_jwt'
  secrets: string[]
  redact: (text: string) => string
  /** fetch que valida CADA destino con assertLabRequest antes de salir. */
  fetch: typeof fetch
  /** Registro saneado de las requests hechas: método + path con los UUID enmascarados, sin query. */
  requests: Array<{ method: string; path: string; status?: number }>
}

/** Guard HTTP + fetch blindado al origin del lab. Termina el proceso (exit 2) si el guard no pasa. */
export function requireLabHttp(): LabHttp {
  const envPath = path.join(repoRoot(), '.env.lab.local')
  if (!fs.existsSync(envPath)) {
    console.error('LAB HTTP GUARD — FAIL: no existe .env.lab.local')
    process.exit(2)
  }
  const target = resolveLabHttpTarget(readLabEnvFile(envPath))
  if (!target.ok) {
    console.error(`LAB HTTP GUARD — FAIL: ${target.reason}`)
    process.exit(2)
  }
  const { origin, secretKey, keyKind, secrets } = target
  const redact = (text: string) => redactLabSecrets(text, secrets)
  const requests: LabHttp['requests'] = []
  const guardedFetch: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    assertLabRequest(origin, href)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const entry: LabHttp['requests'][number] = {
      method,
      path: new URL(href).pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'),
    }
    requests.push(entry)
    const response = await fetch(input, init)
    entry.status = response.status
    return response
  }
  return { origin, secretKey, keyKind, secrets, redact, fetch: guardedFetch, requests }
}

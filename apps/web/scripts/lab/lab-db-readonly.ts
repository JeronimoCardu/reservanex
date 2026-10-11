/**
 * Property Videos 2B1 — consultas de SOLO LECTURA contra la base del lab.
 *
 *   pnpm --filter @orderflow/web lab:db-readonly <archivo.sql>
 *
 * Pasa por el guard anti-producción, abre la sesión en modo READ ONLY y
 * además envuelve el SQL en BEGIN READ ONLY … ROLLBACK: cualquier escritura
 * falla en Postgres. La salida se redacta (URL, usuario, host, ref).
 */

import fs from 'node:fs'
import { requireLabConnection } from './lab-db'

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('uso: lab-db-readonly <archivo.sql>')
    process.exit(1)
  }
  const sql = fs.readFileSync(file, 'utf8')
  const lab = requireLabConnection()
  const client = await lab.connect({ readOnly: true, applicationName: 'reservanex-lab-readonly' })
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    const results = await client.query(sql)
    await client.query('ROLLBACK')
    const list = Array.isArray(results) ? results : [results]
    const out = list
      .filter((r) => r.command === 'SELECT' || r.rows?.length)
      .map((r) => r.rows)
    console.log(lab.redact(JSON.stringify(out.length === 1 ? out[0] : out, null, 1)))
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(requireLabConnection().redact(`lab-db-readonly falló: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
})

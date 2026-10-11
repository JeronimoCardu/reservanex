/**
 * Property Videos 2B1 — ejecutar un archivo SQL con ESCRITURA en la base del
 * LABORATORIO (pasos de preparación del lab, nunca de producción).
 *
 *   pnpm --filter @orderflow/web lab:db-exec <archivo.sql>
 *
 * Pasa por el guard anti-producción, corre todo en UNA transacción (si algo
 * falla no queda nada a medias) y redacta la salida.
 */

import fs from 'node:fs'
import { requireLabConnection } from './lab-db'

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('uso: lab-db-exec <archivo.sql>')
    process.exit(1)
  }
  const sql = fs.readFileSync(file, 'utf8')
  const lab = requireLabConnection()
  const client = await lab.connect({ applicationName: 'reservanex-lab-exec' })
  client.on('notice', (notice) => console.log(lab.redact(`NOTICE: ${notice.message}`)))
  try {
    await client.query('BEGIN')
    const results = await client.query(sql)
    await client.query('COMMIT')
    const list = Array.isArray(results) ? results : [results]
    const rows = list.filter((r) => r.rows?.length).map((r) => r.rows)
    console.log(lab.redact(JSON.stringify({ ok: true, statements: list.length, rows: rows.length === 1 ? rows[0] : rows }, null, 1)))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(requireLabConnection().redact(`lab-db-exec falló (rollback): ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
})

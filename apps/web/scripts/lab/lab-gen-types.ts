/**
 * Property Videos 2B1 — `supabase gen types typescript` del proyecto del
 * LABORATORIO, a un archivo.
 *
 *   pnpm --filter @orderflow/web lab:gen-types <archivo-de-salida.ts>
 *
 * Pasa por el guard anti-producción y usa --project-id con el ref del lab
 * (validado por el guard: formato y distinto del productivo). No linkea el
 * repo ni toca supabase/config.toml, y no pisa packages/types: escribe donde
 * se le indique, para comparar antes de copiar. Los errores se redactan.
 *
 * El script `db:types` de la raíz usa --linked: NO sirve para el lab.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { repoRoot, requireLabConnection } from './lab-db'
import { readLabEnvFile } from './lab-db-target'

async function main() {
  const out = process.argv[2]
  if (!out) {
    console.error('uso: lab-gen-types <archivo-de-salida.ts>')
    process.exit(1)
  }
  const lab = requireLabConnection()
  const root = repoRoot()
  const labRef = readLabEnvFile(path.join(root, '.env.lab.local')).RESERVANEX_LAB_PROJECT_REF!.trim()
  const pkg = createRequire(path.join(root, 'package.json')).resolve('supabase/package.json')
  const cli = path.join(path.dirname(pkg), 'dist', 'supabase.js')

  console.log('LAB GUARD — PASS · supabase gen types typescript --project-id <lab> --schema public')
  const chunks: Buffer[] = []
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [cli, 'gen', 'types', 'typescript', '--project-id', labRef, '--schema', 'public'],
      { cwd: root, shell: false, windowsHide: true })
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(lab.redact(chunk.toString('utf8'))))
    child.on('close', (exitCode) => resolve(exitCode ?? 1))
  })
  if (code !== 0) {
    process.stderr.write(lab.redact(Buffer.concat(chunks).toString('utf8')))
    process.exit(code)
  }
  fs.writeFileSync(out, Buffer.concat(chunks))
  console.log(`tipos escritos (${Buffer.concat(chunks).length} bytes)`)
}

main().catch((error: unknown) => {
  console.error(`lab-gen-types falló: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

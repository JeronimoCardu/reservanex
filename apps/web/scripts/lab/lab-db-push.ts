/**
 * Property Videos 2B1 — `supabase db push` contra la base del LABORATORIO.
 *
 *   pnpm --filter @orderflow/web lab:db-push -- --dry-run
 *   pnpm --filter @orderflow/web lab:db-push
 *
 * Pasa por el guard anti-producción y usa --db-url explícito: nunca linkea
 * el repo a un proyecto ni toca supabase/config.toml. Toda la salida de la
 * CLI se redacta (URL, usuario, host, ref) antes de mostrarse.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { repoRoot, requireLabConnection } from './lab-db'

/** El wrapper JS de la CLI (lanza el binario con execFileSync): se invoca con node, SIN shell. */
function supabaseCliEntry(root: string): string {
  const pkg = createRequire(path.join(root, 'package.json')).resolve('supabase/package.json')
  return path.join(path.dirname(pkg), 'dist', 'supabase.js')
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const lab = requireLabConnection()
  const root = repoRoot()
  // Sin shell: la URL (con su contraseña) viaja como argumento intacto; ningún
  // shell la interpreta (en Windows, cmd.exe trataría & | % ^ como operadores).
  const args = [supabaseCliEntry(root), 'db', 'push', '--db-url', lab.databaseUrl, ...(dryRun ? ['--dry-run'] : ['--yes'])]

  console.log(`LAB GUARD — PASS · supabase db push${dryRun ? ' --dry-run' : ''} → lab`)
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, shell: false, windowsHide: true })
    const relay = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) =>
      stream.on('data', (chunk: Buffer) => out.write(lab.redact(chunk.toString('utf8'))))
    relay(child.stdout, process.stdout)
    relay(child.stderr, process.stderr)
    child.on('close', (exitCode) => resolve(exitCode ?? 1))
  })
  process.exit(code)
}

main().catch((error: unknown) => {
  console.error(`lab-db-push falló: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

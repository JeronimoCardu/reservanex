// Root `pnpm run build`.
// - Default (local, CI, Vercel): `turbo run build` for the whole monorepo, as before. Extra
//   arguments are passed to turbo (`pnpm run build --filter=@orderflow/web`).
// - Hostinger (HOSTINGER_BUILD=1, set only in hPanel): builds apps/web as a standalone server and
//   prepares the publish root, see scripts/hostinger-web-build.mjs. That path must not launch a
//   nested pnpm (turbo runs each package build through pnpm), because Hostinger's global pnpm
//   rejects packageManager pnpm@9.15.4.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

if (process.env.HOSTINGER_BUILD === '1') {
  await import('./hostinger-web-build.mjs')
} else {
  const require = createRequire(import.meta.url)
  const turboPackageJson = require.resolve('turbo/package.json')
  const { bin } = JSON.parse(readFileSync(turboPackageJson, 'utf8'))
  const turboBin = path.join(
    path.dirname(turboPackageJson),
    typeof bin === 'string' ? bin : bin.turbo
  )
  const result = spawnSync(process.execPath, [turboBin, 'run', 'build', ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`[build] could not start turbo: ${result.error.message}`)
    process.exit(1)
  }
  if (result.signal) process.kill(process.pid, result.signal)
  process.exit(result.status ?? 1)
}

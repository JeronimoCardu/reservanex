// STAGING ONLY — branch staging/hostinger-smoke. NEVER merge into main.
// Root `build` for the Hostinger staging app: runs `next build` for apps/web without a nested
// pnpm/Corepack. Next is located with Node's module resolution from apps/web, so it works with
// whatever node_modules layout the install produced (pnpm isolated or hoisted).
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDir = path.join(rootDir, 'apps', 'web')
const requireFromWeb = createRequire(path.join(webDir, 'package.json'))

function fail(message) {
  console.error(`[hostinger-web-build] ${message}`)
  process.exit(1)
}

// Only reports which node_modules directories inside the repo hold `next` (no env vars).
function describeLookupDir(dir) {
  if (!existsSync(dir)) return 'missing'
  const next = path.join(dir, 'next')
  if (existsSync(next)) return 'has next'
  try {
    lstatSync(next)
    return 'next is a broken link'
  } catch {
    return 'no next'
  }
}

let nextPackageJson
try {
  nextPackageJson = requireFromWeb.resolve('next/package.json')
} catch (error) {
  const lookup = (requireFromWeb.resolve.paths('next') ?? [])
    .filter((dir) => !path.relative(rootDir, dir).startsWith('..'))
    .map((dir) => `${path.relative(rootDir, dir)}: ${describeLookupDir(dir)}`)
  fail(`cannot resolve next from apps/web (${error.code ?? error.message}); ${lookup.join(', ')}`)
}

const nextPackage = JSON.parse(readFileSync(nextPackageJson, 'utf8'))
const binEntry = typeof nextPackage.bin === 'string' ? nextPackage.bin : nextPackage.bin?.next
if (!binEntry) fail(`next ${nextPackage.version} declares no "next" bin`)
const nextBin = path.join(path.dirname(nextPackageJson), binEntry)
console.log(`[hostinger-web-build] next ${nextPackage.version}: ${path.relative(rootDir, nextBin)}`)

const result = spawnSync(process.execPath, [nextBin, 'build'], {
  cwd: webDir,
  stdio: 'inherit',
  env: process.env,
})
if (result.error) fail(`could not start next build: ${result.error.message}`)
if (result.signal) process.kill(process.pid, result.signal)
process.exit(result.status ?? 1)

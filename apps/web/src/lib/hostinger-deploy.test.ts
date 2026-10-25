// PROD-HOSTINGER-C — the Hostinger deploy setup must keep the normal monorepo build, keep the
// standalone output behind HOSTINGER_BUILD, never ship the staging smoke route, and pin Next where
// pnpm 9 applies it. Structural: the builds themselves are not run from a unit test.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = path.resolve(import.meta.dirname, '..', '..')
const ROOT = path.resolve(WEB, '..', '..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const rootPkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>
  pnpm?: { overrides?: Record<string, string> }
}

describe('build raíz', () => {
  it('despacha por HOSTINGER_BUILD y si no sigue siendo turbo run build', () => {
    expect(rootPkg.scripts.build).toBe('node scripts/build.mjs')
    const dispatcher = read('scripts/build.mjs')
    expect(dispatcher).toContain("process.env.HOSTINGER_BUILD === '1'")
    expect(dispatcher).toContain("import('./hostinger-web-build.mjs')")
    expect(dispatcher).toContain("'run', 'build'")
  })

  it('el build de Hostinger corre Next con Node, sin pnpm/npx/corepack anidado', () => {
    const builder = read('scripts/hostinger-web-build.mjs')
    expect(builder).toContain('process.execPath')
    expect(builder).not.toMatch(/['"`](pnpm|npx|npm|corepack)['"`]/)
  })
})

describe('next.config', () => {
  it('genera standalone sólo con HOSTINGER_BUILD=1', () => {
    const config = read('apps/web/next.config.ts')
    expect(config).toContain(
      "output: process.env.HOSTINGER_BUILD === '1' ? 'standalone' : undefined"
    )
    expect(config.match(/'standalone'/g)).toHaveLength(1)
  })
})

describe('smoke de staging', () => {
  it('la ruta /api/staging-smoke no existe', () => {
    expect(existsSync(path.join(WEB, 'src', 'app', 'api', 'staging-smoke'))).toBe(false)
  })
})

describe('pin de next', () => {
  it('vive en package.json → pnpm.overrides, no en pnpm-workspace.yaml (pnpm 9 lo ignora)', () => {
    expect(read('pnpm-workspace.yaml')).not.toMatch(/^overrides:/m)
    const pinned = rootPkg.pnpm?.overrides?.next
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
    for (const app of ['apps/web', 'apps/marketing']) {
      const pkg = JSON.parse(read(`${app}/package.json`)) as {
        dependencies: Record<string, string>
      }
      expect(pkg.dependencies.next).toBe(`^${pinned}`)
    }
  })

  it('el lockfile resuelve una sola versión de next: la fijada', () => {
    const versions = new Set(
      [...read('pnpm-lock.yaml').matchAll(/^ {2}next@(\d+\.\d+\.\d+)/gm)].map((m) => m[1])
    )
    expect([...versions]).toEqual([rootPkg.pnpm?.overrides?.next])
  })
})

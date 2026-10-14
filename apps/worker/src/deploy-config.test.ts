// MVP PROD-A1 — the deploy files must agree with the code and never carry
// secrets. Structural: they are not executable from a unit test.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HEALTH_PATH } from './internal-server'

const WORKER = join(__dirname, '..')
const ROOT   = join(WORKER, '..', '..')
const read   = (p: string) => readFileSync(p, 'utf8')
const noComments = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

const dockerfile   = noComments(read(join(WORKER, 'Dockerfile')))
const flyToml      = noComments(read(join(WORKER, 'fly.toml')))
const dockerignore = read(join(ROOT, '.dockerignore')).split('\n').map((l) => l.trim())
const rootPkg      = JSON.parse(read(join(ROOT, 'package.json'))) as { packageManager: string }

const SECRET_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'DEEPSEEK_API_KEY', 'WORKER_INTERNAL_SECRET', 'SUPABASE_URL', 'GROQ_API_KEY']

describe('.dockerignore', () => {
  it.each(['.env', '.env.*', '**/.env', '**/.env.*'])('excluye %s', (pattern) => {
    expect(dockerignore).toContain(pattern)
  })

  it('no re-incluye ningún .env', () => {
    expect(dockerignore.filter((l) => l.startsWith('!') && l.includes('.env'))).toEqual([])
  })

  it('excluye node_modules del host y los scripts de ops del worker', () => {
    expect(dockerignore).toContain('**/node_modules')
    expect(dockerignore).toContain('apps/worker/src/scripts')
  })
})

describe('Dockerfile', () => {
  it('Node 22 y el pnpm exacto del packageManager', () => {
    expect(dockerfile).toMatch(/^FROM node:22-/m)
    expect(rootPkg.packageManager).toBe('pnpm@9.15.4')
    expect(dockerfile).toContain(`corepack prepare ${rootPkg.packageManager} --activate`)
  })

  it('instala con el lockfile congelado y sólo el grafo del worker', () => {
    expect(dockerfile).toContain('pnpm install --frozen-lockfile --filter "@orderflow/worker..."')
  })

  it('NODE_ENV=production recién DESPUÉS del install (tsx es devDependency y es el loader)', () => {
    expect(dockerfile.indexOf('ENV NODE_ENV=production')).toBeGreaterThan(dockerfile.indexOf('pnpm install'))
  })

  it('un solo proceso en foreground, sin watch ni wrappers', () => {
    expect(dockerfile).toContain('CMD ["node", "--import", "tsx", "src/index.ts"]')
    expect(dockerfile).not.toMatch(/nodemon|tsx watch|pnpm (run )?(start|dev)|npm start/)
  })

  it('no corre como root', () => {
    expect(dockerfile).toMatch(/^USER node$/m)
  })

  it('ningún secreto: ni ENV/ARG con sus nombres, ni COPY de .env', () => {
    for (const name of SECRET_NAMES) expect(dockerfile).not.toMatch(new RegExp(`(ENV|ARG)\\s+${name}`))
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env/)
  })
})

describe('fly.toml', () => {
  it('una máquina siempre encendida, en gru', () => {
    expect(flyToml).toMatch(/^primary_region = "gru"$/m)
    expect(flyToml).toMatch(/auto_stop_machines\s*=\s*"off"/)
    expect(flyToml).toMatch(/min_machines_running\s*=\s*1$/m)
  })

  it('SIGTERM con margen para el presupuesto síncrono (20 s)', () => {
    expect(flyToml).toMatch(/^kill_signal\s*=\s*"SIGTERM"$/m)
    expect(flyToml).toMatch(/^kill_timeout\s*=\s*"30s"$/m)
  })

  it('el puerto del servicio es el que escucha el worker', () => {
    const internalPort = /internal_port\s*=\s*(\d+)/.exec(flyToml)?.[1]
    const envPort      = /WORKER_INTERNAL_PORT\s*=\s*"(\d+)"/.exec(flyToml)?.[1]
    expect(internalPort).toBe('8788')
    expect(envPort).toBe(internalPort)
  })

  it('el health check apunta al endpoint real', () => {
    expect(flyToml).toContain(`path         = "${HEALTH_PATH}"`)
    expect(flyToml).toMatch(/method\s*=\s*"GET"/)
  })

  it('HTTPS forzado', () => {
    expect(flyToml).toMatch(/force_https\s*=\s*true/)
  })

  it('[env] sólo lleva valores no secretos', () => {
    const envBlock = /\[env\]([\s\S]*?)\n\[/.exec(flyToml)?.[1] ?? ''
    const keys = envBlock.split('\n').map((l) => l.split('=')[0]?.trim()).filter(Boolean)
    expect(keys.sort()).toEqual(['NODE_ENV', 'WORKER_INTERNAL_PORT'])
    for (const name of SECRET_NAMES) expect(flyToml).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, 'm'))
  })
})

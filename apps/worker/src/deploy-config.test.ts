// MVP PROD-A1/A2 — the deploy files must agree with the code and never carry
// secrets. Structural: they are not executable from a unit test.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HEALTH_PATH } from './internal-server'
import { validateWorkerConfig } from './lib/startup-config'

const WORKER = join(__dirname, '..')
const ROOT   = join(WORKER, '..', '..')
const read   = (p: string) => readFileSync(p, 'utf8')
const noComments = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

const dockerfile   = noComments(read(join(WORKER, 'Dockerfile')))
const renderYaml   = noComments(read(join(ROOT, 'render.yaml')))
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

  it('ningún ARG: Render pasa TODAS las env vars del servicio como build args', () => {
    expect(dockerfile).not.toMatch(/^\s*ARG\s/m)
  })
})

// ── render.yaml ─────────────────────────────────────────────────────────────

const field = (name: string) => new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm').exec(renderYaml)?.[1]

// envVars: `- key: NAME` followed by `value: X` or `sync: false`.
function renderEnvVars(): Map<string, { value?: string; sync?: false }> {
  const vars  = new Map<string, { value?: string; sync?: false }>()
  const lines = renderYaml.split('\n')
  lines.forEach((line, i) => {
    const key = /^\s*- key:\s*(\S+)\s*$/.exec(line)?.[1]
    if (!key) return
    const next  = lines[i + 1] ?? ''
    const value = /^\s*value:\s*"?([^"]*?)"?\s*$/.exec(next)?.[1]
    if (value !== undefined)                vars.set(key, { value })
    else if (/^\s*sync:\s*false\s*$/.test(next)) vars.set(key, { sync: false })
    else                                    vars.set(key, {})
  })
  return vars
}

const RENDER_SECRETS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL',
  'WORKER_INTERNAL_SECRET', 'CUSTOMER_SITE_BASE_URL',
]

describe('render.yaml', () => {
  it('un único Web Service con Docker (Vercel necesita HTTPS público; un Background Worker no recibe tráfico)', () => {
    expect(renderYaml.match(/^\s*- type:/gm)).toHaveLength(1)
    expect(field('- type')).toBe('web')
    expect(field('runtime')).toBe('docker')
  })

  it('región oregon, junto al Supabase productivo (West US, us-west-2)', () => {
    expect(field('region')).toBe('oregon')
  })

  it('plan pago sin spin-down (0.5 CPU / 512 MB) y una sola instancia', () => {
    expect(field('plan')).toBe('0.5c-512mb')
    expect(field('numInstances')).toBe('1')
  })

  it('build: el Dockerfile del worker, con el monorepo como contexto', () => {
    const dockerfilePath = field('dockerfilePath')
    expect(dockerfilePath).toBe('./apps/worker/Dockerfile')
    expect(existsSync(join(ROOT, dockerfilePath!))).toBe(true)
    expect(field('dockerContext')).toBe('.')
    expect(renderYaml).not.toMatch(/^\s*dockerCommand:/m) // usa el CMD del Dockerfile
  })

  it('el health check apunta al endpoint real', () => {
    expect(field('healthCheckPath')).toBe(HEALTH_PATH)
  })

  it('el drenaje del worker entra en la ventana SIGTERM → SIGKILL', () => {
    const delaySeconds = Number(field('maxShutdownDelaySeconds'))
    const drainMs = Number(/const SHUTDOWN_DEADLINE_MS = ([\d_]+)/.exec(read(join(WORKER, 'src', 'index.ts')))?.[1]?.replace(/_/g, ''))
    expect(delaySeconds).toBe(30)
    expect(drainMs).toBe(25_000)
    expect(drainMs).toBeLessThan(delaySeconds * 1000)
  })

  it('PORT es el puerto que escucha el worker (default de internal-server.ts y EXPOSE)', () => {
    const vars        = renderEnvVars()
    const defaultPort = /const DEFAULT_PORT\s*=\s*(\d+)/.exec(read(join(WORKER, 'src', 'internal-server.ts')))?.[1]
    const exposed     = /^EXPOSE (\d+)$/m.exec(dockerfile)?.[1]
    expect(vars.get('PORT')?.value).toBe('8788')
    expect(defaultPort).toBe('8788')
    expect(exposed).toBe('8788')
    expect(vars.has('WORKER_INTERNAL_PORT')).toBe(false)
  })

  it('NODE_ENV=production (activa las exigencias de producción del fail-fast)', () => {
    expect(renderEnvVars().get('NODE_ENV')?.value).toBe('production')
  })

  it('los secretos van con sync: false, nunca con un valor en el archivo', () => {
    const vars = renderEnvVars()
    for (const name of RENDER_SECRETS) expect(vars.get(name), name).toEqual({ sync: false })
    const inline = [...vars].filter(([, v]) => v.value !== undefined).map(([k]) => k).sort()
    expect(inline).toEqual(['NODE_ENV', 'PORT'])
  })

  it('declara todo lo que el worker exige para arrancar en producción', () => {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, v] of renderEnvVars()) {
      env[key] = v.value
        ?? (key === 'WORKER_INTERNAL_SECRET' ? 's'.repeat(64) : key.endsWith('_URL') ? 'https://example.invalid' : 'dummy-value')
    }
    expect(validateWorkerConfig(env)).toEqual({ ok: true, problems: [], warnings: [] })
  })

  it('auto-deploy sólo cuando cambia algo que entra en la imagen', () => {
    expect(field('autoDeployTrigger')).toBe('commit')
    for (const path of ['apps/worker/**', 'packages/types/**', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.dockerignore']) {
      expect(renderYaml).toMatch(new RegExp(`^\\s*- ${path.replace(/[.*]/g, (c) => `\\${c}`)}$`, 'm'))
    }
  })
})

// MVP PROD-A1 — fail-fast de configuración: qué impide arrancar, qué no, y
// que los mensajes nunca lleven valores.

import { describe, expect, it } from 'vitest'
import { MIN_PRODUCTION_SECRET_LENGTH, validateWorkerConfig } from './startup-config'

const LONG_SECRET = 's'.repeat(MIN_PRODUCTION_SECRET_LENGTH)

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    NODE_ENV:                  'production',
    SUPABASE_URL:              'https://example-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-value-for-tests',
    DEEPSEEK_API_KEY:          'deepseek-key-value-for-tests',
    DEEPSEEK_MODEL:            'deepseek-chat',
    WORKER_INTERNAL_SECRET:    LONG_SECRET,
    CUSTOMER_SITE_BASE_URL:    'https://reservanex.example',
    ...overrides,
  }
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv
}

describe('validateWorkerConfig — obligatorias', () => {
  it('configuración completa de producción → ok, sin avisos', () => {
    expect(validateWorkerConfig(env())).toEqual({ ok: true, problems: [], warnings: [] })
  })

  it.each([
    ['SUPABASE_URL', 'falta SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL)'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'falta SUPABASE_SERVICE_ROLE_KEY'],
    ['DEEPSEEK_API_KEY', 'falta DEEPSEEK_API_KEY'],
    ['DEEPSEEK_MODEL', 'falta DEEPSEEK_MODEL'],
    ['WORKER_INTERNAL_SECRET', 'falta WORKER_INTERNAL_SECRET (el mismo valor que en apps/web)'],
  ])('sin %s → no arranca', (name, problem) => {
    const r = validateWorkerConfig(env({ [name]: undefined }))
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual([problem])
  })

  it('vacía o sólo espacios cuenta como ausente', () => {
    expect(validateWorkerConfig(env({ DEEPSEEK_API_KEY: '   ' })).problems).toEqual(['falta DEEPSEEK_API_KEY'])
  })

  it('reporta TODAS las que faltan juntas, no de a una', () => {
    expect(validateWorkerConfig({ NODE_ENV: 'production' }).problems).toHaveLength(5)
  })

  it('NEXT_PUBLIC_SUPABASE_URL alcanza (misma precedencia que lib/supabase.ts)', () => {
    expect(validateWorkerConfig(env({ SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co' })).ok).toBe(true)
  })
})

describe('validateWorkerConfig — formato', () => {
  it('producción: la URL de Supabase tiene que ser https', () => {
    expect(validateWorkerConfig(env({ SUPABASE_URL: 'http://p.supabase.co' })).problems)
      .toEqual(['SUPABASE_URL no es una URL https válida'])
    expect(validateWorkerConfig(env({ SUPABASE_URL: 'not a url' })).ok).toBe(false)
  })

  it('desarrollo: http está permitido (Supabase local)', () => {
    expect(validateWorkerConfig(env({ NODE_ENV: undefined, SUPABASE_URL: 'http://127.0.0.1:54321' })).ok).toBe(true)
  })

  it(`producción: WORKER_INTERNAL_SECRET de menos de ${MIN_PRODUCTION_SECRET_LENGTH} caracteres no arranca`, () => {
    const r = validateWorkerConfig(env({ WORKER_INTERNAL_SECRET: 's'.repeat(MIN_PRODUCTION_SECRET_LENGTH - 1) }))
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/demasiado corto/)
  })

  it('desarrollo: un secret corto se acepta (no rompe .env.local existentes)', () => {
    expect(validateWorkerConfig(env({ NODE_ENV: 'development', WORKER_INTERNAL_SECRET: 'dev' })).ok).toBe(true)
  })

  it.each(['0', '70000', 'abc', '8788.5', '-1'])('WORKER_INTERNAL_PORT=%s → no arranca', (port) => {
    expect(validateWorkerConfig(env({ WORKER_INTERNAL_PORT: port })).ok).toBe(false)
  })

  it('WORKER_INTERNAL_PORT válido o ausente → ok', () => {
    expect(validateWorkerConfig(env({ WORKER_INTERNAL_PORT: '8788' })).ok).toBe(true)
    expect(validateWorkerConfig(env({ WORKER_INTERNAL_PORT: undefined })).ok).toBe(true)
  })

  it.each(['abc', '0', '999', '60001'])('AUTORESPONDER_SYNC_TIMEOUT_MS=%s → no arranca (NaN vencía cada request al instante)', (ms) => {
    expect(validateWorkerConfig(env({ AUTORESPONDER_SYNC_TIMEOUT_MS: ms })).ok).toBe(false)
  })

  it('AUTORESPONDER_SYNC_TIMEOUT_MS=20000 → ok', () => {
    expect(validateWorkerConfig(env({ AUTORESPONDER_SYNC_TIMEOUT_MS: '20000' })).ok).toBe(true)
  })

  it('DEEPSEEK_BASE_URL es opcional, pero si está tiene que ser una URL', () => {
    expect(validateWorkerConfig(env({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com' })).ok).toBe(true)
    expect(validateWorkerConfig(env({ DEEPSEEK_BASE_URL: 'nope' })).ok).toBe(false)
  })
})

describe('validateWorkerConfig — opcionales del MVP no se exigen', () => {
  it('sin GROQ_API_KEY ni HUMAN_HANDOFF_TIMEOUT_MS → ok', () => {
    expect(validateWorkerConfig(env({ GROQ_API_KEY: undefined, HUMAN_HANDOFF_TIMEOUT_MS: undefined })).ok).toBe(true)
  })

  it('producción sin URL del sitio de clientes → arranca, con aviso', () => {
    const r = validateWorkerConfig(env({ CUSTOMER_SITE_BASE_URL: undefined }))
    expect(r.ok).toBe(true)
    expect(r.warnings).toHaveLength(1)
  })
})

describe('validateWorkerConfig — sin valores en los mensajes', () => {
  it('ningún problema ni aviso repite un valor del entorno', () => {
    const values = {
      SUPABASE_URL:              'http://leaky-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'x',
      DEEPSEEK_BASE_URL:         'leaky-base-url',
      WORKER_INTERNAL_SECRET:    'leaky-short-secret',
      WORKER_INTERNAL_PORT:      'leaky-port',
      AUTORESPONDER_SYNC_TIMEOUT_MS: 'leaky-timeout',
      CUSTOMER_SITE_BASE_URL:    undefined,
    }
    const r = validateWorkerConfig(env(values))
    expect(r.ok).toBe(false)
    const text = [...r.problems, ...r.warnings].join('\n')
    for (const v of Object.values(values)) if (v && v.length > 1) expect(text).not.toContain(v)
  })
})

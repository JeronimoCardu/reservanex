import { describe, expect, it } from 'vitest'
import {
  PRODUCTION_PROJECT_REF,
  assertLabRequest,
  redactLabSecrets,
  resolveLabDatabaseTarget,
  resolveLabHttpTarget,
  type LabEnv,
} from '../../scripts/lab/lab-db-target'

// Property Videos 2B1 — el guard anti-producción de los scripts de laboratorio.
// Todo lo que toca la base del lab pasa por acá antes de conectar.

const LAB = 'abcdefghijklmnopqrst'
const POOLER = `postgresql://postgres.${LAB}:s3cr3t%40pass@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`
const DIRECT = `postgresql://postgres:s3cr3t%40pass@db.${LAB}.supabase.co:5432/postgres`

function env(overrides: Partial<LabEnv> = {}): LabEnv {
  return { RESERVANEX_LAB_DATABASE_URL: POOLER, RESERVANEX_LAB_PROJECT_REF: LAB, RESERVANEX_ALLOW_LAB_DB: '1', ...overrides }
}

describe('resolveLabDatabaseTarget', () => {
  it('acepta el Session pooler con usuario <rol>.<ref del lab>', () => {
    expect(resolveLabDatabaseTarget(env())).toMatchObject({ ok: true, hostKind: 'pooler', databaseUrl: POOLER })
  })

  it('acepta la conexión directa db.<ref del lab>.supabase.co', () => {
    expect(resolveLabDatabaseTarget(env({ RESERVANEX_LAB_DATABASE_URL: DIRECT }))).toMatchObject({ ok: true, hostKind: 'directo' })
  })

  it.each([
    ['sin flag', { RESERVANEX_ALLOW_LAB_DB: undefined }],
    ['flag distinto de 1', { RESERVANEX_ALLOW_LAB_DB: 'true' }],
    ['ref del lab = ref productivo', { RESERVANEX_LAB_PROJECT_REF: PRODUCTION_PROJECT_REF }],
    ['ref con formato inválido', { RESERVANEX_LAB_PROJECT_REF: 'ABC' }],
    ['sin URL', { RESERVANEX_LAB_DATABASE_URL: '' }],
    ['URL HTTPS del proyecto', { RESERVANEX_LAB_DATABASE_URL: `https://${LAB}.supabase.co` }],
    ['otra base', { RESERVANEX_LAB_DATABASE_URL: POOLER.replace(/\/postgres$/, '/otra') }],
    ['Transaction pooler (6543)', { RESERVANEX_LAB_DATABASE_URL: POOLER.replace(':5432', ':6543') }],
    ['sin contraseña', { RESERVANEX_LAB_DATABASE_URL: `postgresql://postgres.${LAB}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres` }],
    ['pooler con el ref productivo en el usuario', { RESERVANEX_LAB_DATABASE_URL: POOLER.replace(`postgres.${LAB}`, `postgres.${PRODUCTION_PROJECT_REF}`) }],
    ['pooler con otro ref en el usuario', { RESERVANEX_LAB_DATABASE_URL: POOLER.replace(`postgres.${LAB}`, 'postgres.zzzzzzzzzzzzzzzzzzzz') }],
    ['pooler sin ref en el usuario', { RESERVANEX_LAB_DATABASE_URL: POOLER.replace(`postgres.${LAB}`, 'postgres') }],
    ['directo con el host productivo', { RESERVANEX_LAB_DATABASE_URL: DIRECT.replace(`db.${LAB}`, `db.${PRODUCTION_PROJECT_REF}`) }],
    ['host arbitrario', { RESERVANEX_LAB_DATABASE_URL: POOLER.replace('aws-0-sa-east-1.pooler.supabase.com', 'evil.example.com') }],
    ['host parecido', { RESERVANEX_LAB_DATABASE_URL: POOLER.replace('pooler.supabase.com', 'pooler.supabase.com.evil.com') }],
    ['query host= que redirige', { RESERVANEX_LAB_DATABASE_URL: `${POOLER}?host=db.${PRODUCTION_PROJECT_REF}.supabase.co` }],
    ['ref productivo en cualquier parte (query)', { RESERVANEX_LAB_DATABASE_URL: `${POOLER}?sslmode=${PRODUCTION_PROJECT_REF}` }],
  ])('rechaza: %s', (_, overrides) => {
    const result = resolveLabDatabaseTarget(env(overrides as Partial<LabEnv>))
    expect(result.ok).toBe(false)
  })

  it('acepta sslmode como único parámetro de query', () => {
    expect(resolveLabDatabaseTarget(env({ RESERVANEX_LAB_DATABASE_URL: `${POOLER}?sslmode=require` })).ok).toBe(true)
  })

  it('los motivos de rechazo no incluyen valores', () => {
    for (const overrides of [{ RESERVANEX_LAB_DATABASE_URL: POOLER.replace(':5432', ':6543') }, { RESERVANEX_LAB_DATABASE_URL: `${POOLER}?host=x` }, { RESERVANEX_ALLOW_LAB_DB: '0' }]) {
      const result = resolveLabDatabaseTarget(env(overrides))
      if (result.ok) throw new Error('debía fallar')
      expect(result.reason).not.toContain('s3cr3t')
      expect(result.reason).not.toContain(LAB)
    }
  })
})

// Property Videos 2B1.1 — guard de las llamadas HTTP (Storage / PostgREST) al lab.

const ORIGIN = `https://${LAB}.supabase.co`
// Keys de mentira armadas en runtime: ningún literal con forma de key de
// Supabase en el repo (el secret scanning las reconoce por el prefijo).
const fakeKey = (kind: 'secret' | 'publishable') => ['sb', kind, 'FAKE', 'x'.repeat(24)].join('_')
const SECRET = fakeKey('secret')
const jwt = (payload: Record<string, unknown>) =>
  ['{"alg":"HS256","typ":"JWT"}', JSON.stringify(payload)].map((p) => Buffer.from(p).toString('base64url')).join('.') + '.firma'

function httpEnv(overrides: Partial<LabEnv> = {}): LabEnv {
  return { ...env(), RESERVANEX_LAB_SUPABASE_URL: ORIGIN, RESERVANEX_LAB_SECRET_KEY: SECRET, ...overrides }
}

describe('resolveLabHttpTarget', () => {
  it('acepta exactamente https://<ref del lab>.supabase.co con una sb_secret key', () => {
    expect(resolveLabHttpTarget(httpEnv())).toMatchObject({ ok: true, origin: ORIGIN, keyKind: 'secret', secretKey: SECRET })
  })

  it('tolera sólo la barra final', () => {
    expect(resolveLabHttpTarget(httpEnv({ RESERVANEX_LAB_SUPABASE_URL: `${ORIGIN}/` })).ok).toBe(true)
  })

  it('acepta una key JWT legacy service_role del lab (con o sin ref)', () => {
    expect(resolveLabHttpTarget(httpEnv({ RESERVANEX_LAB_SECRET_KEY: jwt({ role: 'service_role', ref: LAB }) }))).toMatchObject({ ok: true, keyKind: 'service_role_jwt' })
    expect(resolveLabHttpTarget(httpEnv({ RESERVANEX_LAB_SECRET_KEY: jwt({ role: 'service_role' }) })).ok).toBe(true)
  })

  it.each([
    ['sin flag', { RESERVANEX_ALLOW_LAB_DB: undefined }],
    ['ref del lab = ref productivo', { RESERVANEX_LAB_PROJECT_REF: PRODUCTION_PROJECT_REF }],
    ['sin URL', { RESERVANEX_LAB_SUPABASE_URL: '' }],
    ['URL productiva', { RESERVANEX_LAB_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` }],
    ['otro proyecto', { RESERVANEX_LAB_SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' }],
    ['http', { RESERVANEX_LAB_SUPABASE_URL: `http://${LAB}.supabase.co` }],
    ['puerto', { RESERVANEX_LAB_SUPABASE_URL: `${ORIGIN}:443` }],
    ['puerto no estándar', { RESERVANEX_LAB_SUPABASE_URL: `${ORIGIN}:8443` }],
    ['userinfo', { RESERVANEX_LAB_SUPABASE_URL: `https://user:pass@${LAB}.supabase.co` }],
    ['query', { RESERVANEX_LAB_SUPABASE_URL: `${ORIGIN}?x=1` }],
    ['hash', { RESERVANEX_LAB_SUPABASE_URL: `${ORIGIN}#x` }],
    ['path', { RESERVANEX_LAB_SUPABASE_URL: `${ORIGIN}/storage/v1` }],
    ['host parecido', { RESERVANEX_LAB_SUPABASE_URL: `${ORIGIN}.evil.com` }],
    ['host del Storage (no es el origin del proyecto)', { RESERVANEX_LAB_SUPABASE_URL: `https://${LAB}.storage.supabase.co` }],
    ['sin key', { RESERVANEX_LAB_SECRET_KEY: '' }],
    ['key con espacios', { RESERVANEX_LAB_SECRET_KEY: `${SECRET} x` }],
    ['publishable key', { RESERVANEX_LAB_SECRET_KEY: fakeKey('publishable') }],
    ['key JWT anon', { RESERVANEX_LAB_SECRET_KEY: jwt({ role: 'anon', ref: LAB }) }],
    ['key JWT de otro proyecto', { RESERVANEX_LAB_SECRET_KEY: jwt({ role: 'service_role', ref: 'zzzzzzzzzzzzzzzzzzzz' }) }],
    ['key JWT productiva', { RESERVANEX_LAB_SECRET_KEY: jwt({ role: 'service_role', ref: PRODUCTION_PROJECT_REF }) }],
    ['key con formato desconocido', { RESERVANEX_LAB_SECRET_KEY: 'no-es-una-key' }],
  ])('rechaza: %s', (_, overrides) => {
    expect(resolveLabHttpTarget(httpEnv(overrides as Partial<LabEnv>)).ok).toBe(false)
  })

  it('los motivos de rechazo no incluyen la key, la URL ni el ref', () => {
    for (const overrides of [{ RESERVANEX_LAB_SUPABASE_URL: `${ORIGIN}?x=1` }, { RESERVANEX_LAB_SECRET_KEY: `${SECRET} x` }, { RESERVANEX_LAB_SECRET_KEY: jwt({ role: 'anon' }) }]) {
      const result = resolveLabHttpTarget(httpEnv(overrides))
      if (result.ok) throw new Error('debía fallar')
      expect(result.reason).not.toContain(SECRET)
      expect(result.reason).not.toContain(LAB)
    }
  })

  it('redacta la key, el origin y el ref', () => {
    const target = resolveLabHttpTarget(httpEnv())
    if (!target.ok) throw new Error('debía pasar')
    const redacted = redactLabSecrets(`GET ${ORIGIN}/storage/v1/object apikey=${SECRET} ref=${LAB}`, target.secrets)
    for (const secret of [SECRET, ORIGIN, LAB]) expect(redacted).not.toContain(secret)
  })
})

describe('assertLabRequest', () => {
  it('deja pasar requests al origin del lab', () => {
    expect(() => assertLabRequest(ORIGIN, `${ORIGIN}/storage/v1/object/property-videos/a.mp4`)).not.toThrow()
    expect(() => assertLabRequest(ORIGIN, `${ORIGIN}/rest/v1/rpc/reserve_property_video_upload`)).not.toThrow()
  })

  it.each([
    ['producción', `https://${PRODUCTION_PROJECT_REF}.supabase.co/storage/v1/object/x`],
    ['ref productivo en la query', `${ORIGIN}/storage/v1/object/x?r=${PRODUCTION_PROJECT_REF}`],
    ['otro origin', 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co/storage/v1/object/x'],
    ['host del Storage', `https://${LAB}.storage.supabase.co/storage/v1/object/x`],
    ['http', `http://${LAB}.supabase.co/storage/v1/object/x`],
    ['userinfo', `https://u:p@${LAB}.supabase.co/storage/v1/object/x`],
    ['no parseable', 'nada'],
  ])('bloquea: %s', (_, target) => {
    expect(() => assertLabRequest(ORIGIN, target)).toThrow(/request bloqueada/)
  })
})

describe('redactLabSecrets', () => {
  it('borra URL, contraseña, usuario, host y ref, y marca el ref productivo', () => {
    const target = resolveLabDatabaseTarget(env())
    if (!target.ok) throw new Error('debía pasar')
    const text = `conectando a ${POOLER} como postgres.${LAB} (pass s3cr3t@pass) host aws-0-sa-east-1.pooler.supabase.com; prod=${PRODUCTION_PROJECT_REF}`
    const redacted = redactLabSecrets(text, target.secrets)
    for (const secret of [POOLER, 's3cr3t@pass', LAB, 'aws-0-sa-east-1.pooler.supabase.com']) expect(redacted).not.toContain(secret)
    expect(redacted).not.toContain(PRODUCTION_PROJECT_REF)
  })
})

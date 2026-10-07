import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { FakeSupabase, fakeAccessToken } from '@/testing/fake-supabase'

// Property Videos Fase 1 — la ruta autoriza y redirige con 307 a una signed URL;
// nunca transporta bytes. Base de datos y Storage en memoria (FakeSupabase).

vi.mock('@orderflow/supabase/admin',  () => ({ createAdminClient: vi.fn() }))
vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))

import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient } from '@orderflow/supabase/server'
import { getPublicTenant } from '@/lib/repositories/public-site.repository'
import { PROPERTY_VIDEO_SIGNED_URL_TTL_SECONDS } from '@/lib/property-videos/delivery'
import { GET } from './route'

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const PROP_A   = 'aaaaaaaa-1111-4000-8000-00000000000a'
const PROP_B   = 'bbbbbbbb-1111-4000-8000-00000000000b'
const VIDEO    = 'aaaaaaaa-3333-4000-8000-00000000000a'
const VIDEO_INYECTADO = 'aaaaaaaa-4444-4000-8000-00000000000a' // tenant A, propiedad de B
const PATH     = `${TENANT_A}/9d1c3f4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f.mp4`

let db: FakeSupabase
let server: FakeSupabase

function tenant(id: string, overrides: Record<string, unknown> = {}) {
  return { id, public_slug: `slug-${id.slice(0, 4)}`, status: 'active', public_site_enabled: true, deleted_at: null, ...overrides }
}

function setup(opts: {
  tenantA?:   Record<string, unknown>
  propertyA?: Record<string, unknown>
  impersonation?: Record<string, unknown>[]
} = {}) {
  db = new FakeSupabase({
    tenants: [tenant(TENANT_A, opts.tenantA), tenant(TENANT_B)],
    properties: [
      { id: PROP_A, tenant_id: TENANT_A, published: true, deleted_at: null, ...opts.propertyA },
      { id: PROP_B, tenant_id: TENANT_B, published: true, deleted_at: null },
    ],
    property_videos: [
      { id: VIDEO,           tenant_id: TENANT_A, property_id: PROP_A, storage_path: PATH, mime_type: 'video/mp4' },
      { id: VIDEO_INYECTADO, tenant_id: TENANT_A, property_id: PROP_B, storage_path: `${TENANT_A}/inyectado.mp4`, mime_type: 'video/mp4' },
    ],
    impersonation_sessions: opts.impersonation ?? [],
  })
  server = new FakeSupabase()
  vi.mocked(createAdminClient).mockReturnValue(db as never)
  vi.mocked(createClient).mockResolvedValue(server as never)
}

function loginTenantUser(tenantId: string) {
  server.auth.signIn(fakeAccessToken({ user_type: 'tenant_user', role: 'owner', tenant_id: tenantId, workspace_ids: null }))
}

function loginOperator() {
  server.auth.signIn(fakeAccessToken({ user_type: 'platform_user', role: 'operator' }))
}

function get(videoId: string, headers: Record<string, string> = {}) {
  return GET(
    new NextRequest(`http://127.0.0.1/api/property-videos/${videoId}`, { headers }),
    { params: Promise.resolve({ videoId }) },
  )
}

async function expectRedirect(res: Response) {
  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toBe(
    `https://storage.test/storage/v1/object/sign/property-videos/${PATH}?token=tok-${PROPERTY_VIDEO_SIGNED_URL_TTL_SECONDS}`,
  )
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(await res.text()).toBe('')
}

async function expectNotFound(res: Response) {
  expect(res.status).toBe(404)
  expect(res.headers.get('location')).toBeNull()
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  const body = await res.text()
  expect(body).not.toContain(TENANT_A)
  expect(body).not.toContain('.mp4')
  expect(body).not.toContain('token')
  expect(db.storage.callsOf('createSignedUrl')).toHaveLength(0)
}

beforeEach(() => {
  vi.clearAllMocks()
  setup()
})

afterEach(() => {
  // Ninguna respuesta de esta ruta descarga el video, sea cual sea el caso.
  expect(db.storage.callsOf('download')).toHaveLength(0)
})

describe('público válido', () => {
  it('307 a la signed URL: Location, TTL 900, private no-store, cuerpo vacío', async () => {
    await expectRedirect(await get(VIDEO))
    expect(db.storage.callsOf('createSignedUrl')).toEqual([
      { bucket: 'property-videos', method: 'createSignedUrl', args: [PATH, 900] },
    ])
  })

  it('no devuelve headers de rango: esos los pone Storage', async () => {
    const res = await get(VIDEO)
    expect(res.headers.get('accept-ranges')).toBeNull()
    expect(res.headers.get('content-range')).toBeNull()
  })
})

describe('Range', () => {
  it.each(['bytes=0-1', 'bytes=0-', 'bytes=1000-2000', 'bytes=-500', 'basura'])(
    'Range %j → igual 307, sin descargar nada',
    async (range) => {
      await expectRedirect(await get(VIDEO, { range }))
    },
  )
})

describe('404 uniforme', () => {
  it.each(['no-es-un-uuid', '123', `${VIDEO}x`, "'; drop table x; --"])('id %j → 404 SIN consultar la base', async (id) => {
    await expectNotFound(await get(id))
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(db.queries).toHaveLength(0)
  })

  it('video inexistente → 404', async () => {
    await expectNotFound(await get('cccccccc-3333-4000-8000-00000000000c'))
  })

  it('propiedad no publicada → 404', async () => {
    setup({ propertyA: { published: false } })
    await expectNotFound(await get(VIDEO))
  })

  it('propiedad borrada → 404', async () => {
    setup({ propertyA: { deleted_at: '2026-09-01T00:00:00Z' } })
    await expectNotFound(await get(VIDEO))
  })

  it.each(['suspended', 'churned'])('tenant %s → 404', async (status) => {
    setup({ tenantA: { status } })
    await expectNotFound(await get(VIDEO))
  })

  it('tenant borrado → 404', async () => {
    setup({ tenantA: { deleted_at: '2026-09-01T00:00:00Z' } })
    await expectNotFound(await get(VIDEO))
  })

  it('public_site_enabled = false → 404', async () => {
    setup({ tenantA: { public_site_enabled: false } })
    await expectNotFound(await get(VIDEO))
  })

  it('video de un tenant colgado de la propiedad (publicada) de otro → 404', async () => {
    await expectNotFound(await get(VIDEO_INYECTADO))
  })

  it('…también para el usuario del tenant que lo subió', async () => {
    loginTenantUser(TENANT_A)
    await expectNotFound(await get(VIDEO_INYECTADO))
  })
})

describe('vista previa autenticada', () => {
  beforeEach(() => setup({ propertyA: { published: false } }))

  it('usuario del mismo tenant ve el video de una propiedad no publicada → 307', async () => {
    loginTenantUser(TENANT_A)
    await expectRedirect(await get(VIDEO))
  })

  it('…y de un tenant suspendido (la vista previa no aplica la regla pública, como antes)', async () => {
    setup({ propertyA: { published: false }, tenantA: { status: 'suspended' } })
    loginTenantUser(TENANT_A)
    await expectRedirect(await get(VIDEO))
  })

  it('usuario de otro tenant → 404 (no es oráculo: igual que un anónimo)', async () => {
    loginTenantUser(TENANT_B)
    await expectNotFound(await get(VIDEO))
  })

  it('usuario de otro tenant con la propiedad publicada → 307, como cualquier visitante', async () => {
    setup()
    loginTenantUser(TENANT_B)
    await expectRedirect(await get(VIDEO))
  })

  it('operator con impersonación activa sobre el tenant → 307', async () => {
    setup({
      propertyA: { published: false },
      impersonation: [{ platform_user_id: 'user-1', target_tenant_id: TENANT_A, ended_at: null, started_at: '2026-10-06T10:00:00Z' }],
    })
    loginOperator()
    await expectRedirect(await get(VIDEO))
  })

  it('operator impersonando OTRO tenant → 404', async () => {
    setup({
      propertyA: { published: false },
      impersonation: [{ platform_user_id: 'user-1', target_tenant_id: TENANT_B, ended_at: null, started_at: '2026-10-06T10:00:00Z' }],
    })
    loginOperator()
    await expectNotFound(await get(VIDEO))
  })

  it('operator con la impersonación terminada → 404', async () => {
    setup({
      propertyA: { published: false },
      impersonation: [{ platform_user_id: 'user-1', target_tenant_id: TENANT_A, ended_at: '2026-10-06T11:00:00Z', started_at: '2026-10-06T10:00:00Z' }],
    })
    loginOperator()
    await expectNotFound(await get(VIDEO))
  })
})

describe('errores operativos, sanitizados', () => {
  it('createSignedUrl falla por un error de Storage → 503 sin detalle', async () => {
    db.storage.signedUrl = () => ({ data: null, error: { message: `boom en ${PATH}`, status: 500, statusCode: '500' } })
    const res = await get(VIDEO)
    expect(res.status).toBe(503)
    expect(res.headers.get('location')).toBeNull()
    const body = await res.text()
    expect(body).toBe(JSON.stringify({ error: 'Unavailable' }))
  })

  it('el objeto no existe en Storage → 404 uniforme', async () => {
    db.storage.signedUrl = () => ({ data: null, error: { message: 'Object not found', status: 400, statusCode: '404' } })
    const res = await get(VIDEO)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(JSON.stringify({ error: 'Not found' }))
  })

  it.each(['property_videos', 'properties', 'tenants'])('error de la base en %s → 503 sin detalle', async (tabla) => {
    db.failOn(tabla, { code: 'XX000', message: `detalle interno ${PATH}` })
    const res = await get(VIDEO)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe(JSON.stringify({ error: 'Unavailable' }))
  })

  it('los logs no llevan el path, el token ni la signed URL', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    db.storage.signedUrl = () => ({ data: null, error: { message: `boom en ${PATH}`, status: 500, statusCode: '500' } })
    await get(VIDEO)
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toContain(PATH)
    expect(logged).not.toContain('token')
    spy.mockRestore()
  })
})

// ── Paridad con el sitio público ─────────────────────────────────────────────
//
// La ruta y getPublicTenant comparten isTenantPubliclyVisible. Para cada
// combinación de estado del tenant, un video publicado es visible por la ruta
// exactamente cuando el sitio del tenant es visible.

describe('paridad con getPublicTenant', () => {
  const casos: Record<string, unknown>[] = []
  for (const status of ['trial', 'active', 'suspended', 'churned']) {
    for (const public_site_enabled of [true, false]) {
      for (const deleted_at of [null, '2026-09-01T00:00:00Z']) casos.push({ status, public_site_enabled, deleted_at })
    }
  }

  it.each(casos)('tenant %j', async (estado) => {
    setup({ tenantA: estado })
    const sitioVisible = (await getPublicTenant(`slug-${TENANT_A.slice(0, 4)}`)) !== null
    const videoVisible = (await get(VIDEO)).status === 307
    expect(videoVisible).toBe(sitioVisible)
  })
})

// ── Guard estructural ────────────────────────────────────────────────────────
//
// La ruta no puede volver a transportar bytes de video. Si alguien reintroduce
// la descarga o el manejo de rangos, esto falla.

describe('guard: /api/property-videos no transporta bytes', () => {
  // Sólo el código: los comentarios explican el 206 de Storage y el Range.
  const soloCodigo = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  const dir = import.meta.dirname
  const fuentes = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, soloCodigo(fs.readFileSync(path.join(dir, f), 'utf8'))] as const)

  it('hay al menos una fuente que revisar', () => {
    expect(fuentes.map(([f]) => f)).toContain('route.ts')
  })

  it.each([
    ['.storage.download(', /\.download\(/],
    ['arrayBuffer', /arrayBuffer/],
    ['.slice( sobre bytes', /\.slice\(/],
    ['lectura del header Range', /headers\.get\(\s*['"]range['"]\s*\)/i],
    ['status 206', /\b206\b/],
    ['Content-Range', /Content-Range/i],
    ['Accept-Ranges', /Accept-Ranges/i],
  ])('ninguna fuente usa %s', (_label, patron) => {
    for (const [archivo, src] of fuentes) expect(src, archivo).not.toMatch(patron)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSupabase } from '@/testing/fake-supabase'

// Property Videos Fase 1 — uploadPropertyVideoAction no puede colgar un video
// de una propiedad de OTRO tenant. La propiedad se resuelve contra el tenant
// de la sesión ANTES de cualquier efecto: si no es suya (o está borrada), no
// se sube un byte a Storage ni se inserta la fila.

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/require-tenant-context', () => ({ requireTenantContext: vi.fn() }))
vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))

import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createClient } from '@orderflow/supabase/server'
import { uploadPropertyVideoAction } from './properties'

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const PROP_A   = 'aaaaaaaa-1111-4000-8000-00000000000a'
const PROP_B   = 'bbbbbbbb-1111-4000-8000-00000000000b'
const PROP_A_BORRADA = 'aaaaaaaa-2222-4000-8000-00000000000a'

let db: FakeSupabase

function contexto(overrides: Record<string, unknown> = {}) {
  vi.mocked(requireTenantContext).mockResolvedValue({
    userId: 'user-1', tenantId: TENANT_A, role: 'owner', canCreateProperties: true,
    workspaceIds: null, accessMode: 'tenant_user',
    ...overrides,
  } as never)
}

function formulario(): FormData {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array([0, 0, 0, 24])], 'casa.mp4', { type: 'video/mp4' }))
  fd.append('duration_seconds', '30')
  return fd
}

function sinEfectos() {
  expect(db.storage.callsOf('upload')).toHaveLength(0)
  expect(db.queriesOn('property_videos')).toHaveLength(0)
  expect(db.rows('property_videos')).toHaveLength(0)
}

beforeEach(() => {
  vi.clearAllMocks()
  db = new FakeSupabase({
    properties: [
      { id: PROP_A,         tenant_id: TENANT_A, deleted_at: null },
      { id: PROP_B,         tenant_id: TENANT_B, deleted_at: null },
      { id: PROP_A_BORRADA, tenant_id: TENANT_A, deleted_at: '2026-09-01T00:00:00Z' },
    ],
    property_videos: [],
  })
  vi.mocked(createClient).mockResolvedValue(db as never)
  contexto()
})

describe('uploadPropertyVideoAction — propiedad del tenant', () => {
  it('tenant A + propiedad de tenant B → rechazo, sin Storage ni INSERT', async () => {
    const r = await uploadPropertyVideoAction(PROP_B, formulario())
    expect(r).toEqual({ success: false, error: 'Propiedad no encontrada.' })
    sinEfectos()
  })

  it('la propiedad se resuelve con id + tenant de la sesión + no borrada', async () => {
    await uploadPropertyVideoAction(PROP_B, formulario())
    expect(db.queriesOn('properties')[0]?.filters).toEqual([`id=${PROP_B}`, `tenant_id=${TENANT_A}`, 'deleted_at is null'])
  })

  it('propiedad propia pero borrada → rechazo, sin efectos', async () => {
    expect(await uploadPropertyVideoAction(PROP_A_BORRADA, formulario())).toMatchObject({ success: false })
    sinEfectos()
  })

  it('propiedad inexistente → rechazo, sin efectos', async () => {
    expect(await uploadPropertyVideoAction('cccccccc-1111-4000-8000-00000000000c', formulario())).toMatchObject({ success: false })
    sinEfectos()
  })

  it('el chequeo corre antes que todo: sin archivo y con propiedad ajena, igual es "Propiedad no encontrada"', async () => {
    expect(await uploadPropertyVideoAction(PROP_B, new FormData())).toEqual({ success: false, error: 'Propiedad no encontrada.' })
    sinEfectos()
  })

  it('owner con propiedad propia → flujo existente: sube a SU carpeta e inserta con su tenant', async () => {
    const r = await uploadPropertyVideoAction(PROP_A, formulario())
    expect(r.success).toBe(true)

    const [upload] = db.storage.callsOf('upload')
    expect(upload?.bucket).toBe('property-videos')
    expect(String(upload?.args[0])).toMatch(new RegExp(`^${TENANT_A}/[0-9a-f-]{36}\\.mp4$`))

    expect(db.rows('property_videos')).toEqual([
      expect.objectContaining({ tenant_id: TENANT_A, property_id: PROP_A, mime_type: 'video/mp4', duration_seconds: 30 }),
    ])
  })

  it('sin permiso de propiedades → rechazo sin tocar la base (sin cambios)', async () => {
    contexto({ role: 'receptionist', canCreateProperties: false })
    expect(await uploadPropertyVideoAction(PROP_A, formulario())).toEqual({ success: false, error: 'No tenés permiso para subir videos.' })
    expect(db.queries).toHaveLength(0)
    sinEfectos()
  })
})

describe('uploadPropertyVideoAction — operator en setup', () => {
  // requireTenantContext devuelve el tenant impersonado como tenantId: la
  // semántica es la del owner de ESE tenant, y nunca puede mezclar tenants.
  beforeEach(() => contexto({ tenantId: TENANT_B, accessMode: 'setup_operator' }))

  it('propiedad del tenant impersonado → permitido', async () => {
    const r = await uploadPropertyVideoAction(PROP_B, formulario())
    expect(r.success).toBe(true)
    expect(db.rows('property_videos')).toEqual([expect.objectContaining({ tenant_id: TENANT_B, property_id: PROP_B })])
  })

  it('propiedad de otro tenant → rechazo, sin efectos', async () => {
    expect(await uploadPropertyVideoAction(PROP_A, formulario())).toMatchObject({ success: false })
    sinEfectos()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSupabase } from '@/testing/fake-supabase'

vi.mock('@orderflow/supabase/admin', () => ({ createAdminClient: vi.fn() }))

import { createAdminClient } from '@orderflow/supabase/admin'
import { getPublicPropertyBySlug, getPublicTenant, listPublicProperties } from './public-site.repository'

// ── getPublicTenant: comportamiento CONGELADO ────────────────────────────────
//
// Property Videos Fase 1 extrajo la regla de visibilidad del tenant a
// lib/site/public-visibility.ts para que la ruta de videos use exactamente la
// misma. Estos tests se escribieron ANTES del refactor, contra el código
// anterior, y fijan lo que getPublicTenant devuelve: un refactor no puede
// ampliar ni reducir la visibilidad.

const SELECTED_COLUMNS = [
  'id', 'name', 'logo_url', 'public_logo_url', 'primary_color', 'public_slug', 'public_site_enabled',
  'public_name', 'public_description', 'public_cover_image_url', 'public_primary_color',
  'public_secondary_color', 'public_phone', 'public_email', 'public_instagram_url', 'public_website_url',
  'status', 'vertical', 'client_type', 'delivery_enabled', 'takeaway_enabled', 'table_reservations_enabled',
]

function tenantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tenant-a', name: 'Inmobiliaria A', logo_url: null, public_logo_url: null, primary_color: null,
    public_slug: 'inmo-a', public_site_enabled: true, public_name: 'A', public_description: null,
    public_cover_image_url: null, public_primary_color: null, public_secondary_color: null,
    public_phone: null, public_email: null, public_instagram_url: null, public_website_url: null,
    status: 'active', vertical: 'real_estate', client_type: null,
    delivery_enabled: false, takeaway_enabled: false, table_reservations_enabled: false,
    // columnas que la consulta NO selecciona: no tienen que aparecer en el resultado
    deleted_at: null, onboarding_status: 'delivered', plan_tier: 'pro',
    ...overrides,
  }
}

let db: FakeSupabase

function useDb(tables: ConstructorParameters<typeof FakeSupabase>[0]) {
  db = new FakeSupabase(tables)
  vi.mocked(createAdminClient).mockReturnValue(db as never)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getPublicTenant — comportamiento congelado', () => {
  it.each(['active', 'trial'])('status %s con sitio habilitado → visible', async (status) => {
    useDb({ tenants: [tenantRow({ status })] })
    const t = await getPublicTenant('inmo-a')
    expect(t).not.toBeNull()
    expect((t as unknown as Record<string, unknown>).status).toBe(status)
  })

  it('devuelve exactamente las columnas seleccionadas (ni una más)', async () => {
    useDb({ tenants: [tenantRow()] })
    const t = await getPublicTenant('inmo-a')
    expect(Object.keys(t ?? {}).sort()).toEqual([...SELECTED_COLUMNS].sort())
  })

  it.each(['suspended', 'churned'])('status %s → null', async (status) => {
    useDb({ tenants: [tenantRow({ status })] })
    expect(await getPublicTenant('inmo-a')).toBeNull()
  })

  it('tenant borrado (deleted_at) → null aunque esté activo y habilitado', async () => {
    useDb({ tenants: [tenantRow({ deleted_at: '2026-09-01T00:00:00Z' })] })
    expect(await getPublicTenant('inmo-a')).toBeNull()
  })

  it.each([false, null])('public_site_enabled = %s → null', async (enabled) => {
    useDb({ tenants: [tenantRow({ public_site_enabled: enabled })] })
    expect(await getPublicTenant('inmo-a')).toBeNull()
  })

  it('slug inexistente → null', async () => {
    useDb({ tenants: [tenantRow()] })
    expect(await getPublicTenant('otro')).toBeNull()
  })

  it('error de la consulta → null', async () => {
    useDb({ tenants: [tenantRow()] })
    db.failOn('tenants')
    expect(await getPublicTenant('inmo-a')).toBeNull()
  })

  it('busca por public_slug y filtra deleted_at en la consulta', async () => {
    useDb({ tenants: [tenantRow()] })
    await getPublicTenant('inmo-a')
    expect(db.queriesOn('tenants')[0]?.filters).toEqual(['public_slug=inmo-a', 'deleted_at is null'])
  })
})

// ── Videos en consultas públicas: aislamiento por tenant ─────────────────────
//
// Un video del tenant A colgado de una propiedad del tenant B (la inyección
// que permitía uploadPropertyVideoAction antes de Property Videos Fase 1) no
// puede aparecer en el sitio de B: ni en la ficha ni en el contador del
// catálogo. Las consultas filtran property_videos por tenant_id, no sólo por
// property_id.

const PROP_B = {
  id: 'prop-b1', tenant_id: 'tenant-b', title: 'Casa B', slug: 'casa-b', published: true, deleted_at: null,
  cover_image_url: null, custom_fields: [], show_price_public: false, created_at: '2026-09-01T00:00:00Z',
}

function videoRow(id: string, tenantId: string, sortOrder: number): Record<string, unknown> {
  return {
    id, tenant_id: tenantId, property_id: 'prop-b1', storage_path: `${tenantId}/${id}.mp4`,
    title: null, mime_type: 'video/mp4', duration_seconds: 30, sort_order: sortOrder,
  }
}

describe('consultas públicas de videos — aislamiento por tenant', () => {
  beforeEach(() => {
    useDb({
      properties:      [PROP_B],
      property_images: [],
      property_videos: [videoRow('video-legit', 'tenant-b', 0), videoRow('video-inyectado', 'tenant-a', 1)],
    })
  })

  it('getPublicPropertyBySlug: la ficha sólo trae videos del tenant de la propiedad', async () => {
    const p = await getPublicPropertyBySlug('tenant-b', 'casa-b')
    expect(p?.videos.map((v) => v.id)).toEqual(['video-legit'])
    expect(p?.video_count).toBe(1)
  })

  it('listPublicProperties: el contador del catálogo no cuenta el video ajeno', async () => {
    const [p] = await listPublicProperties('tenant-b')
    expect(p?.video_count).toBe(1)
  })

  it('las dos consultas filtran property_videos por tenant_id explícitamente', async () => {
    await getPublicPropertyBySlug('tenant-b', 'casa-b')
    await listPublicProperties('tenant-b')
    const consultas = db.queriesOn('property_videos')
    expect(consultas).toHaveLength(2)
    for (const q of consultas) expect(q.filters).toContain('tenant_id=tenant-b')
  })

  it('la ficha no expone storage_path ni tenant_id de los videos', async () => {
    const p = await getPublicPropertyBySlug('tenant-b', 'casa-b')
    expect(Object.keys(p?.videos[0] ?? {}).sort()).toEqual(['duration_seconds', 'id', 'mime_type', 'sort_order', 'title'])
  })
})

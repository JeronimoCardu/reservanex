import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSupabase } from '@/testing/fake-supabase'

// MVP P0-B — subida de videos NUEVOS apagada (VIDEO_UPLOADS_ENABLED = false,
// el valor REAL de limits.ts: acá no se mockea). La Server Action rechaza
// antes de cualquier efecto; listar, reordenar, borrar y servir los videos
// existentes sigue igual. El flujo legacy completo (con el flag prendido) se
// sigue probando en property-videos.test.ts.

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/require-tenant-context', () => ({ requireTenantContext: vi.fn() }))
vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))

import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createClient } from '@orderflow/supabase/server'
import {
  deletePropertyVideoAction,
  getPropertyVideosAction,
  reorderPropertyVideosAction,
  uploadPropertyVideoAction,
} from './properties'
import { VIDEO_LIMIT_MESSAGES, VIDEO_UPLOADS_ENABLED } from '@/lib/property-videos/limits'

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const PROP_A   = 'aaaaaaaa-1111-4000-8000-00000000000a'
const VIDEO_1  = 'aaaaaaaa-3333-4000-8000-000000000001'
const VIDEO_2  = 'aaaaaaaa-3333-4000-8000-000000000002'

let db: FakeSupabase

function formulario(): FormData {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array([0, 0, 0, 24])], 'casa.mp4', { type: 'video/mp4' }))
  fd.append('duration_seconds', '30')
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireTenantContext).mockResolvedValue({
    userId: 'user-1', tenantId: TENANT_A, role: 'owner', canCreateProperties: true,
    workspaceIds: null, accessMode: 'tenant_user',
  } as never)
  db = new FakeSupabase({
    properties: [{ id: PROP_A, tenant_id: TENANT_A, deleted_at: null }],
    property_videos: [
      { id: VIDEO_1, tenant_id: TENANT_A, property_id: PROP_A, storage_path: `${TENANT_A}/v1.mp4`, sort_order: 0 },
      { id: VIDEO_2, tenant_id: TENANT_A, property_id: PROP_A, storage_path: `${TENANT_A}/v2.mp4`, sort_order: 1 },
    ],
  })
  vi.mocked(createClient).mockResolvedValue(db as never)
})

describe('subida de videos nuevos: apagada para el MVP', () => {
  it('la fuente única dice que está apagada', () => {
    expect(VIDEO_UPLOADS_ENABLED).toBe(false)
  })

  it('uploadPropertyVideoAction rechaza con un mensaje legible, antes de tocar la base o Storage', async () => {
    const before = db.rows('property_videos').length
    expect(await uploadPropertyVideoAction(PROP_A, formulario())).toEqual({ success: false, error: VIDEO_LIMIT_MESSAGES.uploadsDisabled })
    expect(createClient).not.toHaveBeenCalled()
    expect(db.storage.callsOf('upload')).toHaveLength(0)
    expect(db.rows('property_videos')).toHaveLength(before)
  })

  it('rechaza igual para cualquier rol (no depende de que la UI esconda el botón)', async () => {
    vi.mocked(requireTenantContext).mockResolvedValue({
      userId: 'op-1', tenantId: TENANT_A, role: 'owner', canCreateProperties: true,
      workspaceIds: null, accessMode: 'setup_operator',
    } as never)
    expect(await uploadPropertyVideoAction(PROP_A, formulario())).toMatchObject({ success: false, error: VIDEO_LIMIT_MESSAGES.uploadsDisabled })
    expect(db.storage.callsOf('upload')).toHaveLength(0)
  })

  it('el mensaje no filtra detalles técnicos', () => {
    expect(VIDEO_LIMIT_MESSAGES.uploadsDisabled).not.toMatch(/flag|ENABLED|TUS|Storage|Server Action|MB/i)
  })
})

describe('los videos existentes siguen intactos', () => {
  it('se siguen listando', async () => {
    const r = await getPropertyVideosAction(PROP_A)
    expect(r.success).toBe(true)
    expect(r.success && r.data?.map((v) => v.id)).toEqual([VIDEO_1, VIDEO_2])
  })

  it('se siguen borrando (fila + objeto en Storage)', async () => {
    expect(await deletePropertyVideoAction(VIDEO_1)).toMatchObject({ success: true })
    expect(db.rows('property_videos').map((v) => v.id)).toEqual([VIDEO_2])
    expect(db.storage.callsOf('remove')).toHaveLength(1)
  })

  it('se siguen reordenando', async () => {
    expect(await reorderPropertyVideosAction(PROP_A, [VIDEO_2, VIDEO_1])).toMatchObject({ success: true })
    const order = Object.fromEntries(db.rows('property_videos').map((v) => [v.id, v.sort_order]))
    expect(order).toEqual({ [VIDEO_2]: 0, [VIDEO_1]: 1 })
  })
})

describe('superficies (estructural)', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('la UI sólo ofrece subir (input + botón) y promete límites si el flag está prendido', () => {
    const ui = src('components/tenant/properties/property-video-manager.tsx')
    expect(ui).toMatch(/const canUpload = VIDEO_UPLOADS_ENABLED && /)
    expect(ui).toMatch(/\{canUpload && \(\s*<>\s*<input/)
    expect(ui).toMatch(/\{VIDEO_UPLOADS_ENABLED\s*\?\s*<>Sin videos\. MP4/)
    expect(ui).toMatch(/: 'Sin videos\.'/)
    expect(ui).toMatch(/\{VIDEO_UPLOADS_ENABLED && !canUpload && !isUploading && videos\.length >= MAX_PROPERTY_VIDEOS/)
  })

  it('reordenar y borrar en la UI NO dependen del flag', () => {
    const ui = src('components/tenant/properties/property-video-manager.tsx')
    expect(ui).toContain('await reorderPropertyVideosAction(propertyId')
    expect(ui).toContain('await deletePropertyVideoAction(videoId)')
    expect(ui.match(/VIDEO_UPLOADS_ENABLED/g)).toHaveLength(4) // import + canUpload + texto vacío + "Máximo N"
  })

  it('el formulario de la propiedad no promete videos con la subida apagada', () => {
    const form = src('components/tenant/properties/property-form.tsx')
    expect(form).toMatch(/VIDEO_UPLOADS_ENABLED\s*\?\s*'Agregá fotos y hasta 2 videos cortos de la propiedad\.'\s*:\s*'Agregá fotos de la propiedad\.'/)
  })

  it('la ruta de delivery /api/property-videos no conoce el flag (sirve igual los existentes)', () => {
    expect(src('app/api/property-videos/[videoId]/route.ts')).not.toMatch(/VIDEO_UPLOADS_ENABLED|uploadsDisabled/)
  })
})

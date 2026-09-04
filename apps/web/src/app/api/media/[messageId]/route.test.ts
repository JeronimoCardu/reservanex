import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@orderflow/supabase/admin', () => ({ createAdminClient: vi.fn() }))

import { createClient } from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { GET } from './route'

const TENANT_A = 'tenant-aaaa'
const TENANT_B = 'tenant-bbbb'

function fakeAccessToken(appMetadata: Record<string, unknown>): string {
  const payload = { app_metadata: appMetadata }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${b64}.signature`
}

function mockAuthedClient(tenantId: string) {
  const accessToken = fakeAccessToken({ user_type: 'tenant_user', role: 'owner', tenant_id: tenantId, workspace_ids: null })
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: accessToken } } }),
    },
  } as never)
}

function mockAdminClient(opts: {
  message: Record<string, unknown> | null
  fileBytes?: Uint8Array
  downloadError?: { message: string } | null
}) {
  const fileBytes = opts.fileBytes ?? new Uint8Array()
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: opts.message }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        download: () =>
          Promise.resolve(
            opts.downloadError
              ? { data: null, error: opts.downloadError }
              : { data: new Blob([Buffer.from(fileBytes)]), error: null },
          ),
      }),
    },
  } as never)
}

function buildRequest(messageId: string, opts: { download?: boolean; range?: string } = {}) {
  const url = new URL(`http://127.0.0.1/api/media/${messageId}`)
  if (opts.download) url.searchParams.set('download', '1')
  const headers = new Headers()
  if (opts.range) headers.set('range', opts.range)
  return new NextRequest(url, { headers })
}

// A minimal, real, valid single-page PDF — starts with the %PDF- signature,
// exactly what a genuine AutoResponder-uploaded document would look like.
const REAL_PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<< >>\nendobj\n%%EOF')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/api/media/[messageId] — AutoResponder document parity (Fase 6B.4)', () => {
  it('1. resolves an AutoResponder document: filename comes from metadata.filename, never the storage path', async () => {
    mockAuthedClient(TENANT_A)
    mockAdminClient({
      message: {
        id: 'msg-1', tenant_id: TENANT_A, content_type: 'document',
        media_storage_path: `${TENANT_A}/conv-1/msg-1.pdf`,
        metadata: { filename: 'Contrato alquiler.pdf', mime_type: 'application/pdf', original_type: 'document', storage_bucket: 'whatsapp-media' },
      },
      fileBytes: REAL_PDF_BYTES,
    })

    const res = await GET(buildRequest('msg-1', { download: true }), { params: Promise.resolve({ messageId: 'msg-1' }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    // The storage OBJECT key (msg-1.pdf) must never appear as the display
    // filename — only the original, human-readable name from metadata.
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('Contrato alquiler.pdf')
    expect(disposition).not.toContain('msg-1.pdf')
    expect(disposition).toContain('attachment')

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-')
  })

  it('2. the storage object name never leaks as the display filename even without a human-readable one (falls back to "file")', async () => {
    mockAuthedClient(TENANT_A)
    mockAdminClient({
      message: {
        id: 'msg-2', tenant_id: TENANT_A, content_type: 'document',
        media_storage_path: `${TENANT_A}/conv-1/msg-2.pdf`,
        metadata: { original_type: 'document', storage_bucket: 'whatsapp-media' }, // no filename key at all
      },
      fileBytes: REAL_PDF_BYTES,
    })

    const res = await GET(buildRequest('msg-2', { download: true }), { params: Promise.resolve({ messageId: 'msg-2' }) })

    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).not.toContain('msg-2.pdf')
    expect(disposition).toContain('"file"')
  })

  it('3. resolves a document via the real route handler end to end (status, headers, bytes)', async () => {
    mockAuthedClient(TENANT_A)
    mockAdminClient({
      message: {
        id: 'msg-3', tenant_id: TENANT_A, content_type: 'document',
        media_storage_path: `${TENANT_A}/conv-1/msg-3.pdf`,
        metadata: { filename: 'Presupuesto.pdf', mime_type: 'application/pdf' },
      },
      fileBytes: REAL_PDF_BYTES,
    })

    const res = await GET(buildRequest('msg-3'), { params: Promise.resolve({ messageId: 'msg-3' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(REAL_PDF_BYTES.byteLength))
  })

  it('4. a document belonging to a different tenant is rejected (403), regardless of provider', async () => {
    mockAuthedClient(TENANT_A)
    mockAdminClient({
      message: {
        id: 'msg-4', tenant_id: TENANT_B, content_type: 'document',
        media_storage_path: `${TENANT_B}/conv-9/msg-4.pdf`,
        metadata: { filename: 'ajeno.pdf', mime_type: 'application/pdf' },
      },
    })

    const res = await GET(buildRequest('msg-4'), { params: Promise.resolve({ messageId: 'msg-4' }) })
    expect(res.status).toBe(403)
  })

  it('5. a document with no storage_path yet (upload never landed) fails in a controlled way (404), not a crash', async () => {
    mockAuthedClient(TENANT_A)
    mockAdminClient({
      message: {
        id: 'msg-5', tenant_id: TENANT_A, content_type: 'document',
        media_storage_path: null,
        metadata: { filename: '73R90BVOFH4MO6C41GG5DX5J51Q3S4_134176480553922594.pdf', original_type: 'document' },
      },
    })

    const res = await GET(buildRequest('msg-5'), { params: Promise.resolve({ messageId: 'msg-5' }) })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('No media available yet')
  })

  it('6. a Meta document (full metadata shape, provider not stored on the message) resolves exactly the same way — provider-agnostic', async () => {
    mockAuthedClient(TENANT_A)
    mockAdminClient({
      message: {
        id: 'msg-6', tenant_id: TENANT_A, content_type: 'document',
        media_storage_path: `${TENANT_A}/conv-1/msg-6.pdf`,
        metadata: {
          whatsapp_media_id: 'wamid-media-123', mime_type: 'application/pdf', filename: 'Reglamento.pdf',
          sha256: 'abc123', caption: null, original_type: 'document', storage_bucket: 'whatsapp-media',
        },
      },
      fileBytes: REAL_PDF_BYTES,
    })

    const res = await GET(buildRequest('msg-6', { download: true }), { params: Promise.resolve({ messageId: 'msg-6' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('Reglamento.pdf')
  })

  it('missing message → 404', async () => {
    mockAuthedClient(TENANT_A)
    mockAdminClient({ message: null })
    const res = await GET(buildRequest('msg-missing'), { params: Promise.resolve({ messageId: 'msg-missing' }) })
    expect(res.status).toBe(404)
  })

  it('Fase 10: a filename containing a double-quote or backslash never corrupts the Content-Disposition header syntax', async () => {
    mockAuthedClient(TENANT_A)
    mockAdminClient({
      message: {
        id: 'msg-7', tenant_id: TENANT_A, content_type: 'document',
        media_storage_path: `${TENANT_A}/conv-1/msg-7.pdf`,
        metadata: { filename: 'weird"name\\.pdf', mime_type: 'application/pdf' },
      },
      fileBytes: REAL_PDF_BYTES,
    })

    const res = await GET(buildRequest('msg-7', { download: true }), { params: Promise.resolve({ messageId: 'msg-7' }) })
    const disposition = res.headers.get('content-disposition') ?? ''
    // The quote/backslash inside the raw filename must be stripped — the
    // header's own wrapping quotes (exactly 2) are the only ones present.
    expect(disposition).toBe('attachment; filename="weirdname.pdf"')
    expect((disposition.match(/"/g) ?? []).length).toBe(2)
  })
})

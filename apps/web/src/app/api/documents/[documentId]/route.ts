import { type NextRequest, NextResponse } from 'next/server'
import { createClient }      from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { parseAccessTokenClaims } from '@/lib/claims'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── Content-Disposition helpers ─────────────────────────────────────────────
//
// HTTP headers must be ByteString (Latin-1) safe. Document names can contain
// Unicode (em-dash "—", accents, ñ, etc.) which blows up with:
//   TypeError: Cannot convert argument to a ByteString because the character
//   at index N has a value of NNNN which is greater than 255.
//
// RFC 5987 solution: keep filename="" ASCII-safe for legacy clients, and
// carry the full Unicode name in filename*=UTF-8''<percent-encoded>.

function sanitizeAsciiFilename(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '') // strip non-ASCII after decomposition
    .replace(/[\\"]/g, '')         // strip backslash and double-quote
    .replace(/\s+/g, ' ')
    .trim() || 'document.pdf'
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, '%2A')
}

function buildContentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii   = sanitizeAsciiFilename(name)
  const encoded = encodeRFC5987(name)
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ─── Route ───────────────────────────────────────────────────────────────────

// GET /api/documents/{documentId}?download=1
//
// Validates tenant session, verifies document ownership, proxies bytes
// from the private Supabase Storage bucket.
// Never exposes the Supabase storage URL, bucket path, or service role key.
// Cross-tenant access returns 403.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params

  // 1. Validate session
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: { session } } = await supabase.auth.getSession()
  const claims = parseAccessTokenClaims(session?.access_token)
  if (!claims || claims.user_type !== 'tenant_user') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tenantId = claims.tenant_id

  // 2. Fetch document — admin bypasses RLS; cross-tenant check is manual below
  const admin = createAdminClient()
  const { data: doc } = await admin
    .from('documents')
    .select('id, tenant_id, storage_bucket, storage_path, mime_type, name')
    .eq('id', documentId)
    .maybeSingle()

  if (!doc) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // 3. Cross-tenant guard
  if (doc.tenant_id !== tenantId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 4. Verify storage info
  if (!doc.storage_bucket || !doc.storage_path) {
    return NextResponse.json({ error: 'No file available' }, { status: 404 })
  }

  // 5. Download from private bucket — URL never leaves the server
  const { data: fileBlob, error: downloadError } = await admin.storage
    .from(doc.storage_bucket)
    .download(doc.storage_path)

  if (downloadError || !fileBlob) {
    console.error('[documents-api] download error:', downloadError?.message, { documentId })
    return NextResponse.json({ error: 'File not found in storage' }, { status: 404 })
  }

  const arrayBuffer = await fileBlob.arrayBuffer()
  const totalSize   = arrayBuffer.byteLength

  // Ensure MIME type is ASCII-safe
  const mimeType  = (doc.mime_type ?? 'application/octet-stream').replace(/[^\x20-\x7E]/g, '')
  const filename  = doc.name ?? 'document.pdf'
  const dispType  = req.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline'

  return new Response(arrayBuffer, {
    status:  200,
    headers: {
      'Content-Type':        mimeType,
      'Content-Length':      String(totalSize),
      'Content-Disposition': buildContentDisposition(dispType, filename),
      'Cache-Control':       'private, max-age=300',
    },
  })
}

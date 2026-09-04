import { type NextRequest, NextResponse } from 'next/server'
import { createClient }      from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { parseAccessTokenClaims } from '@/lib/claims'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Parses the Range header value into {start, end}.
// Returns null  when no Range header is present (caller responds 200).
// Returns false when the Range header is present but invalid (caller responds 416).
function parseByteRange(
  rangeHeader: string | null,
  totalSize:   number,
): { start: number; end: number } | false | null {
  if (!rangeHeader) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader)
  if (!match) return false
  const start = parseInt(match[1]!, 10)
  const end   = match[2] !== '' ? parseInt(match[2]!, 10) : totalSize - 1
  if (start > end || end >= totalSize || start < 0) return false
  return { start, end }
}

// GET /api/media/{messageId}?download=1
//
// Validates tenant session, verifies message ownership, proxies media bytes
// from the private whatsapp-media bucket.
//
// Supports Range requests so browsers can compute audio duration and seek.
// Never exposes the Supabase storage URL, storage path, or service role key.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params

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

  // 2. Fetch message — include content_type and metadata for MIME/filename resolution
  const admin = createAdminClient()
  const { data: message } = await admin
    .from('messages')
    .select('id, tenant_id, media_storage_path, content_type, metadata')
    .eq('id', messageId)
    .maybeSingle()

  if (!message) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // 3. Cross-tenant guard — message must belong to the caller's tenant
  if (message.tenant_id !== tenantId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 4. Verify media path exists
  if (!message.media_storage_path) {
    return NextResponse.json({ error: 'No media available yet' }, { status: 404 })
  }

  // 5. Download bytes from private bucket — URL never leaves the server
  const { data: fileBlob, error: downloadError } = await admin.storage
    .from('whatsapp-media')
    .download(message.media_storage_path)

  if (downloadError || !fileBlob) {
    console.error('[media-api] download error:', downloadError?.message, { messageId })
    return NextResponse.json({ error: 'Media not found' }, { status: 404 })
  }

  const arrayBuffer = await fileBlob.arrayBuffer()
  const totalSize   = arrayBuffer.byteLength

  // 6. Resolve MIME type and filename from stored metadata
  const meta     = message.metadata as Record<string, unknown> | null
  const mimeType = typeof meta?.['mime_type'] === 'string' ? meta['mime_type'] : 'application/octet-stream'
  const rawFilename = typeof meta?.['filename'] === 'string' ? meta['filename'] : 'file'
  // Fase 10 security audit — sanitizeUploadFilename() (applied when this
  // filename was first stored) already strips control characters and path
  // separators, but never stripped a bare double-quote/backslash. Those
  // can't achieve header injection here (CRLF is already blocked upstream),
  // but an unescaped quote does corrupt the Content-Disposition syntax —
  // strip them here too, same defensive approach already used in
  // /api/documents/[documentId]/route.ts's sanitizeAsciiFilename().
  const filename = rawFilename.replace(/[\\"]/g, '')

  // 7. Content-Disposition: inline for images/audio; attachment when ?download=1 for docs
  const isDownload  = req.nextUrl.searchParams.get('download') === '1'
  const isImage     = (message.content_type as string) === 'image'
  const disposition = (!isImage && isDownload)
    ? `attachment; filename="${filename}"`
    : `inline; filename="${filename}"`

  const sharedHeaders: Record<string, string> = {
    'Content-Type':        mimeType,
    'Accept-Ranges':       'bytes',
    'Cache-Control':       'private, max-age=300',
    'Content-Disposition': disposition,
  }

  // 8. Range support — required for audio duration calculation and seek
  const range = parseByteRange(req.headers.get('range'), totalSize)

  if (range === false) {
    // Range header present but unsatisfiable
    return new Response(null, {
      status:  416,
      headers: { 'Content-Range': `bytes */${totalSize}` },
    })
  }

  if (range !== null) {
    // Partial content (206)
    const { start, end }  = range
    const chunkBuffer     = arrayBuffer.slice(start, end + 1)
    const chunkSize       = end - start + 1
    return new Response(chunkBuffer, {
      status:  206,
      headers: {
        ...sharedHeaders,
        'Content-Length': String(chunkSize),
        'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
      },
    })
  }

  // Full response (200)
  return new Response(arrayBuffer, {
    status:  200,
    headers: {
      ...sharedHeaders,
      'Content-Length': String(totalSize),
    },
  })
}

import { type NextRequest, NextResponse } from 'next/server'
import { createClient }      from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { parseAccessTokenClaims } from '@/lib/claims'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Parses the Range header value into {start, end}.
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

// GET /api/property-videos/{videoId}
//
// Serves a video from the private property-videos bucket.
// Authorization:
//   - Authenticated tenant user whose tenant_id matches the video → always served
//     (allows dashboard preview of unpublished properties).
//   - Unauthenticated (or wrong tenant) → property must be published AND
//     tenant must have public_site_enabled = true.
//
// Never exposes the bucket path or a signed URL.
// Supports Range requests for browser seek and duration detection.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  const { videoId } = await params
  const admin = createAdminClient()

  // 1. Fetch video row (admin bypasses RLS — access validated below)
  const { data: video } = await admin
    .from('property_videos')
    .select('id, tenant_id, property_id, storage_path, mime_type')
    .eq('id', videoId)
    .maybeSingle()

  if (!video) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // 2. Determine authorization
  let authorized = false

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user) {
    const { data: { session } } = await supabase.auth.getSession()
    const claims = parseAccessTokenClaims(session?.access_token)
    if (claims?.user_type === 'tenant_user' && claims.tenant_id === video.tenant_id) {
      authorized = true
    } else if (claims?.user_type === 'platform_user' && claims.role === 'operator') {
      // Operator in setup mode — check active impersonation session targeting this tenant
      const { data: imp } = await admin
        .from('impersonation_sessions')
        .select('target_tenant_id')
        .eq('platform_user_id', user.id)
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (imp && imp.target_tenant_id === video.tenant_id) {
        authorized = true
      }
    }
  }

  if (!authorized) {
    // Unauthenticated (or different-tenant) visitor: require property published + site enabled
    const { data: property } = await admin
      .from('properties')
      .select('published, deleted_at, tenant_id')
      .eq('id', video.property_id)
      .maybeSingle()

    if (
      !property ||
      property.tenant_id !== video.tenant_id ||
      !property.published ||
      property.deleted_at != null
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data: tenant } = await admin
      .from('tenants')
      .select('public_site_enabled')
      .eq('id', video.tenant_id)
      .maybeSingle()

    if (!tenant?.public_site_enabled) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    authorized = true
  }

  if (!authorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 3. Download from private bucket
  const { data: fileBlob, error: downloadError } = await admin.storage
    .from('property-videos')
    .download(video.storage_path)

  if (downloadError || !fileBlob) {
    console.error('[property-videos-api] download error:', downloadError?.message, { videoId })
    return NextResponse.json({ error: 'Video not found' }, { status: 404 })
  }

  const arrayBuffer = await fileBlob.arrayBuffer()
  const totalSize   = arrayBuffer.byteLength
  const mimeType    = video.mime_type || 'video/mp4'

  const sharedHeaders: Record<string, string> = {
    'Content-Type':  mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  }

  // 4. Range support
  const range = parseByteRange(req.headers.get('range'), totalSize)

  if (range === false) {
    return new Response(null, {
      status:  416,
      headers: { 'Content-Range': `bytes */${totalSize}` },
    })
  }

  if (range !== null) {
    const { start, end } = range
    const chunkBuffer    = arrayBuffer.slice(start, end + 1)
    const chunkSize      = end - start + 1
    return new Response(chunkBuffer, {
      status:  206,
      headers: {
        ...sharedHeaders,
        'Content-Length': String(chunkSize),
        'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
      },
    })
  }

  return new Response(arrayBuffer, {
    status:  200,
    headers: {
      ...sharedHeaders,
      'Content-Length': String(totalSize),
    },
  })
}

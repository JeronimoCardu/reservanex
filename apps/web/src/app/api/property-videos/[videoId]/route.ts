import { type NextRequest, NextResponse } from 'next/server'
import { createClient }      from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { parseAccessTokenClaims } from '@/lib/claims'
import { isPropertyPubliclyVisible, isTenantPubliclyVisible } from '@/lib/site/public-visibility'
import {
  isStorageObjectMissing,
  isUuid,
  PROPERTY_VIDEO_SIGNED_URL_TTL_SECONDS,
  PROPERTY_VIDEOS_BUCKET,
} from '@/lib/property-videos/delivery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/property-videos/{videoId}
//
// Property Videos Fase 1 — esta ruta AUTORIZA y REDIRIGE; no transporta bytes.
// Responde 307 a una signed URL privada de Storage y el browser repite ahí su
// request (con el mismo Range), así que Storage sirve el 206 directamente. Ver
// lib/property-videos/delivery.ts para el TTL y la semántica de caché y
// revocación. La URL de esta ruta es la estable: es la que usan los <video>.
//
// Quién puede ver:
//   · vista previa: usuario del mismo tenant, u operator con una impersonación
//     activa sobre ese tenant — aunque la propiedad no esté publicada (misma
//     semántica que antes de la Fase 1);
//   · cualquier otro (anónimo o de otro tenant): sólo si la propiedad está
//     publicada y no borrada, y el tenant es visible con la MISMA regla que el
//     sitio público (isTenantPubliclyVisible, compartida con getPublicTenant).
// En los dos casos el video tiene que ser del mismo tenant que su propiedad.
//
// Todo lo que no se puede ver es 404, igual por cualquier motivo: la
// existencia de un video no es un oráculo. 503 sólo ante un error operativo
// de la base o de Storage, sin detalle.

const NO_STORE = 'private, no-store'

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': NO_STORE } })
}

function unavailable(): NextResponse {
  return NextResponse.json({ error: 'Unavailable' }, { status: 503, headers: { 'Cache-Control': NO_STORE } })
}

type AdminClient = ReturnType<typeof createAdminClient>

// Vista previa del dashboard. Sin cambios de semántica respecto de la ruta
// anterior: tenant_user del mismo tenant, u operator cuya impersonación activa
// más reciente apunta a ese tenant.
async function canPreview(admin: AdminClient, videoTenantId: string): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  const { data: { session } } = await supabase.auth.getSession()
  const claims = parseAccessTokenClaims(session?.access_token)

  if (claims?.user_type === 'tenant_user') return claims.tenant_id === videoTenantId

  if (claims?.user_type === 'platform_user' && claims.role === 'operator') {
    const { data: imp } = await admin
      .from('impersonation_sessions')
      .select('target_tenant_id')
      .eq('platform_user_id', user.id)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return imp?.target_tenant_id === videoTenantId
  }

  return false
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  const { videoId } = await params

  // 1. Un id que ni siquiera es un UUID no llega a la base.
  if (!isUuid(videoId)) return notFound()

  const admin = createAdminClient()

  // 2. El video.
  const { data: video, error: videoError } = await admin
    .from('property_videos')
    .select('id, tenant_id, property_id, storage_path')
    .eq('id', videoId)
    .maybeSingle()

  if (videoError) {
    console.error('[property-videos] video lookup failed', { videoId, code: videoError.code })
    return unavailable()
  }
  if (!video) return notFound()

  // 3. Su propiedad. Se lee SIEMPRE, también para la vista previa: un video
  //    cuya propiedad es de otro tenant no se sirve a nadie (es la fila que
  //    podía crear uploadPropertyVideoAction antes de la Fase 1).
  const { data: property, error: propertyError } = await admin
    .from('properties')
    .select('tenant_id, published, deleted_at')
    .eq('id', video.property_id)
    .maybeSingle()

  if (propertyError) {
    console.error('[property-videos] property lookup failed', { videoId, code: propertyError.code })
    return unavailable()
  }
  if (!property || property.tenant_id !== video.tenant_id) return notFound()

  // 4. Vista previa autorizada, o las reglas del sitio público.
  if (!(await canPreview(admin, video.tenant_id))) {
    if (!isPropertyPubliclyVisible(property, video.tenant_id)) return notFound()

    const { data: tenant, error: tenantError } = await admin
      .from('tenants')
      .select('status, public_site_enabled, deleted_at')
      .eq('id', video.tenant_id)
      .maybeSingle()

    if (tenantError) {
      console.error('[property-videos] tenant lookup failed', { videoId, code: tenantError.code })
      return unavailable()
    }
    if (!tenant || !isTenantPubliclyVisible(tenant)) return notFound()
  }

  // 5. Firma de vida corta sobre el objeto privado. Nada de esto se loguea:
  //    ni la URL, ni el token, ni el storage_path.
  const { data: signed, error: signError } = await admin.storage
    .from(PROPERTY_VIDEOS_BUCKET)
    .createSignedUrl(video.storage_path, PROPERTY_VIDEO_SIGNED_URL_TTL_SECONDS)

  if (signError || !signed?.signedUrl) {
    const missing = isStorageObjectMissing(signError)
    console.error('[property-videos] signed url failed', { videoId, objectMissing: missing })
    return missing ? notFound() : unavailable()
  }

  // 6. 307 sin cuerpo. El Range del request original, si vino, lo repite el
  //    browser contra Storage: esta ruta no lo lee.
  return new NextResponse(null, {
    status:  307,
    headers: {
      Location:        signed.signedUrl,
      'Cache-Control': NO_STORE,
    },
  })
}

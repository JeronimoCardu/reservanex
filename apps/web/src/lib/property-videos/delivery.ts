// Property Videos Fase 1 — cómo se entrega un video de propiedad.
//
// /api/property-videos/{id} ya NO transporta bytes. Autoriza y responde un 307
// a una signed URL privada de Supabase Storage; el browser repite su request
// (con el mismo Range) contra Storage, que sirve el 206 directamente. Antes la
// ruta descargaba el objeto ENTERO a la memoria de la función en cada request
// —también para un Range de 2 bytes— y recién después recortaba el rango.
//
// CACHE Y REVOCACIÓN — la semántica, explícita:
//
//   · La URL estable de ReservaNex (/api/property-videos/{id}) reevalúa la
//     autorización en CADA request. Su 307 sale con `private, no-store`: no lo
//     guarda el browser ni el CDN de Vercel. Nunca puede ser público — el
//     mismo id puede ser la vista previa autorizada de un video no publicado,
//     y el CDN no distingue por cookie.
//   · La signed URL vale PROPERTY_VIDEO_SIGNED_URL_TTL_SECONDS (15 min). Una
//     URL ya emitida sigue sirviendo durante ese TTL aunque entretanto se
//     despublique la propiedad o se suspenda el tenant: Supabase no permite
//     revocar una firma antes de su vencimiento.
//   · Con Smart CDN (plan Pro o superior) una respuesta ya cacheada en el edge
//     para esa signed URL puede seguir sirviéndose después de vencido el
//     token, hasta que venza el caché del CDN. Borrar el objeto sí invalida
//     ese caché (Supabase indica hasta 60 s).
//   · Por lo tanto, revocar el acceso a una URL YA EMITIDA es eventual, no
//     instantáneo. Lo instantáneo es que la URL estable deja de emitir firmas
//     nuevas en cuanto el video deja de ser visible.
//
// La signed URL nunca se escribe en el HTML, nunca se persiste y nunca se
// loguea (tampoco el token ni el storage_path).

export const PROPERTY_VIDEOS_BUCKET = 'property-videos'

/**
 * 15 min. Cubre una sesión normal con un video de hasta 60 s y pausas (el
 * browser puede seguir pidiendo rangos a la URL ya redirigida). Más largo
 * amplía la ventana de una URL copiada; más corto obliga a recuperar el
 * <video> a mitad de sesión. Revisar con el QA físico.
 */
export const PROPERTY_VIDEO_SIGNED_URL_TTL_SECONDS = 900

// Forma sintáctica de un UUID (cualquier versión). Se valida ANTES de tocar la
// base: un id con otra forma es 404 sin consulta.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

/**
 * Si el error de createSignedUrl dice que el OBJETO no existe (fila de
 * property_videos sin archivo en Storage). Storage responde HTTP 400 con
 * statusCode '404' en ese caso; cualquier otra cosa es un error operativo.
 */
export function isStorageObjectMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown }
  return statusCode === '404' || status === 404
}

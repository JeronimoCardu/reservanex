// Property Videos — límites canónicos. ÚNICA fuente para la UI, la Server
// Action legacy, el futuro prepare/finalize y los tests: nadie redeclara
// estos números ni la lista de MIME.
//
// Hay DOS límites de tamaño, y son conceptos distintos:
//
//   · MAX_VIDEO_SIZE_BYTES (50 MiB) — límite FINAL de producto/Storage. No es
//     una preferencia: es el "Global file size limit" del proyecto Supabase en
//     plan Free. Ningún bucket puede aceptar más que ese global — el bucket
//     property-videos todavía declara 80 MB en su migración histórica
//     (20260813000002), pero ese valor no se alcanza nunca. Lo usan las
//     primitivas nuevas (uploader TUS, inspección, validación). Si el proyecto
//     pasa a Pro y se sube el global, se cambia ACÁ.
//
//   · LEGACY_VIDEO_UPLOAD_MAX_BYTES (4 MiB) — límite TEMPORAL de TRANSPORTE de
//     la subida productiva actual, uploadPropertyVideoAction (Server Action):
//     el archivo viaja en el body de un request a Vercel, que corta en 4,5 MB.
//     Mientras ese sea el flujo productivo, la UI valida y muestra ESTE límite
//     (no 50 MB). SE ELIMINA cuando la subida productiva pase a TUS (Fase
//     2B/2C). Ver docs/production-security-checklist.md §7 y docs/backlog.md
//     (ítem U).

export const MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024
export const MAX_VIDEO_SIZE_LABEL = `${MAX_VIDEO_SIZE_BYTES / (1024 * 1024)} MB`
export const MAX_VIDEO_DURATION_SECONDS = 60
export const MAX_PROPERTY_VIDEOS = 2

/**
 * TEMPORAL — tope del transporte legacy (Server Action en Vercel). 4 MiB =
 * 4 194 304 bytes: ~300 KB por debajo de los 4,5 MB de Vercel, margen para el
 * multipart y el resto del request. Desaparece con la integración de TUS.
 */
export const LEGACY_VIDEO_UPLOAD_MAX_BYTES = 4 * 1024 * 1024
export const LEGACY_VIDEO_UPLOAD_MAX_LABEL = `${LEGACY_VIDEO_UPLOAD_MAX_BYTES / (1024 * 1024)} MB`

/**
 * MIME permitido → extensión con la que se guarda el objeto. La extensión la
 * decide el servidor a partir del MIME validado, nunca a partir del nombre de
 * archivo que manda el browser.
 */
export const VIDEO_EXTENSION_BY_MIME = {
  'video/mp4':       'mp4',
  'video/webm':      'webm',
  'video/quicktime': 'mov',
} as const

export type AllowedVideoMimeType = keyof typeof VIDEO_EXTENSION_BY_MIME
export type VideoFileExtension = (typeof VIDEO_EXTENSION_BY_MIME)[AllowedVideoMimeType]

export const ALLOWED_VIDEO_MIME_TYPES = Object.keys(VIDEO_EXTENSION_BY_MIME) as readonly AllowedVideoMimeType[]

export function isAllowedVideoMimeType(value: unknown): value is AllowedVideoMimeType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VIDEO_EXTENSION_BY_MIME, value)
}

export function videoExtensionForMime(mimeType: AllowedVideoMimeType): VideoFileExtension {
  return VIDEO_EXTENSION_BY_MIME[mimeType]
}

/** `accept` del <input type="file">. `.mov` va aparte: hay browsers que no asocian video/quicktime en el selector. */
export const VIDEO_FILE_INPUT_ACCEPT = [...ALLOWED_VIDEO_MIME_TYPES, '.mov'].join(',')

export const VIDEO_LIMIT_MESSAGES = {
  mimeNotAllowed: 'Solo se admiten videos MP4, WebM o MOV.',
  /** Límite final (flujo TUS / finalize). */
  tooLarge:       `El video no puede superar ${MAX_VIDEO_SIZE_LABEL}.`,
  /** TEMPORAL — subida legacy por Server Action. */
  legacyTooLarge: `Por ahora el video no puede superar ${LEGACY_VIDEO_UPLOAD_MAX_LABEL}.`,
  tooLong:        `El video no puede superar ${MAX_VIDEO_DURATION_SECONDS} segundos.`,
} as const

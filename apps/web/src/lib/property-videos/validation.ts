// Property Videos Fase 2A — validaciones puras.
//
// Dos momentos, con las mismas reglas canónicas (limits.ts):
//   · ANTES de subir (futuro prepare): checkVideoDeclaration — tamaño y MIME
//     declarados; la extensión la decide el servidor a partir del MIME.
//   · DESPUÉS de subir (futuro finalize): verifyStoredVideo — vuelve a chequear
//     el tamaño REAL del objeto e inspecciona sus bytes por rangos: el
//     contenido tiene que coincidir con el MIME y la duración salir del
//     contenedor. Nada de lo que declare el browser es autoridad.
//
// MP4 y MOV comparten la familia ISO-BMFF y el mismo parser: un .mov con brand
// 'isom' o un .mp4 con brand 'qt  ' se aceptan con su MIME declarado (la
// extensión sigue al MIME). Lo que se rechaza es cruzar familias (bytes WebM
// declarados como MP4, o al revés) y el Matroska genérico declarado como WebM.

import { inspectVideo, type VideoContainer, type VideoContainerFamily, type VideoInspection } from './inspect-video'
import {
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_LIMIT_MESSAGES,
  isAllowedVideoMimeType,
  videoExtensionForMime,
  type AllowedVideoMimeType,
  type VideoFileExtension,
} from './limits'
import { INSPECTION_LIMITS, type InspectionLimits, type RangeReader } from './range-reader'

export type VideoRejectionCode =
  | 'invalid_size'
  | 'empty_file'
  | 'file_too_large'
  | 'mime_not_allowed'
  | 'content_mismatch'
  | 'unrecognized_container'
  | 'truncated_container'
  | 'malformed_container'
  | 'invalid_timescale'
  | 'duration_unavailable'
  | 'duration_invalid'
  | 'duration_too_long'
  | 'inspection_budget_exceeded'
  | 'read_failed'

export type VideoRejection = { ok: false; code: VideoRejectionCode }

export type VideoDeclarationCheck =
  | { ok: true; mimeType: AllowedVideoMimeType; extension: VideoFileExtension }
  | VideoRejection

export type VerifiedVideo = {
  ok: true
  mimeType: AllowedVideoMimeType
  extension: VideoFileExtension
  container: VideoContainer
  durationSeconds: number
}

const FAMILY_BY_MIME: Record<AllowedVideoMimeType, VideoContainerFamily> = {
  'video/mp4':       'isobmff',
  'video/quicktime': 'isobmff',
  'video/webm':      'ebml',
}

const CONTAINERS_BY_MIME: Record<AllowedVideoMimeType, readonly VideoContainer[]> = {
  'video/mp4':       ['mp4', 'quicktime'],
  'video/quicktime': ['quicktime', 'mp4'],
  'video/webm':      ['webm'],
}

/** Tamaño + MIME declarados. La extensión sale del MIME validado, nunca del nombre de archivo. */
export function checkVideoDeclaration(input: { sizeBytes: number; mimeType: string }): VideoDeclarationCheck {
  const { sizeBytes, mimeType } = input
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return reject('invalid_size')
  if (sizeBytes === 0) return reject('empty_file')
  if (sizeBytes > MAX_VIDEO_SIZE_BYTES) return reject('file_too_large')
  if (!isAllowedVideoMimeType(mimeType)) return reject('mime_not_allowed')
  return { ok: true, mimeType, extension: videoExtensionForMime(mimeType) }
}

/** Duración finita, > 0 y ≤ MAX_VIDEO_DURATION_SECONDS. */
export function checkVideoDuration(seconds: number): { ok: true; durationSeconds: number } | VideoRejection {
  if (!Number.isFinite(seconds) || seconds <= 0) return reject('duration_invalid')
  if (seconds > MAX_VIDEO_DURATION_SECONDS) return reject('duration_too_long')
  return { ok: true, durationSeconds: seconds }
}

/** El resultado de la inspección contra el MIME validado: misma familia, contenedor admitido y duración válida. */
export function checkInspectionAgainstMime(
  mimeType: AllowedVideoMimeType,
  inspection: VideoInspection,
): { ok: true; container: VideoContainer; durationSeconds: number } | VideoRejection {
  // Primero la familia: unos bytes WebM declarados como MP4 son un
  // content_mismatch aunque además estén rotos.
  if (inspection.family !== null && inspection.family !== FAMILY_BY_MIME[mimeType]) return reject('content_mismatch')
  if (!inspection.ok) return reject(inspection.reason)
  if (!CONTAINERS_BY_MIME[mimeType].includes(inspection.container)) return reject('content_mismatch')

  const duration = checkVideoDuration(inspection.durationSeconds)
  if (!duration.ok) return duration
  return { ok: true, container: inspection.container, durationSeconds: duration.durationSeconds }
}

/**
 * Verificación completa de un objeto ya subido (futuro finalize): tamaño real
 * (reader.size), MIME, contenido y duración — leyendo sólo rangos acotados.
 */
export async function verifyStoredVideo(input: {
  reader: RangeReader
  declaredMimeType: string
  limits?: Readonly<InspectionLimits>
}): Promise<VerifiedVideo | VideoRejection> {
  const declaration = checkVideoDeclaration({ sizeBytes: input.reader.size, mimeType: input.declaredMimeType })
  if (!declaration.ok) return declaration

  const inspection = await inspectVideo(input.reader, input.limits ?? INSPECTION_LIMITS)
  const content = checkInspectionAgainstMime(declaration.mimeType, inspection)
  if (!content.ok) return content

  return {
    ok: true,
    mimeType:        declaration.mimeType,
    extension:       declaration.extension,
    container:       content.container,
    durationSeconds: content.durationSeconds,
  }
}

const UNREADABLE_VIDEO = 'El archivo no es un video válido o está dañado.'
const UNVERIFIABLE_VIDEO = 'No pudimos verificar el video. Intentá de nuevo.'

const REJECTION_MESSAGES: Record<VideoRejectionCode, string> = {
  invalid_size:               UNREADABLE_VIDEO,
  empty_file:                 'El archivo está vacío.',
  file_too_large:             VIDEO_LIMIT_MESSAGES.tooLarge,
  mime_not_allowed:           VIDEO_LIMIT_MESSAGES.mimeNotAllowed,
  content_mismatch:           UNREADABLE_VIDEO,
  unrecognized_container:     UNREADABLE_VIDEO,
  truncated_container:        UNREADABLE_VIDEO,
  malformed_container:        UNREADABLE_VIDEO,
  invalid_timescale:          UNREADABLE_VIDEO,
  duration_unavailable:       'No pudimos verificar la duración del video. Exportalo de nuevo (por ejemplo, como MP4) e intentá otra vez.',
  duration_invalid:           'No pudimos verificar la duración del video. Exportalo de nuevo (por ejemplo, como MP4) e intentá otra vez.',
  duration_too_long:          VIDEO_LIMIT_MESSAGES.tooLong,
  inspection_budget_exceeded: UNREADABLE_VIDEO,
  read_failed:                UNVERIFIABLE_VIDEO,
}

/** Mensaje para el usuario. Nunca incluye detalles internos (paths, tokens, offsets). */
export function videoRejectionMessage(code: VideoRejectionCode): string {
  return REJECTION_MESSAGES[code]
}

function reject(code: VideoRejectionCode): VideoRejection {
  return { ok: false, code }
}

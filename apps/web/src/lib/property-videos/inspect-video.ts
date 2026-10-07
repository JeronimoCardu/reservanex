// Property Videos Fase 2A — inspección de contenedor + duración por rangos.
//
// Objetivo (Fase 2B): que finalize valide el objeto YA SUBIDO a Storage —qué
// es realmente y cuánto dura— sin descargarlo entero y sin creerle nada al
// browser. La duración que declare el cliente nunca es autoridad: sale del
// contenedor (mvhd en MP4/MOV, Info/Duration en WebM) o la inspección falla.
//
// Qué NO garantiza: es la duración DECLARADA por el contenedor, no la de los
// frames decodificados. Un archivo armado a mano puede declarar 10 s y traer
// más media; el tope duro contra abuso sigue siendo MAX_VIDEO_SIZE_BYTES.
//
// Todo error termina en un resultado { ok: false } (fail-closed): un archivo
// raro nunca hace tirar al inspector ni pasa como "no pude verificar, dejo pasar".

import { ISOBMFF_FIRST_BOX_TYPES, inspectIsoBmff } from './inspect-isobmff'
import { inspectWebm } from './inspect-webm'
import { ContainerError, type VideoContainerFamily, type VideoInspection, type VideoInspectionFailure } from './inspection-types'
import { InspectionReadError, InspectionSource, INSPECTION_LIMITS, type InspectionLimits, type RangeReader } from './range-reader'

export type { VideoContainer, VideoContainerFamily, VideoInspection, VideoInspectionFailure } from './inspection-types'

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const

/** Familia del contenedor según los primeros bytes; null si no es ninguna conocida. */
export function sniffContainerFamily(head: Uint8Array): VideoContainerFamily | null {
  if (head.length >= 4 && EBML_MAGIC.every((byte, i) => head[i] === byte)) return 'ebml'
  if (head.length >= 8 && ISOBMFF_FIRST_BOX_TYPES.has(String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!))) {
    return 'isobmff'
  }
  return null
}

export async function inspectVideo(
  reader: RangeReader,
  limits: Readonly<InspectionLimits> = INSPECTION_LIMITS,
): Promise<VideoInspection> {
  let family: VideoContainerFamily | null = null
  try {
    const source = new InspectionSource(reader, limits)
    const head = await source.loadHead()
    family = sniffContainerFamily(head)
    if (family === null) return { ok: false, family, reason: 'unrecognized_container' }

    const result = family === 'isobmff' ? await inspectIsoBmff(source) : await inspectWebm(source)
    return { ok: true, family, ...result }
  } catch (error) {
    return { ok: false, family, reason: failureReason(error) }
  }
}

function failureReason(error: unknown): VideoInspectionFailure {
  if (error instanceof ContainerError) return error.reason
  if (error instanceof InspectionReadError) {
    switch (error.kind) {
      case 'budget_exceeded': return 'inspection_budget_exceeded'
      case 'out_of_bounds':   return 'malformed_container'
      case 'short_read':
      case 'read_failed':     return 'read_failed'
    }
  }
  // Cualquier otra cosa (p. ej. un RangeError de DataView ante bytes hostiles)
  // también rechaza: el inspector no aprueba lo que no entendió.
  return 'malformed_container'
}

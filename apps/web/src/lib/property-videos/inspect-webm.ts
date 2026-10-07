// Property Videos Fase 2A — WebM (EBML / Matroska).
//
// EBML es una secuencia de elementos [ID vint][size vint][data]. El ID
// conserva su bit marcador (1–4 bytes); el size no (1–8 bytes), y "todos los
// bits en 1" significa tamaño DESCONOCIDO (lo que escribe MediaRecorder en el
// Segment y en los Clusters de una grabación en vivo).
//
// Recorrido: EBML header (DocType) → Segment → hijos del Segment hasta Info →
// Info/TimestampScale + Info/Duration. Duration es un float en unidades de
// TimestampScale (default 1 000 000 ns = 1 ms).
//
// Un WebM grabado con MediaRecorder (Chrome/Firefox) NO trae Duration: nadie
// vuelve a completar el header al terminar. Eso es duration_unavailable →
// rechazo. Decisión cerrada: no se usa la duración que calcula el browser
// como respaldo.
//
// Si aparece un Cluster antes que Info, o un hijo del Segment de tamaño
// desconocido, no se sigue buscando (saltarlo exigiría leer media):
// duration_unavailable.

import { ContainerError, type ContainerInspection, type VideoInspectionFailure } from './inspection-types'
import type { InspectionSource } from './range-reader'

const ID = {
  EBML:            0x1a45dfa3,
  DOC_TYPE:        0x4282,
  SEGMENT:         0x18538067,
  INFO:            0x1549a966,
  CLUSTER:         0x1f43b675,
  TIMESTAMP_SCALE: 0x2ad7b1,
  DURATION:        0x4489,
} as const

export const WEBM_LIMITS = {
  /** Un EBML header real ocupa ~30–40 bytes. */
  maxEbmlHeaderBytes: 1024,
  maxSegmentChildren: 64,
  /** Info real: unos cientos de bytes (títulos y nombres de app incluidos). */
  maxInfoBytes:       64 * 1024,
  maxChildrenPerElement: 256,
} as const

const DEFAULT_TIMESTAMP_SCALE_NS = 1_000_000
/** ID (≤ 4 bytes) + size (≤ 8 bytes). */
const MAX_ELEMENT_HEADER_BYTES = 12

interface ElementHeader {
  id: number
  dataStart: number
  /** null = tamaño desconocido. */
  end: number | null
}

export async function inspectWebm(source: InspectionSource): Promise<ContainerInspection> {
  const ebml = await readElementHeader(source, 0, source.size)
  if (ebml.id !== ID.EBML) throw new ContainerError('unrecognized_container', 'no empieza con un EBML header')
  if (ebml.end === null || ebml.end - ebml.dataStart > WEBM_LIMITS.maxEbmlHeaderBytes) {
    throw new ContainerError('malformed_container', 'EBML header de tamaño inválido')
  }

  const docType = readDocType(await source.read(ebml.dataStart, ebml.end))
  const container = docType === 'webm' ? 'webm' : docType === 'matroska' ? 'matroska' : null
  if (container === null) throw new ContainerError('unrecognized_container', 'DocType desconocido')

  const segment = await readElementHeader(source, ebml.end, source.size)
  if (segment.id !== ID.SEGMENT) throw new ContainerError('malformed_container', 'falta el Segment')
  const segmentEnd = segment.end ?? source.size

  let offset = segment.dataStart
  for (let index = 0; offset < segmentEnd; index++) {
    if (index >= WEBM_LIMITS.maxSegmentChildren) {
      throw new ContainerError('inspection_budget_exceeded', 'demasiados elementos antes de Info')
    }
    const element = await readElementHeader(source, offset, segmentEnd)
    if (element.id === ID.INFO) {
      if (element.end === null) throw new ContainerError('malformed_container', 'Info de tamaño desconocido')
      if (element.end - element.dataStart > WEBM_LIMITS.maxInfoBytes) {
        throw new ContainerError('inspection_budget_exceeded', 'Info demasiado grande')
      }
      return { container, durationSeconds: readInfoDuration(await source.read(element.dataStart, element.end)) }
    }
    if (element.id === ID.CLUSTER || element.end === null) {
      throw new ContainerError('duration_unavailable', 'no hay Info antes de la media')
    }
    offset = element.end
  }

  throw new ContainerError('malformed_container', 'Segment sin Info')
}

async function readElementHeader(source: InspectionSource, start: number, parentEnd: number): Promise<ElementHeader> {
  const available = parentEnd - start
  if (available < 2) throw new ContainerError('truncated_container', 'header de elemento cortado')

  const bytes = await source.read(start, start + Math.min(MAX_ELEMENT_HEADER_BYTES, available))
  const id = readElementId(bytes, 0, 'truncated_container')
  const size = readElementSize(bytes, id.length, 'truncated_container')
  const dataStart = start + id.length + size.length
  if (size.value === null) return { id: id.value, dataStart, end: null }

  const end = dataStart + size.value
  if (end > parentEnd) throw new ContainerError('truncated_container', 'el elemento excede su contenedor')
  return { id: id.value, dataStart, end }
}

// `whenCut`: la falla si el buffer termina antes que el vint — truncado si es
// el archivo, malformado si es un elemento que ya se leyó entero.
type CutFailure = Extract<VideoInspectionFailure, 'truncated_container' | 'malformed_container'>

/** Largo de un vint según su primer byte (posición del primer bit en 1); 0 si el byte es 0x00. */
function vintLength(first: number): number {
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) return i + 1
  }
  return 0
}

/** ID de elemento: 1–4 bytes, se conserva el marcador (así están escritos los IDs en la spec). */
function readElementId(bytes: Uint8Array, at: number, whenCut: CutFailure): { value: number; length: number } {
  const first = bytes[at]
  if (first === undefined) throw new ContainerError(whenCut, 'ID cortado')
  const length = vintLength(first)
  if (length === 0 || length > 4) throw new ContainerError('malformed_container', 'ID EBML inválido')
  if (at + length > bytes.length) throw new ContainerError(whenCut, 'ID cortado')
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i]!
  return { value, length }
}

/** Size de elemento: 1–8 bytes sin el marcador; null si todos los bits de datos están en 1 ("desconocido"). */
function readElementSize(bytes: Uint8Array, at: number, whenCut: CutFailure): { value: number | null; length: number } {
  const first = bytes[at]
  if (first === undefined) throw new ContainerError(whenCut, 'size cortado')
  const length = vintLength(first)
  if (length === 0) throw new ContainerError('malformed_container', 'size EBML inválido')
  if (at + length > bytes.length) throw new ContainerError(whenCut, 'size cortado')

  const mask = (0x80 >> (length - 1)) - 1
  let value = first & mask
  let allOnes = value === mask
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i]!
    value = value * 256 + byte
    allOnes = allOnes && byte === 0xff
  }
  // Más allá de 2⁵³ el valor deja de ser exacto, pero ya excede cualquier
  // archivo permitido: el chequeo contra el contenedor lo rechaza.
  return { value: allOnes ? null : value, length }
}

/** Hijos de un elemento ya leído entero. Un hijo que se pasa del padre es estructura inválida. */
function children(body: Uint8Array): Array<{ id: number; data: Uint8Array }> {
  const out: Array<{ id: number; data: Uint8Array }> = []
  let pos = 0
  while (pos < body.length) {
    if (out.length >= WEBM_LIMITS.maxChildrenPerElement) {
      throw new ContainerError('inspection_budget_exceeded', 'demasiados elementos hijos')
    }
    const id = readElementId(body, pos, 'malformed_container')
    const size = readElementSize(body, pos + id.length, 'malformed_container')
    if (size.value === null) throw new ContainerError('malformed_container', 'hijo de tamaño desconocido')
    const start = pos + id.length + size.length
    const end = start + size.value
    if (end > body.length) throw new ContainerError('malformed_container', 'hijo que excede a su padre')
    out.push({ id: id.value, data: body.subarray(start, end) })
    pos = end
  }
  return out
}

function readDocType(ebmlBody: Uint8Array): string | null {
  const docType = children(ebmlBody).find((child) => child.id === ID.DOC_TYPE)
  if (!docType) return null
  // String ASCII, con posible relleno de NULs al final.
  return String.fromCharCode(...docType.data).replace(/\0+$/, '')
}

function readInfoDuration(info: Uint8Array): number {
  let timestampScale = DEFAULT_TIMESTAMP_SCALE_NS
  let duration: number | null = null

  for (const child of children(info)) {
    if (child.id === ID.TIMESTAMP_SCALE) {
      timestampScale = readUnsigned(child.data)
      if (timestampScale === 0) throw new ContainerError('malformed_container', 'TimestampScale 0')
    } else if (child.id === ID.DURATION) {
      duration = readFloat(child.data)
    }
  }

  if (duration === null) throw new ContainerError('duration_unavailable', 'Info sin Duration')
  if (!Number.isFinite(duration) || duration <= 0) throw new ContainerError('duration_unavailable', 'Duration inválida')

  const seconds = (duration * timestampScale) / 1e9
  if (!Number.isFinite(seconds)) throw new ContainerError('malformed_container', 'duración fuera de rango')
  return seconds
}

function readUnsigned(data: Uint8Array): number {
  if (data.length === 0 || data.length > 8) throw new ContainerError('malformed_container', 'entero EBML inválido')
  let value = 0
  for (const byte of data) value = value * 256 + byte
  return value
}

function readFloat(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.length === 4) return view.getFloat32(0)
  if (data.length === 8) return view.getFloat64(0)
  if (data.length === 0) return 0
  throw new ContainerError('malformed_container', 'float EBML inválido')
}

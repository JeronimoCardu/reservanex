// Property Videos Fase 2A — MP4 / MOV (ISO Base Media File Format y QuickTime).
//
// Un archivo es una secuencia de boxes: [size u32][type 4cc][payload].
//   · size == 1 → el tamaño real va en un u64 a continuación (header de 16
//     bytes: el "box de 64 bits", típico de un mdat grande);
//   · size == 0 → el box llega hasta el final de su contenedor.
// La duración vive en moov/mvhd: timescale (ticks por segundo) + duration
// (en ticks). moov puede ir al principio (faststart) o al final (lo típico de
// una cámara: ftyp, mdat enorme, moov). Para llegar a un moov al final se
// SALTA el mdat leyendo sólo su header: nunca se lee contenido de media.
//
// Sin BigInt (target ES2017): un u64 se arma como hi·2³² + lo, exacto hasta
// 2⁵³. Por encima de eso el valor ya supera cualquier archivo de ≤ 50 MB (→
// truncated) o cualquier duración de ≤ 60 s (→ se rechaza igual).
//
// MP4 fragmentado (mvhd con duration 0 y la media en moof): la duración no se
// puede verificar sin recorrer los fragmentos → duration_unavailable (rechazo).

import { ContainerError, type ContainerInspection } from './inspection-types'
import type { InspectionSource } from './range-reader'

/** Tipos de box que pueden abrir un archivo ISO-BMFF: ftyp, o un átomo de QuickTime clásico (sin ftyp). */
export const ISOBMFF_FIRST_BOX_TYPES: ReadonlySet<string> = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'])

/**
 * Topes de recorrido, además del presupuesto de InspectionSource: los boxes
 * que caen dentro de la ventana inicial no gastan lecturas, así que el
 * presupuesto solo no acota un archivo hecho de miles de boxes mínimos.
 */
export const ISOBMFF_LIMITS = {
  maxTopLevelBoxes: 64,
  maxMoovChildren:  64,
} as const

const QUICKTIME_MAJOR_BRAND = 'qt  '
const TWO_POW_32 = 2 ** 32
const U32_MAX = 0xffffffff

interface BoxHeader {
  type: string
  start: number
  end: number
  headerSize: number
}

export async function inspectIsoBmff(source: InspectionSource): Promise<ContainerInspection> {
  // Sin ftyp es QuickTime clásico; con ftyp manda el major brand.
  let container: ContainerInspection['container'] = 'quicktime'
  let offset = 0

  for (let index = 0; offset < source.size; index++) {
    if (index >= ISOBMFF_LIMITS.maxTopLevelBoxes) {
      throw new ContainerError('inspection_budget_exceeded', 'demasiados boxes de primer nivel')
    }
    const box = await readBoxHeader(source, offset, source.size)
    if (index === 0) {
      if (!ISOBMFF_FIRST_BOX_TYPES.has(box.type)) {
        throw new ContainerError('unrecognized_container', 'el primer box no es de un MP4/MOV')
      }
      if (box.type === 'ftyp') {
        container = (await readMajorBrand(source, box)) === QUICKTIME_MAJOR_BRAND ? 'quicktime' : 'mp4'
      }
    }
    if (box.type === 'moov') {
      return { container, durationSeconds: await readMovieDuration(source, box) }
    }
    offset = box.end
  }

  throw new ContainerError('malformed_container', 'el archivo no tiene moov')
}

/** Header del box que empieza en `start`, validado contra el final de su contenedor. */
async function readBoxHeader(source: InspectionSource, start: number, parentEnd: number): Promise<BoxHeader> {
  const available = parentEnd - start
  if (available < 8) throw new ContainerError('truncated_container', 'header de box cortado')

  const bytes = await source.read(start, start + Math.min(16, available))
  const view = dataView(bytes)
  const size32 = view.getUint32(0)
  const type = fourCC(bytes, 4)
  if (type === null) throw new ContainerError('malformed_container', 'tipo de box inválido')

  let size: number
  let headerSize = 8
  if (size32 === 1) {
    if (available < 16) throw new ContainerError('truncated_container', 'largesize cortado')
    size = view.getUint32(8) * TWO_POW_32 + view.getUint32(12)
    headerSize = 16
    if (size < 16) throw new ContainerError('malformed_container', 'largesize menor que su header')
  } else if (size32 === 0) {
    size = available
  } else {
    if (size32 < 8) throw new ContainerError('malformed_container', 'box menor que su header')
    size = size32
  }

  if (size > available) throw new ContainerError('truncated_container', 'el box excede el archivo')
  return { type, start, end: start + size, headerSize }
}

async function readMajorBrand(source: InspectionSource, ftyp: BoxHeader): Promise<string> {
  const payload = ftyp.start + ftyp.headerSize
  // major_brand (4) + minor_version (4) como mínimo.
  if (ftyp.end - payload < 8) throw new ContainerError('malformed_container', 'ftyp corto')
  const brand = fourCC(await source.read(payload, payload + 4), 0)
  if (brand === null) throw new ContainerError('malformed_container', 'major brand inválido')
  return brand
}

async function readMovieDuration(source: InspectionSource, moov: BoxHeader): Promise<number> {
  let offset = moov.start + moov.headerSize
  for (let index = 0; offset < moov.end; index++) {
    if (index >= ISOBMFF_LIMITS.maxMoovChildren) {
      throw new ContainerError('inspection_budget_exceeded', 'demasiados boxes dentro de moov')
    }
    const child = await readBoxHeader(source, offset, moov.end)
    if (child.type === 'mvhd') return readMvhdDuration(source, child)
    offset = child.end
  }
  throw new ContainerError('malformed_container', 'moov sin mvhd')
}

// mvhd (FullBox):
//   v0: version+flags (4) · creation (4) · modification (4) · timescale (4) · duration (4)
//   v1: version+flags (4) · creation (8) · modification (8) · timescale (4) · duration (8)
// duration con todos los bits en 1 = "desconocida".
async function readMvhdDuration(source: InspectionSource, mvhd: BoxHeader): Promise<number> {
  const payload = mvhd.start + mvhd.headerSize
  const payloadLength = mvhd.end - payload
  if (payloadLength < 4) throw new ContainerError('malformed_container', 'mvhd corto')

  const bytes = await source.read(payload, payload + Math.min(32, payloadLength))
  const version = bytes[0]
  if (version !== 0 && version !== 1) throw new ContainerError('malformed_container', 'versión de mvhd desconocida')
  if (bytes.length < (version === 1 ? 32 : 20)) throw new ContainerError('malformed_container', 'mvhd corto')

  const view = dataView(bytes)
  let timescale: number
  let ticks: number
  let unknown: boolean
  if (version === 1) {
    timescale = view.getUint32(20)
    const hi = view.getUint32(24)
    const lo = view.getUint32(28)
    unknown = hi === U32_MAX && lo === U32_MAX
    ticks = hi * TWO_POW_32 + lo
  } else {
    timescale = view.getUint32(12)
    ticks = view.getUint32(16)
    unknown = ticks === U32_MAX
  }

  if (timescale === 0) throw new ContainerError('invalid_timescale', 'mvhd con timescale 0')
  if (unknown || ticks === 0) throw new ContainerError('duration_unavailable', 'mvhd sin duración verificable')
  return ticksToSeconds(ticks, timescale)
}

/** Segundos a partir de ticks + timescale. Siempre finito para entradas u32/u64. */
export function ticksToSeconds(ticks: number, timescale: number): number {
  const seconds = ticks / timescale
  if (!Number.isFinite(seconds) || seconds < 0) throw new ContainerError('malformed_container', 'duración fuera de rango')
  return seconds
}

function fourCC(bytes: Uint8Array, at: number): string | null {
  let out = ''
  for (let i = at; i < at + 4; i++) {
    const byte = bytes[i]
    // ASCII imprimible, más '©' (0xA9), que QuickTime usa en algunos átomos.
    if (byte === undefined || ((byte < 0x20 || byte > 0x7e) && byte !== 0xa9)) return null
    out += String.fromCharCode(byte)
  }
  return out
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

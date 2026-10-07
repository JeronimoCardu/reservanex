// Fixtures SINTÉTICOS de contenedores de video para tests: se arman byte a
// byte en memoria. No hay videos binarios en el repo. Los archivos "grandes"
// (un mdat de 40 MB, un objeto de 50 MB) son virtuales: virtualReader
// sintetiza sólo los bytes que se piden.

import type { RangeReader } from '@/lib/property-videos/range-reader'

export function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let at = 0
  for (const a of arrays) {
    out.set(a, at)
    at += a.length
  }
  return out
}

export function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0))
}

export function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/** u64 big-endian a partir de hi/lo. */
export function u64(hi: number, lo: number): number[] {
  return [...u32(hi), ...u32(lo)]
}

// ── ISO-BMFF (MP4 / MOV) ─────────────────────────────────────────────────────

/** Box con size de 32 bits. */
export function box(type: string, payload: Uint8Array | number[] = []): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload)
  return concat(u32(8 + body.length), ascii(type), body)
}

/** Box de 64 bits: size = 1 y largesize u64 a continuación. */
export function largeBox(type: string, payload: Uint8Array | number[] = []): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload)
  return concat(u32(1), ascii(type), u64(0, 16 + body.length), body)
}

export function ftyp(majorBrand = 'isom'): Uint8Array {
  return box('ftyp', [...ascii(majorBrand), ...u32(0x200), ...ascii('isom'), ...ascii('mp41')])
}

/** mvhd versión 0: timescale + duration u32, más el resto del box (80 bytes) en cero. */
export function mvhdV0(timescale: number, duration: number): Uint8Array {
  return box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration), ...new Array(80).fill(0)])
}

/** mvhd versión 1: creation/modification/duration u64. */
export function mvhdV1(timescale: number, durationHi: number, durationLo: number): Uint8Array {
  return box('mvhd', [1, 0, 0, 0, ...u64(0, 0), ...u64(0, 0), ...u32(timescale), ...u64(durationHi, durationLo), ...new Array(80).fill(0)])
}

export function moov(...children: Uint8Array[]): Uint8Array {
  return box('moov', concat(...children, box('trak', new Array(64).fill(0))))
}

export function mdat(bytes = 256): Uint8Array {
  return box('mdat', new Array(bytes).fill(0x42))
}

/** MP4 chico y válido. `seconds` en un timescale de 1000 (o el dado). */
export function mp4(opts: {
  seconds?: number
  timescale?: number
  brand?: string
  moovFirst?: boolean
} = {}): Uint8Array {
  const timescale = opts.timescale ?? 1000
  const header = moov(mvhdV0(timescale, Math.round((opts.seconds ?? 30) * timescale)))
  const media = mdat()
  return opts.moovFirst === false
    ? concat(ftyp(opts.brand), media, header)
    : concat(ftyp(opts.brand), header, media)
}

// ── EBML (WebM) ──────────────────────────────────────────────────────────────

export const EBML_ID = {
  EBML:            0x1a45dfa3,
  DOC_TYPE:        0x4282,
  EBML_VERSION:    0x4286,
  SEGMENT:         0x18538067,
  SEEK_HEAD:       0x114d9b74,
  VOID:            0xec,
  INFO:            0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  DURATION:        0x4489,
  MUXING_APP:      0x4d80,
  TRACKS:          0x1654ae6b,
  CLUSTER:         0x1f43b675,
} as const

function idBytes(id: number): number[] {
  const out: number[] = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256)
  return out
}

/** Size EBML de largo mínimo (hasta 4 bytes alcanza para los fixtures). */
export function ebmlSize(size: number): number[] {
  if (size < 0x7f) return [0x80 | size]
  if (size < 0x3fff) return [0x40 | (size >> 8), size & 0xff]
  if (size < 0x1fffff) return [0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff]
  return [0x10 | (size >>> 24), (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff]
}

/** Size "desconocido" de 8 bytes, como el que escribe MediaRecorder. */
export const EBML_UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]

export function el(id: number, data: Uint8Array | number[] = [], opts: { unknownSize?: boolean } = {}): Uint8Array {
  const body = data instanceof Uint8Array ? data : Uint8Array.from(data)
  return concat(idBytes(id), opts.unknownSize ? EBML_UNKNOWN_SIZE : ebmlSize(body.length), body)
}

export function float64(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return [...new Uint8Array(view.buffer)]
}

export function float32(value: number): number[] {
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value)
  return [...new Uint8Array(view.buffer)]
}

export function ebmlHeader(docType = 'webm'): Uint8Array {
  return el(EBML_ID.EBML, concat(el(EBML_ID.EBML_VERSION, [1]), el(EBML_ID.DOC_TYPE, ascii(docType))))
}

export function info(opts: { durationMs?: number | null; timestampScale?: number; float32?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [el(EBML_ID.TIMESTAMP_SCALE, u32(opts.timestampScale ?? 1_000_000))]
  if (opts.durationMs !== null) {
    const d = opts.durationMs ?? 30_000
    parts.push(el(EBML_ID.DURATION, opts.float32 ? float32(d) : float64(d)))
  }
  parts.push(el(EBML_ID.MUXING_APP, ascii('fixture')))
  return el(EBML_ID.INFO, concat(...parts))
}

export function cluster(opts: { unknownSize?: boolean } = {}): Uint8Array {
  return el(EBML_ID.CLUSTER, new Array(64).fill(0x11), opts)
}

/** WebM chico. Por defecto: EBML + Segment(SeekHead, Void, Info con Duration, Tracks, Cluster). */
export function webm(opts: {
  docType?: string
  durationMs?: number | null
  timestampScale?: number
  float32?: boolean
  /** Como MediaRecorder: Segment y Cluster de tamaño desconocido, sin Duration. */
  mediaRecorder?: boolean
  clusterBeforeInfo?: boolean
} = {}): Uint8Array {
  if (opts.mediaRecorder) {
    return concat(
      ebmlHeader(opts.docType),
      el(EBML_ID.SEGMENT, concat(info({ durationMs: null }), el(EBML_ID.TRACKS, new Array(32).fill(0)), cluster({ unknownSize: true })), { unknownSize: true }),
    )
  }
  const infoEl = info(opts)
  const body = opts.clusterBeforeInfo
    ? concat(cluster(), infoEl)
    : concat(el(EBML_ID.SEEK_HEAD, new Array(24).fill(0)), el(EBML_ID.VOID, new Array(100).fill(0)), infoEl, el(EBML_ID.TRACKS, new Array(32).fill(0)), cluster())
  return concat(ebmlHeader(opts.docType), el(EBML_ID.SEGMENT, body))
}

// ── Lectores ─────────────────────────────────────────────────────────────────

/**
 * Archivo virtual de `size` bytes: cero en todos lados salvo las regiones
 * dadas. Sintetiza sólo lo que se lee — permite probar un moov detrás de un
 * mdat de 40 MB sin reservar 40 MB.
 */
export function virtualReader(size: number, regions: Array<{ at: number; bytes: Uint8Array }>): RangeReader {
  return {
    size,
    async readRange(start, end) {
      if (start < 0 || end > size || end < start) throw new Error('fuera de rango')
      const out = new Uint8Array(end - start)
      for (const { at, bytes } of regions) {
        const from = Math.max(start, at)
        const to = Math.min(end, at + bytes.length)
        if (from < to) out.set(bytes.subarray(from - at, to - at), from - start)
      }
      return out
    },
  }
}

/** Envuelve un reader y registra cada lectura. */
export function spyReader(reader: RangeReader): RangeReader & { calls: Array<[number, number]>; bytesRead(): number } {
  const calls: Array<[number, number]> = []
  return {
    size: reader.size,
    calls,
    bytesRead: () => calls.reduce((n, [s, e]) => n + (e - s), 0),
    readRange(start, end) {
      calls.push([start, end])
      return reader.readRange(start, end)
    },
  }
}

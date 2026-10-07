// Property Videos Fase 2A — lectura por rangos para inspeccionar un video sin
// traerlo entero.
//
// El inspector (inspect-video.ts) sólo conoce RangeReader: no sabe nada de
// Supabase. El adapter real (Fase 2B) va a implementar readRange con un GET
// `Range: bytes=start-(end-1)` contra el objeto ya subido; los tests usan
// bytes en memoria.
//
// PRESUPUESTO: un archivo malicioso puede encadenar boxes/elementos que
// apunten a cualquier lado. Sin tope, el parser podría pedir rango tras rango
// (= request tras request a Storage desde finalize). Toda inspección pasa por
// InspectionSource, que corta ANTES de leer cuando se excede:
//   · maxBytes = 256 KiB en total. Un MP4/MOV normal necesita < 1 KiB fuera de
//     la ventana inicial (headers de 16 bytes + mvhd de ≤ 120); un WebM, la
//     ventana inicial más, a lo sumo, el elemento Info (tope propio de 64 KiB).
//     256 KiB es 0,5 % de un video de 50 MB: margen holgado para lo legítimo,
//     nada para "leer el archivo de a pedazos".
//   · maxReads = 32 lecturas. Con el adapter de Storage cada lectura es un
//     request HTTP (~50–150 ms): 32 acota el peor caso de finalize a pocos
//     segundos. Lo normal son 1–4.
//   · headWindowBytes = 64 KiB: la primera lectura trae el principio del
//     archivo de una vez (ftyp + moov al principio, o EBML + Segment + Info) y
//     las relecturas dentro de esa ventana no gastan presupuesto.

/**
 * Lector de rangos de un objeto de tamaño conocido.
 *
 * `readRange(start, end)` devuelve los bytes [start, end) — intervalo
 * semiabierto, como Blob.slice / Uint8Array.subarray — y tiene que devolver
 * exactamente `end - start` bytes. El adapter HTTP traduce a
 * `Range: bytes=start-(end-1)` (el header HTTP es inclusivo).
 */
export interface RangeReader {
  readonly size: number
  readRange(start: number, end: number): Promise<Uint8Array>
}

export interface InspectionLimits {
  maxBytes: number
  maxReads: number
  headWindowBytes: number
}

export const INSPECTION_LIMITS: Readonly<InspectionLimits> = {
  maxBytes:        256 * 1024,
  maxReads:        32,
  headWindowBytes: 64 * 1024,
}

export type InspectionReadErrorKind =
  | 'budget_exceeded' // se pidió más de lo que permite el presupuesto
  | 'out_of_bounds'   // rango fuera de [0, size] o mal formado
  | 'short_read'      // el reader devolvió otra cantidad de bytes
  | 'read_failed'     // el reader tiró (red, Storage, etc.)

export class InspectionReadError extends Error {
  constructor(readonly kind: InspectionReadErrorKind, message: string) {
    super(message)
    this.name = 'InspectionReadError'
  }
}

/** Fuente de bytes de UNA inspección: valida rangos, aplica el presupuesto y cachea la ventana inicial. */
export class InspectionSource {
  private head: Uint8Array = new Uint8Array(0)
  private bytesRead = 0
  private reads = 0

  constructor(
    private readonly reader: RangeReader,
    private readonly limits: Readonly<InspectionLimits> = INSPECTION_LIMITS,
  ) {
    if (!Number.isSafeInteger(reader.size) || reader.size < 0) {
      throw new InspectionReadError('out_of_bounds', 'tamaño de objeto inválido')
    }
  }

  get size(): number {
    return this.reader.size
  }

  get stats(): { bytesRead: number; reads: number } {
    return { bytesRead: this.bytesRead, reads: this.reads }
  }

  /** Primera lectura: el principio del archivo, hasta headWindowBytes. */
  async loadHead(): Promise<Uint8Array> {
    this.head = await this.readBudgeted(0, Math.min(this.size, this.limits.headWindowBytes))
    return this.head
  }

  /** Bytes [start, end). Dentro de la ventana inicial no gasta presupuesto. */
  async read(start: number, end: number): Promise<Uint8Array> {
    assertRange(start, end, this.size)
    if (end <= this.head.length) return this.head.subarray(start, end)
    return this.readBudgeted(start, end)
  }

  private async readBudgeted(start: number, end: number): Promise<Uint8Array> {
    assertRange(start, end, this.size)
    const length = end - start
    // Se reserva ANTES de leer: un archivo hostil no consigue ni una lectura de más.
    if (this.reads + 1 > this.limits.maxReads || this.bytesRead + length > this.limits.maxBytes) {
      throw new InspectionReadError('budget_exceeded', 'presupuesto de inspección agotado')
    }
    this.reads += 1
    this.bytesRead += length

    let bytes: Uint8Array
    try {
      bytes = await this.reader.readRange(start, end)
    } catch {
      throw new InspectionReadError('read_failed', 'no se pudo leer el rango')
    }
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
      throw new InspectionReadError('short_read', 'el lector devolvió una cantidad de bytes distinta a la pedida')
    }
    return bytes
  }
}

function assertRange(start: number, end: number, size: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) {
    throw new InspectionReadError('out_of_bounds', 'rango fuera del archivo')
  }
}

/** RangeReader sobre bytes en memoria (tests, fixtures). Devuelve copias. */
export function rangeReaderFromBytes(bytes: Uint8Array): RangeReader {
  return {
    size: bytes.length,
    async readRange(start, end) {
      assertRange(start, end, bytes.length)
      return bytes.slice(start, end)
    },
  }
}

/** RangeReader sobre un Blob/File del browser: lee sólo los rangos pedidos. */
export function rangeReaderFromBlob(blob: Blob): RangeReader {
  return {
    size: blob.size,
    async readRange(start, end) {
      assertRange(start, end, blob.size)
      return new Uint8Array(await blob.slice(start, end).arrayBuffer())
    },
  }
}

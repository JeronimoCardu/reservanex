import { describe, expect, it } from 'vitest'
import { inspectVideo, sniffContainerFamily } from './inspect-video'
import { inspectIsoBmff, ticksToSeconds } from './inspect-isobmff'
import { InspectionSource, rangeReaderFromBytes } from './range-reader'
import {
  EBML_ID,
  ascii,
  box,
  cluster,
  concat,
  ebmlHeader,
  el,
  float64,
  ftyp,
  info,
  largeBox,
  mdat,
  moov,
  mp4,
  mvhdV0,
  mvhdV1,
  spyReader,
  u32,
  virtualReader,
  webm,
} from '@/testing/video-fixtures'

// Property Videos Fase 2A — inspección por rangos. Fixtures sintéticos
// armados byte a byte (src/testing/video-fixtures.ts), sin videos binarios.

const inspect = (bytes: Uint8Array) => inspectVideo(rangeReaderFromBytes(bytes))

describe('MP4 / MOV', () => {
  it('MP4 válido (ftyp isom, moov al principio)', async () => {
    expect(await inspect(mp4({ seconds: 30 }))).toEqual({ ok: true, family: 'isobmff', container: 'mp4', durationSeconds: 30 })
  })

  it('MOV válido (ftyp qt)', async () => {
    expect(await inspect(mp4({ seconds: 12.5, brand: 'qt  ', timescale: 600 }))).toEqual({
      ok: true, family: 'isobmff', container: 'quicktime', durationSeconds: 12.5,
    })
  })

  it('MOV clásico sin ftyp (empieza con wide / moov)', async () => {
    const file = concat(box('wide'), moov(mvhdV0(600, 600 * 20)), mdat())
    expect(await inspect(file)).toEqual({ ok: true, family: 'isobmff', container: 'quicktime', durationSeconds: 20 })
  })

  it('moov al principio y moov al final dan la misma duración', async () => {
    const first = await inspect(mp4({ seconds: 42, moovFirst: true }))
    const last = await inspect(mp4({ seconds: 42, moovFirst: false }))
    expect(first).toMatchObject({ ok: true, durationSeconds: 42 })
    expect(last).toEqual(first)
  })

  it('moov al final detrás de un mdat de 40 MB: salta el mdat leyendo sólo headers', async () => {
    const mdatSize = 40 * 1024 * 1024
    const head = concat(ftyp(), u32(mdatSize), ascii('mdat'))
    const tail = moov(mvhdV0(1000, 55_000))
    const moovAt = head.length - 8 + mdatSize
    const reader = spyReader(virtualReader(moovAt + tail.length, [{ at: 0, bytes: head }, { at: moovAt, bytes: tail }]))

    expect(await inspectVideo(reader)).toMatchObject({ ok: true, container: 'mp4', durationSeconds: 55 })
    expect(reader.calls.length).toBeLessThanOrEqual(4)
    expect(reader.bytesRead()).toBeLessThan(70 * 1024) // ventana inicial + headers, nunca el mdat
  })

  it('box de 64 bits (mdat con largesize) antes de moov', async () => {
    const file = concat(ftyp(), largeBox('mdat', new Array(300).fill(1)), moov(mvhdV0(1000, 15_000)))
    expect(await inspect(file)).toMatchObject({ ok: true, durationSeconds: 15 })
  })

  it('mdat de 64 bits virtual de 45 MB con moov detrás', async () => {
    const mdatSize = 45 * 1024 * 1024
    const head = concat(ftyp(), u32(1), ascii('mdat'), u32(0), u32(mdatSize))
    const tail = moov(mvhdV0(90_000, 90_000 * 8))
    const moovAt = ftyp().length + mdatSize
    const reader = virtualReader(moovAt + tail.length, [{ at: 0, bytes: head }, { at: moovAt, bytes: tail }])
    expect(await inspectVideo(reader)).toMatchObject({ ok: true, durationSeconds: 8 })
  })

  it('moov de 64 bits: sus hijos se leen después del header de 16 bytes', async () => {
    const file = concat(ftyp(), largeBox('moov', concat(mvhdV0(1000, 21_000), box('trak', new Array(16).fill(0)))), mdat())
    expect(await inspect(file)).toMatchObject({ ok: true, durationSeconds: 21 })
  })

  it('largesize con parte alta ≠ 0 (≥ 4 GiB) en un archivo chico → truncated_container', async () => {
    const file = concat(ftyp(), u32(1), ascii('mdat'), u32(1), u32(16 + 300), new Array(300).fill(0), moov(mvhdV0(1000, 5000)))
    expect(await inspect(file)).toMatchObject({ ok: false, reason: 'truncated_container' })
  })

  it('mvhd versión 1 (duración u64)', async () => {
    const file = concat(ftyp(), moov(mvhdV1(48_000, 0, 48_000 * 33)), mdat())
    expect(await inspect(file)).toMatchObject({ ok: true, durationSeconds: 33 })
  })

  it('duración ≤ 60 se extrae tal cual (59.5 s, 60 s)', async () => {
    expect(await inspect(mp4({ seconds: 59.5 }))).toMatchObject({ ok: true, durationSeconds: 59.5 })
    expect(await inspect(mp4({ seconds: 60 }))).toMatchObject({ ok: true, durationSeconds: 60 })
  })

  it('duración > 60 se extrae (el rechazo es de validation.ts)', async () => {
    expect(await inspect(mp4({ seconds: 61 }))).toMatchObject({ ok: true, durationSeconds: 61 })
  })

  it('segundos seguros con u64 enormes: siempre finitos', async () => {
    const file = concat(ftyp(), moov(mvhdV1(1, 0xfffffff0, 0)), mdat())
    const result = await inspect(file)
    expect(result.ok && Number.isFinite(result.durationSeconds) && result.durationSeconds > 60).toBe(true)
    expect(ticksToSeconds(2 ** 64 - 1, 1)).toBeGreaterThan(0)
    expect(Number.isFinite(ticksToSeconds(2 ** 64 - 1, 1))).toBe(true)
  })

  it('timescale 0 → invalid_timescale', async () => {
    const file = concat(ftyp(), moov(mvhdV0(0, 1000)), mdat())
    expect(await inspect(file)).toEqual({ ok: false, family: 'isobmff', reason: 'invalid_timescale' })
  })

  it.each([
    ['duración desconocida (todos los bits en 1)', mvhdV0(1000, 0xffffffff)],
    ['duración desconocida v1', mvhdV1(1000, 0xffffffff, 0xffffffff)],
    ['duración 0 (MP4 fragmentado)', mvhdV0(1000, 0)],
  ])('%s → duration_unavailable', async (_, mvhd) => {
    expect(await inspect(concat(ftyp(), moov(mvhd), mdat()))).toMatchObject({ ok: false, reason: 'duration_unavailable' })
  })

  it('archivo truncado: mdat que promete más bytes de los que hay', async () => {
    const full = mp4({ seconds: 30, moovFirst: false })
    expect(await inspect(full.subarray(0, full.length - 200))).toMatchObject({ ok: false, reason: 'truncated_container' })
  })

  it('archivo truncado en medio de un header', async () => {
    const file = concat(ftyp(), [0, 0, 1])
    expect(await inspect(file)).toMatchObject({ ok: false, reason: 'truncated_container' })
  })

  it('sin moov → malformed_container', async () => {
    expect(await inspect(concat(ftyp(), mdat()))).toMatchObject({ ok: false, reason: 'malformed_container' })
  })

  it('moov sin mvhd → malformed_container', async () => {
    expect(await inspect(concat(ftyp(), box('moov', box('trak', [1, 2, 3])), mdat()))).toMatchObject({ ok: false, reason: 'malformed_container' })
  })

  it('box con size < 8 → malformed_container (no hay bucle infinito)', async () => {
    expect(await inspect(concat(ftyp(), u32(4), ascii('free'), mdat()))).toMatchObject({ ok: false, reason: 'malformed_container' })
  })

  it('tipo de box no imprimible → malformed_container', async () => {
    expect(await inspect(concat(ftyp(), u32(16), [0, 1, 2, 3], new Array(8).fill(0)))).toMatchObject({ ok: false, reason: 'malformed_container' })
  })

  it('versión de mvhd desconocida → malformed_container', async () => {
    const mvhd = mvhdV0(1000, 5000)
    mvhd[8] = 7
    expect(await inspect(concat(ftyp(), moov(mvhd), mdat()))).toMatchObject({ ok: false, reason: 'malformed_container' })
  })
})

describe('WebM', () => {
  it('WebM con Duration (float64, TimestampScale por defecto de 1 ms)', async () => {
    expect(await inspect(webm({ durationMs: 30_000 }))).toEqual({ ok: true, family: 'ebml', container: 'webm', durationSeconds: 30 })
  })

  it('Duration float32 y TimestampScale propio', async () => {
    // TimestampScale de 1 ms → 45 000 unidades = 45 s; con escala de 10 ms → 4 500 unidades = 45 s.
    expect(await inspect(webm({ durationMs: 45_000, float32: true }))).toMatchObject({ ok: true, durationSeconds: 45 })
    expect(await inspect(webm({ durationMs: 4_500, timestampScale: 10_000_000 }))).toMatchObject({ ok: true, durationSeconds: 45 })
  })

  it('duración > 60 se extrae (el rechazo es de validation.ts)', async () => {
    expect(await inspect(webm({ durationMs: 90_000 }))).toMatchObject({ ok: true, durationSeconds: 90 })
  })

  it('WebM sin Duration → duration_unavailable', async () => {
    expect(await inspect(webm({ durationMs: null }))).toEqual({ ok: false, family: 'ebml', reason: 'duration_unavailable' })
  })

  it('WebM estilo MediaRecorder (Segment de tamaño desconocido, sin Duration) → duration_unavailable', async () => {
    expect(await inspect(webm({ mediaRecorder: true }))).toMatchObject({ ok: false, reason: 'duration_unavailable' })
  })

  it('Cluster antes que Info → duration_unavailable (no se lee media para buscarlo)', async () => {
    expect(await inspect(webm({ clusterBeforeInfo: true }))).toMatchObject({ ok: false, reason: 'duration_unavailable' })
  })

  it('Duration 0 o negativa → duration_unavailable', async () => {
    expect(await inspect(webm({ durationMs: 0 }))).toMatchObject({ ok: false, reason: 'duration_unavailable' })
    expect(await inspect(webm({ durationMs: -5 }))).toMatchObject({ ok: false, reason: 'duration_unavailable' })
  })

  it('DocType matroska se reconoce como tal (no como webm)', async () => {
    expect(await inspect(webm({ docType: 'matroska' }))).toMatchObject({ ok: true, container: 'matroska' })
  })

  it('DocType desconocido → unrecognized_container', async () => {
    expect(await inspect(webm({ docType: 'otro' }))).toMatchObject({ ok: false, reason: 'unrecognized_container' })
  })

  it('Void enorme antes de Info: se salta sin leerlo', async () => {
    const voidSize = 10 * 1024 * 1024
    const voidHeader = concat([0xec], [0x10 | (voidSize >>> 24), (voidSize >> 16) & 0xff, (voidSize >> 8) & 0xff, voidSize & 0xff])
    const head = concat(ebmlHeader(), el(EBML_ID.SEGMENT, [], { unknownSize: true }), voidHeader)
    const tail = concat(info({ durationMs: 20_000 }), cluster())
    const tailAt = head.length + voidSize
    const reader = spyReader(virtualReader(tailAt + tail.length, [{ at: 0, bytes: head }, { at: tailAt, bytes: tail }]))
    expect(await inspectVideo(reader)).toMatchObject({ ok: true, durationSeconds: 20 })
    expect(reader.bytesRead()).toBeLessThan(70 * 1024)
  })

  it('Info gigante → inspection_budget_exceeded (no se lee)', async () => {
    const infoSize = 200 * 1024
    const head = concat(ebmlHeader(), el(EBML_ID.SEGMENT, [], { unknownSize: true }), [0x15, 0x49, 0xa9, 0x66], [0x10 | (infoSize >>> 24), (infoSize >> 16) & 0xff, (infoSize >> 8) & 0xff, infoSize & 0xff])
    const reader = spyReader(virtualReader(head.length + infoSize, [{ at: 0, bytes: head }]))
    expect(await inspectVideo(reader)).toMatchObject({ ok: false, reason: 'inspection_budget_exceeded' })
    expect(reader.bytesRead()).toBeLessThanOrEqual(64 * 1024)

    // El tope propio de Info (64 KiB) corta aunque el presupuesto global alcance.
    const generous = spyReader(virtualReader(head.length + infoSize, [{ at: 0, bytes: head }]))
    expect(await inspectVideo(generous, { maxBytes: 10 * 1024 * 1024, maxReads: 32, headWindowBytes: 64 * 1024 }))
      .toMatchObject({ ok: false, reason: 'inspection_budget_exceeded' })
    expect(generous.bytesRead()).toBeLessThanOrEqual(64 * 1024)
  })

  it('WebM truncado (Segment de tamaño conocido que excede el archivo)', async () => {
    const full = webm({ durationMs: 30_000 })
    expect(await inspect(full.subarray(0, full.length - 20))).toMatchObject({ ok: false, reason: 'truncated_container' })
  })

  it('Info con un hijo que se pasa del elemento → malformed_container', async () => {
    const badInfo = el(EBML_ID.INFO, concat([0x44, 0x89], [0x88], float64(1000)).subarray(0, 6))
    const file = concat(ebmlHeader(), el(EBML_ID.SEGMENT, badInfo))
    expect(await inspect(file)).toMatchObject({ ok: false, reason: 'malformed_container' })
  })
})

describe('contenido que no es video', () => {
  it.each([
    ['basura', Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 251)],
    ['PNG', concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new Array(64).fill(0))],
    ['texto', Uint8Array.from(ascii('hola, esto no es un video'))],
    ['vacío', new Uint8Array(0)],
    ['un byte', new Uint8Array([0x1a])],
  ])('%s → unrecognized_container', async (_, bytes) => {
    expect(await inspect(bytes)).toEqual({ ok: false, family: null, reason: 'unrecognized_container' })
  })

  it('el parser ISO-BMFF también rechaza un primer box desconocido por su cuenta', async () => {
    const source = new InspectionSource(rangeReaderFromBytes(concat(box('abcd', [1, 2, 3, 4]), moov(mvhdV0(1000, 1000)))))
    await source.loadHead()
    await expect(inspectIsoBmff(source)).rejects.toMatchObject({ reason: 'unrecognized_container' })
  })

  it('sniff: EBML vs ISO-BMFF vs nada', () => {
    expect(sniffContainerFamily(webm())).toBe('ebml')
    expect(sniffContainerFamily(mp4())).toBe('isobmff')
    expect(sniffContainerFamily(new Uint8Array([0, 0, 0, 8, 0x61, 0x62, 0x63, 0x64]))).toBeNull()
  })
})

describe('límite de bytes inspeccionados', () => {
  it('cadena de boxes "free" de 1 MB fuera de la ventana: corta por presupuesto sin recorrer el archivo', async () => {
    const step = 1024 * 1024
    const size = 48 * step
    const regions = [{ at: 0, bytes: ftyp() }]
    for (let at = ftyp().length; at + 8 <= size; at += step) regions.push({ at, bytes: concat(u32(step), ascii('free')) })
    const reader = spyReader(virtualReader(size, regions))

    const result = await inspectVideo(reader, { maxBytes: 256 * 1024, maxReads: 8, headWindowBytes: 64 * 1024 })
    expect(result).toEqual({ ok: false, family: 'isobmff', reason: 'inspection_budget_exceeded' })
    expect(reader.calls).toHaveLength(8)
  })

  it('miles de boxes mínimos dentro de la ventana: corta por cantidad de boxes', async () => {
    const tiny = Array.from({ length: 2000 }, () => box('free'))
    expect(await inspect(concat(ftyp(), ...tiny, moov(mvhdV0(1000, 1000))))).toMatchObject({ ok: false, reason: 'inspection_budget_exceeded' })
  })

  it('reader que falla → read_failed (fail-closed, no tira)', async () => {
    const result = await inspectVideo({ size: 1000, readRange: async () => { throw new Error('boom') } })
    expect(result).toEqual({ ok: false, family: null, reason: 'read_failed' })
  })
})

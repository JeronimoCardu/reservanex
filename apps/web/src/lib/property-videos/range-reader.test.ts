import { describe, expect, it } from 'vitest'
import { InspectionReadError, InspectionSource, INSPECTION_LIMITS, rangeReaderFromBlob, rangeReaderFromBytes, type RangeReader } from './range-reader'
import { spyReader, virtualReader } from '@/testing/video-fixtures'

// Property Videos Fase 2A — lectura por rangos con presupuesto. El inspector
// no conoce Supabase: sólo pide [start, end) y el presupuesto corta ANTES de
// pedir de más.

async function readError(promise: Promise<unknown>): Promise<InspectionReadError> {
  const error = await promise.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(InspectionReadError)
  return error as InspectionReadError
}

describe('InspectionSource — rangos fuera del archivo', () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i)

  it.each([
    ['fin más allá del archivo', 90, 101],
    ['inicio negativo', -1, 10],
    ['fin antes que inicio', 20, 10],
    ['no entero', 1.5, 10],
    ['NaN', Number.NaN, 10],
  ])('%s → out_of_bounds, sin llamar al reader', async (_, start, end) => {
    const reader = spyReader(rangeReaderFromBytes(bytes))
    const source = new InspectionSource(reader)
    expect((await readError(source.read(start, end))).kind).toBe('out_of_bounds')
    expect(reader.calls).toHaveLength(0)
  })

  it('rango vacío al final es válido', async () => {
    const source = new InspectionSource(rangeReaderFromBytes(bytes))
    expect(await source.read(100, 100)).toHaveLength(0)
  })

  it('tamaño de objeto inválido → out_of_bounds al construir', () => {
    expect(() => new InspectionSource({ size: -1, readRange: async () => new Uint8Array(0) })).toThrow(InspectionReadError)
    expect(() => new InspectionSource({ size: Number.NaN, readRange: async () => new Uint8Array(0) })).toThrow(InspectionReadError)
  })

  it('rangeReaderFromBytes también rechaza rangos fuera del archivo', async () => {
    await expect(rangeReaderFromBytes(bytes).readRange(0, 101)).rejects.toThrow()
  })
})

describe('InspectionSource — presupuesto de bytes y lecturas', () => {
  const big = virtualReader(50 * 1024 * 1024, [])

  it('límites por defecto: 256 KiB, 32 lecturas, ventana inicial de 64 KiB', () => {
    expect(INSPECTION_LIMITS).toEqual({ maxBytes: 256 * 1024, maxReads: 32, headWindowBytes: 64 * 1024 })
  })

  it('una lectura que excede maxBytes se corta ANTES de pedirla', async () => {
    const reader = spyReader(big)
    const source = new InspectionSource(reader)
    expect((await readError(source.read(1_000_000, 1_000_000 + 256 * 1024 + 1))).kind).toBe('budget_exceeded')
    expect(reader.calls).toHaveLength(0)
  })

  it('los bytes se acumulan entre lecturas', async () => {
    const reader = spyReader(big)
    const source = new InspectionSource(reader, { maxBytes: 1000, maxReads: 100, headWindowBytes: 0 })
    await source.read(5000, 5600)
    expect((await readError(source.read(9000, 9401))).kind).toBe('budget_exceeded')
    expect(reader.bytesRead()).toBe(600)
  })

  it('la lectura número maxReads + 1 no se hace', async () => {
    const reader = spyReader(big)
    const source = new InspectionSource(reader, { maxBytes: 1_000_000, maxReads: 3, headWindowBytes: 0 })
    for (let i = 0; i < 3; i++) await source.read(i * 1000, i * 1000 + 16)
    expect((await readError(source.read(10_000, 10_016))).kind).toBe('budget_exceeded')
    expect(reader.calls).toHaveLength(3)
    expect(source.stats).toEqual({ bytesRead: 48, reads: 3 })
  })

  it('lo que cae dentro de la ventana inicial no vuelve a leerse ni gasta presupuesto', async () => {
    const reader = spyReader(big)
    const source = new InspectionSource(reader)
    await source.loadHead()
    await source.read(0, 16)
    await source.read(60_000, 64 * 1024)
    expect(reader.calls).toEqual([[0, 64 * 1024]])
    await source.read(64 * 1024, 64 * 1024 + 16)
    expect(reader.calls).toHaveLength(2)
  })
})

describe('InspectionSource — lector que falla o miente', () => {
  it('el reader tira → read_failed, sin propagar el mensaje original', async () => {
    const reader: RangeReader = { size: 100, readRange: async () => { throw new Error('https://storage.test/sign/x?token=SECRETO') } }
    const error = await readError(new InspectionSource(reader).read(0, 10))
    expect(error.kind).toBe('read_failed')
    expect(error.message).not.toContain('SECRETO')
  })

  it('el reader devuelve menos bytes → short_read', async () => {
    const reader: RangeReader = { size: 100, readRange: async (s, e) => new Uint8Array(e - s - 1) }
    expect((await readError(new InspectionSource(reader).read(0, 10))).kind).toBe('short_read')
  })
})

describe('rangeReaderFromBlob', () => {
  it('lee sólo el rango pedido de un Blob', async () => {
    const blob = new Blob([Uint8Array.from({ length: 50 }, (_, i) => i)])
    const reader = rangeReaderFromBlob(blob)
    expect(reader.size).toBe(50)
    expect([...(await reader.readRange(10, 14))]).toEqual([10, 11, 12, 13])
    await expect(reader.readRange(40, 51)).rejects.toThrow()
  })
})

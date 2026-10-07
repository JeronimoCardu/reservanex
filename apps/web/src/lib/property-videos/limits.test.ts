import { describe, expect, it } from 'vitest'
import {
  ALLOWED_VIDEO_MIME_TYPES,
  LEGACY_VIDEO_UPLOAD_MAX_BYTES,
  LEGACY_VIDEO_UPLOAD_MAX_LABEL,
  MAX_PROPERTY_VIDEOS,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_SIZE_BYTES,
  MAX_VIDEO_SIZE_LABEL,
  VIDEO_EXTENSION_BY_MIME,
  VIDEO_FILE_INPUT_ACCEPT,
  VIDEO_LIMIT_MESSAGES,
  isAllowedVideoMimeType,
  videoExtensionForMime,
} from './limits'

// Property Videos Fase 2A — límites canónicos. 50 MB = Global file size limit
// de Supabase Free; ningún texto vuelve a prometer 80 MB.

describe('límites canónicos de videos de propiedad', () => {
  it('50 MB (MiB, como el global de Supabase: 52 428 800 bytes), 60 s, 2 videos', () => {
    expect(MAX_VIDEO_SIZE_BYTES).toBe(52_428_800)
    expect(MAX_VIDEO_SIZE_LABEL).toBe('50 MB')
    expect(MAX_VIDEO_DURATION_SECONDS).toBe(60)
    expect(MAX_PROPERTY_VIDEOS).toBe(2)
  })

  it('MIME permitidos: los mismos tres de siempre', () => {
    expect([...ALLOWED_VIDEO_MIME_TYPES]).toEqual(['video/mp4', 'video/webm', 'video/quicktime'])
  })

  it('mapping MIME → extensión decidido por el servidor', () => {
    expect(VIDEO_EXTENSION_BY_MIME).toEqual({ 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' })
    for (const mime of ALLOWED_VIDEO_MIME_TYPES) expect(videoExtensionForMime(mime)).toBe(VIDEO_EXTENSION_BY_MIME[mime])
  })

  it.each([
    ['video/mp4', true],
    ['video/webm', true],
    ['video/quicktime', true],
    ['video/x-matroska', false],
    ['video/MP4', false],
    [' video/mp4', false],
    ['image/png', false],
    ['', false],
    ['toString', false],
    ['__proto__', false],
    [undefined, false],
    [42, false],
  ])('isAllowedVideoMimeType(%j) → %s', (value, expected) => {
    expect(isAllowedVideoMimeType(value)).toBe(expected)
  })

  it('accept del input: los MIME + .mov', () => {
    expect(VIDEO_FILE_INPUT_ACCEPT).toBe('video/mp4,video/webm,video/quicktime,.mov')
  })

  it('los mensajes salen de las constantes (50 MB / 4 MB / 60 s), nunca 80 MB', () => {
    expect(VIDEO_LIMIT_MESSAGES.tooLarge).toBe('El video no puede superar 50 MB.')
    expect(VIDEO_LIMIT_MESSAGES.legacyTooLarge).toBe('Por ahora el video no puede superar 4 MB.')
    expect(VIDEO_LIMIT_MESSAGES.tooLong).toBe('El video no puede superar 60 segundos.')
    expect(JSON.stringify(VIDEO_LIMIT_MESSAGES)).not.toMatch(/80/)
  })
})

describe('transporte legacy (TEMPORAL) vs límite final: conceptos distintos', () => {
  // Vercel corta el body de un request en 4,5 MB; se toma la lectura más
  // estricta (4 500 000 bytes) para el margen.
  const VERCEL_BODY_LIMIT_BYTES = 4_500_000

  it('legacy = 4 MiB (4 194 304 bytes), "4 MB" en la UI', () => {
    expect(LEGACY_VIDEO_UPLOAD_MAX_BYTES).toBe(4_194_304)
    expect(LEGACY_VIDEO_UPLOAD_MAX_LABEL).toBe('4 MB')
  })

  it('final/storage = 50 MiB (52 428 800 bytes): no cambia por el legacy', () => {
    expect(MAX_VIDEO_SIZE_BYTES).toBe(52_428_800)
    expect(MAX_VIDEO_SIZE_LABEL).toBe('50 MB')
  })

  it('son valores distintos y el legacy es el más chico', () => {
    expect(LEGACY_VIDEO_UPLOAD_MAX_BYTES).not.toBe(MAX_VIDEO_SIZE_BYTES)
    expect(LEGACY_VIDEO_UPLOAD_MAX_BYTES).toBeLessThan(MAX_VIDEO_SIZE_BYTES)
  })

  it('el legacy deja al menos 256 KiB de margen bajo el tope de Vercel para el multipart', () => {
    expect(VERCEL_BODY_LIMIT_BYTES - LEGACY_VIDEO_UPLOAD_MAX_BYTES).toBeGreaterThanOrEqual(256 * 1024)
  })

  it('un archivo de 4 MiB + 1 byte excede el legacy pero entra en el final', () => {
    const size = LEGACY_VIDEO_UPLOAD_MAX_BYTES + 1
    expect(size > LEGACY_VIDEO_UPLOAD_MAX_BYTES).toBe(true)
    expect(size <= MAX_VIDEO_SIZE_BYTES).toBe(true)
  })
})

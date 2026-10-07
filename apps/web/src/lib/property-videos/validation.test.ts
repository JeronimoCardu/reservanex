import { describe, expect, it } from 'vitest'
import { LEGACY_VIDEO_UPLOAD_MAX_BYTES, MAX_VIDEO_SIZE_BYTES } from './limits'
import { rangeReaderFromBytes } from './range-reader'
import {
  checkInspectionAgainstMime,
  checkVideoDeclaration,
  checkVideoDuration,
  verifyStoredVideo,
  videoRejectionMessage,
  type VideoRejectionCode,
} from './validation'
import { concat, ftyp, mdat, moov, mp4, mvhdV0, spyReader, virtualReader, webm } from '@/testing/video-fixtures'

// Property Videos Fase 2A — validaciones puras con las reglas canónicas.

describe('checkVideoDeclaration — tamaño, MIME y extensión', () => {
  it('50 MB exactos → permitido', () => {
    expect(checkVideoDeclaration({ sizeBytes: MAX_VIDEO_SIZE_BYTES, mimeType: 'video/mp4' })).toEqual({ ok: true, mimeType: 'video/mp4', extension: 'mp4' })
  })

  it('usa el límite final, no el del transporte legacy: 4 MiB + 1 byte → permitido', () => {
    expect(checkVideoDeclaration({ sizeBytes: LEGACY_VIDEO_UPLOAD_MAX_BYTES + 1, mimeType: 'video/mp4' })).toMatchObject({ ok: true })
  })

  it('50 MB + 1 byte → file_too_large', () => {
    expect(checkVideoDeclaration({ sizeBytes: MAX_VIDEO_SIZE_BYTES + 1, mimeType: 'video/mp4' })).toEqual({ ok: false, code: 'file_too_large' })
  })

  it.each([
    [0, 'empty_file'],
    [-1, 'invalid_size'],
    [1.5, 'invalid_size'],
    [Number.NaN, 'invalid_size'],
    [Number.POSITIVE_INFINITY, 'invalid_size'],
  ])('tamaño %s → %s', (sizeBytes, code) => {
    expect(checkVideoDeclaration({ sizeBytes, mimeType: 'video/mp4' })).toEqual({ ok: false, code })
  })

  it.each(['video/x-matroska', 'video/MP4', 'image/png', 'application/octet-stream', ''])('MIME %j → mime_not_allowed', (mimeType) => {
    expect(checkVideoDeclaration({ sizeBytes: 1000, mimeType })).toEqual({ ok: false, code: 'mime_not_allowed' })
  })

  it('la extensión sale del MIME (el nombre del archivo no participa)', () => {
    expect(checkVideoDeclaration({ sizeBytes: 1000, mimeType: 'video/quicktime' })).toMatchObject({ extension: 'mov' })
    expect(checkVideoDeclaration({ sizeBytes: 1000, mimeType: 'video/webm' })).toMatchObject({ extension: 'webm' })
  })
})

describe('checkVideoDuration — finita, > 0 y ≤ 60', () => {
  it.each([0.04, 1, 59.999, 60])('%s s → ok', (s) => {
    expect(checkVideoDuration(s)).toEqual({ ok: true, durationSeconds: s })
  })

  it.each([60.001, 61, 3600])('%s s → duration_too_long', (s) => {
    expect(checkVideoDuration(s)).toEqual({ ok: false, code: 'duration_too_long' })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('%s → duration_invalid', (s) => {
    expect(checkVideoDuration(s)).toEqual({ ok: false, code: 'duration_invalid' })
  })
})

describe('verifyStoredVideo — contenido + MIME + duración', () => {
  const verify = (bytes: Uint8Array, declaredMimeType: string) =>
    verifyStoredVideo({ reader: rangeReaderFromBytes(bytes), declaredMimeType })

  it('MP4 válido de 30 s declarado como MP4 → ok', async () => {
    expect(await verify(mp4({ seconds: 30 }), 'video/mp4')).toEqual({
      ok: true, mimeType: 'video/mp4', extension: 'mp4', container: 'mp4', durationSeconds: 30,
    })
  })

  it('MOV válido declarado como quicktime → ok con extensión mov', async () => {
    expect(await verify(mp4({ seconds: 10, brand: 'qt  ' }), 'video/quicktime')).toMatchObject({ ok: true, extension: 'mov', container: 'quicktime' })
  })

  it('misma familia ISO-BMFF cruzada (MP4 declarado quicktime y al revés) → ok', async () => {
    expect(await verify(mp4({ seconds: 10 }), 'video/quicktime')).toMatchObject({ ok: true, extension: 'mov' })
    expect(await verify(mp4({ seconds: 10, brand: 'qt  ' }), 'video/mp4')).toMatchObject({ ok: true, extension: 'mp4' })
  })

  it('WebM con duración declarado como WebM → ok', async () => {
    expect(await verify(webm({ durationMs: 20_000 }), 'video/webm')).toMatchObject({ ok: true, extension: 'webm', durationSeconds: 20 })
  })

  it('MP4 declarado pero bytes WebM → content_mismatch', async () => {
    expect(await verify(webm(), 'video/mp4')).toEqual({ ok: false, code: 'content_mismatch' })
  })

  it('WebM declarado pero bytes MP4 → content_mismatch', async () => {
    expect(await verify(mp4(), 'video/webm')).toEqual({ ok: false, code: 'content_mismatch' })
  })

  it('WebM declarado con bytes MP4 rotos sigue siendo content_mismatch', async () => {
    expect(await verify(concat(ftyp(), mdat()), 'video/webm')).toEqual({ ok: false, code: 'content_mismatch' })
  })

  it('Matroska genérico declarado como WebM → content_mismatch', async () => {
    expect(await verify(webm({ docType: 'matroska' }), 'video/webm')).toEqual({ ok: false, code: 'content_mismatch' })
  })

  it('archivo basura → unrecognized_container', async () => {
    expect(await verify(Uint8Array.from({ length: 512 }, (_, i) => (i * 97) % 256), 'video/mp4')).toEqual({ ok: false, code: 'unrecognized_container' })
  })

  it('duración > 60 → duration_too_long', async () => {
    expect(await verify(mp4({ seconds: 61 }), 'video/mp4')).toEqual({ ok: false, code: 'duration_too_long' })
    expect(await verify(webm({ durationMs: 61_000 }), 'video/webm')).toEqual({ ok: false, code: 'duration_too_long' })
  })

  it('duración no disponible → duration_unavailable (WebM sin Duration, MediaRecorder, MP4 fragmentado)', async () => {
    expect(await verify(webm({ durationMs: null }), 'video/webm')).toEqual({ ok: false, code: 'duration_unavailable' })
    expect(await verify(webm({ mediaRecorder: true }), 'video/webm')).toEqual({ ok: false, code: 'duration_unavailable' })
    expect(await verify(concat(ftyp(), moov(mvhdV0(1000, 0)), mdat()), 'video/mp4')).toEqual({ ok: false, code: 'duration_unavailable' })
  })

  it('archivo truncado → truncated_container', async () => {
    const full = mp4({ seconds: 30, moovFirst: false })
    expect(await verify(full.subarray(0, full.length - 50), 'video/mp4')).toEqual({ ok: false, code: 'truncated_container' })
  })

  it('timescale inválido → invalid_timescale', async () => {
    expect(await verify(concat(ftyp(), moov(mvhdV0(0, 30_000)), mdat()), 'video/mp4')).toEqual({ ok: false, code: 'invalid_timescale' })
  })

  it('objeto de más de 50 MB → file_too_large SIN leer un byte', async () => {
    const reader = spyReader(virtualReader(MAX_VIDEO_SIZE_BYTES + 1, [{ at: 0, bytes: mp4() }]))
    expect(await verifyStoredVideo({ reader, declaredMimeType: 'video/mp4' })).toEqual({ ok: false, code: 'file_too_large' })
    expect(reader.calls).toHaveLength(0)
  })

  it('objeto de 50 MB exactos se inspecciona leyendo sólo rangos chicos', async () => {
    const head = mp4({ seconds: 25 })
    const reader = spyReader(virtualReader(MAX_VIDEO_SIZE_BYTES, [{ at: 0, bytes: head }]))
    // moov va al principio: el resto del "archivo" virtual nunca se recorre.
    const result = await verifyStoredVideo({ reader, declaredMimeType: 'video/mp4' })
    expect(result).toMatchObject({ ok: true, durationSeconds: 25 })
    expect(reader.bytesRead()).toBeLessThanOrEqual(64 * 1024)
  })

  it('MIME no permitido → mime_not_allowed sin inspeccionar', async () => {
    const reader = spyReader(rangeReaderFromBytes(mp4()))
    expect(await verifyStoredVideo({ reader, declaredMimeType: 'video/x-msvideo' })).toEqual({ ok: false, code: 'mime_not_allowed' })
    expect(reader.calls).toHaveLength(0)
  })

  it('checkInspectionAgainstMime: la familia se chequea aunque la inspección haya fallado', () => {
    expect(checkInspectionAgainstMime('video/mp4', { ok: false, family: 'ebml', reason: 'duration_unavailable' })).toEqual({ ok: false, code: 'content_mismatch' })
    expect(checkInspectionAgainstMime('video/webm', { ok: false, family: 'ebml', reason: 'duration_unavailable' })).toEqual({ ok: false, code: 'duration_unavailable' })
  })
})

describe('videoRejectionMessage', () => {
  const codes: VideoRejectionCode[] = [
    'invalid_size', 'empty_file', 'file_too_large', 'mime_not_allowed', 'content_mismatch', 'unrecognized_container',
    'truncated_container', 'malformed_container', 'invalid_timescale', 'duration_unavailable', 'duration_invalid',
    'duration_too_long', 'inspection_budget_exceeded', 'read_failed',
  ]

  it('todo código tiene mensaje en español, sin detalles internos', () => {
    for (const code of codes) {
      const message = videoRejectionMessage(code)
      expect(message.length).toBeGreaterThan(10)
      expect(message).not.toMatch(/token|storage|path|offset|mvhd|ebml|_/i)
    }
  })

  it('los límites salen de las constantes', () => {
    expect(videoRejectionMessage('file_too_large')).toBe('El video no puede superar 50 MB.')
    expect(videoRejectionMessage('duration_too_long')).toBe('El video no puede superar 60 segundos.')
  })
})

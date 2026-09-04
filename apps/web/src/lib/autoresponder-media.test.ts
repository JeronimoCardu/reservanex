import { describe, expect, it } from 'vitest'
import {
  isMediaType,
  isValidEventId,
  isAllowedMimeType,
  isWithinSizeLimit,
  matchesFileSignature,
  buildMediaStoragePath,
  sanitizeUploadFilename,
  MAX_BYTES,
} from './autoresponder-media'

describe('isValidEventId (Fase 7 Parte B)', () => {
  it('accepts a real UUID', () => {
    expect(isValidEventId('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true)
  })

  it('accepts an uppercase UUID (case-insensitive)', () => {
    expect(isValidEventId('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')).toBe(true)
  })

  it('rejects the exact non-UUID value observed physically during Fase 6 ("manual-image-test")', () => {
    expect(isValidEventId('manual-image-test')).toBe(false)
  })

  it('rejects null/undefined/empty', () => {
    expect(isValidEventId(null)).toBe(false)
    expect(isValidEventId(undefined)).toBe(false)
    expect(isValidEventId('')).toBe(false)
  })

  it('rejects a near-miss (wrong segment lengths, missing dashes)', () => {
    expect(isValidEventId('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1')).toBe(false)  // one char short
    expect(isValidEventId('a0eebc999c0b4ef8bb6d6bb9bd380a11')).toBe(false)     // no dashes
  })
})

describe('isMediaType', () => {
  it('accepts audio/image/document', () => {
    expect(isMediaType('audio')).toBe(true)
    expect(isMediaType('image')).toBe(true)
    expect(isMediaType('document')).toBe(true)
  })

  it('rejects anything else, including null/undefined', () => {
    expect(isMediaType('video')).toBe(false)
    expect(isMediaType(null)).toBe(false)
    expect(isMediaType(undefined)).toBe(false)
    expect(isMediaType('')).toBe(false)
  })
})

describe('isAllowedMimeType (9-12. MIME allowlist)', () => {
  it('9. audio/ogg is accepted for audio', () => {
    expect(isAllowedMimeType('audio', 'audio/ogg')).toBe(true)
  })

  it('accepts application/ogg for audio too (documented Android/OkHttp variation)', () => {
    expect(isAllowedMimeType('audio', 'application/ogg')).toBe(true)
  })

  it('10. image/jpeg is accepted for image', () => {
    expect(isAllowedMimeType('image', 'image/jpeg')).toBe(true)
  })

  it('11. application/pdf is accepted for document', () => {
    expect(isAllowedMimeType('document', 'application/pdf')).toBe(true)
  })

  it('12. a disallowed MIME is rejected, including cross-type mismatches', () => {
    expect(isAllowedMimeType('image', 'image/png')).toBe(false)
    expect(isAllowedMimeType('document', 'application/x-msdownload')).toBe(false)
    expect(isAllowedMimeType('audio', 'video/mp4')).toBe(false)
  })

  it('ignores Content-Type parameters (e.g. "; codecs=opus")', () => {
    expect(isAllowedMimeType('audio', 'audio/ogg; codecs=opus')).toBe(true)
  })
})

describe('isWithinSizeLimit (13. tamaño demasiado grande rechazado)', () => {
  it('accepts a file within the limit', () => {
    expect(isWithinSizeLimit('image', 1024)).toBe(true)
  })

  it('rejects a file over the limit', () => {
    expect(isWithinSizeLimit('image', MAX_BYTES.image + 1)).toBe(false)
  })

  it('rejects an empty (0-byte) file', () => {
    expect(isWithinSizeLimit('audio', 0)).toBe(false)
  })

  it('accepts exactly the limit', () => {
    expect(isWithinSizeLimit('document', MAX_BYTES.document)).toBe(true)
  })
})

describe('matchesFileSignature (Fase 6B.1 — magic bytes)', () => {
  const realPdf   = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj', 'binary')
  const fakePdf   = Buffer.from('this is not a pdf at all, just text claiming to be one')
  const realJpeg  = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  const fakeJpeg  = Buffer.from('GIF89a-this-is-actually-a-gif-pretending-to-be-jpeg')
  const realOgg   = Buffer.concat([Buffer.from('OggS'), Buffer.from([0x00, 0x02, 0x00, 0x00])])
  const fakeOgg   = Buffer.from('RIFF-this-is-actually-a-wav-pretending-to-be-ogg')

  it('PDF real / firma válida aceptado', () => {
    expect(matchesFileSignature('document', realPdf)).toBe(true)
  })

  it('PDF MIME con bytes falsos rechazado', () => {
    expect(matchesFileSignature('document', fakePdf)).toBe(false)
  })

  it('JPEG válido aceptado', () => {
    expect(matchesFileSignature('image', realJpeg)).toBe(true)
  })

  it('JPEG MIME con bytes falsos rechazado', () => {
    expect(matchesFileSignature('image', fakeJpeg)).toBe(false)
  })

  it('OGG válido aceptado', () => {
    expect(matchesFileSignature('audio', realOgg)).toBe(true)
  })

  it('OGG MIME con bytes falsos rechazado', () => {
    expect(matchesFileSignature('audio', fakeOgg)).toBe(false)
  })

  it('rejects a buffer shorter than the expected signature instead of throwing', () => {
    expect(matchesFileSignature('document', Buffer.from('%PD'))).toBe(false)
    expect(matchesFileSignature('image', Buffer.from([0xff]))).toBe(false)
    expect(matchesFileSignature('audio', Buffer.from('Og'))).toBe(false)
    expect(matchesFileSignature('document', Buffer.alloc(0))).toBe(false)
  })
})

describe('buildMediaStoragePath (14. path seguro)', () => {
  it('builds {tenant_id}/{conversation_id}/{message_id}.{ext} — same convention as Meta media', () => {
    const path = buildMediaStoragePath('tenant-1', 'conv-1', 'msg-1', 'image/jpeg')
    expect(path).toBe('tenant-1/conv-1/msg-1.jpg')
  })

  it('never incorporates any user-controlled filename — only IDs and MIME-derived extension', () => {
    const path = buildMediaStoragePath('tenant-1', 'conv-1', 'msg-1', 'application/pdf')
    expect(path).toBe('tenant-1/conv-1/msg-1.pdf')
    expect(path).not.toContain('..')
  })
})

describe('sanitizeUploadFilename (15/16. filename sanitizado, path traversal neutralizado)', () => {
  it('15. preserves a normal filename unchanged', () => {
    expect(sanitizeUploadFilename('JeronimoCarduCV_2026.pdf')).toBe('JeronimoCarduCV_2026.pdf')
  })

  it('16. strips path separators', () => {
    const result = sanitizeUploadFilename('../../etc/passwd')
    expect(result).not.toMatch(/[/\\]/)
  })

  it('16. neutralizes path traversal sequences', () => {
    const result = sanitizeUploadFilename('..\\..\\Contrato.pdf')
    expect(result).not.toContain('..')
  })

  it('never returns an empty string', () => {
    expect(sanitizeUploadFilename('')).toBe('documento')
    expect(sanitizeUploadFilename('   ')).toBe('documento')
  })

  it('strips control characters', () => {
    const result = sanitizeUploadFilename('Contrato\x00.pdf')
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/[\x00-\x1f\x7f]/)
  })
})

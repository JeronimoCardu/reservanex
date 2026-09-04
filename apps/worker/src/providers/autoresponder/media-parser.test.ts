import { describe, expect, it } from 'vitest'
import { classifyAutoResponderMessage, sanitizeDisplayFilename } from './media-parser'

describe('classifyAutoResponderMessage', () => {
  it('1. "🎤 Voice message (0:03)" → audio, duration extracted in seconds', () => {
    const result = classifyAutoResponderMessage('🎤 Voice message (0:03)')
    expect(result).toEqual({ type: 'audio', durationSeconds: 3 })
  })

  it('extracts minutes correctly (1:05 → 65s)', () => {
    const result = classifyAutoResponderMessage('🎤 Voice message (1:05)')
    expect(result).toEqual({ type: 'audio', durationSeconds: 65 })
  })

  it('2. "📷 Photo" → image', () => {
    expect(classifyAutoResponderMessage('📷 Photo')).toEqual({ type: 'image' })
  })

  it('3. real observed PDF placeholder → document + exact filename + pages', () => {
    const result = classifyAutoResponderMessage('📄 JeronimoCarduCV_2026.pdf (2 pages)')
    expect(result).toEqual({ type: 'document', filename: 'JeronimoCarduCV_2026.pdf', pages: 2 })
  })

  it('document placeholder with a single page ("1 page", no trailing s)', () => {
    const result = classifyAutoResponderMessage('📄 Contrato.pdf (1 page)')
    expect(result).toEqual({ type: 'document', filename: 'Contrato.pdf', pages: 1 })
  })

  it('4. an ordinary customer text message is still classified as text', () => {
    expect(classifyAutoResponderMessage('Hola, quiero info sobre el depto de Palermo')).toEqual({ type: 'text' })
  })

  it('does not misclassify text that merely mentions an emoji', () => {
    expect(classifyAutoResponderMessage('Te mando una foto 📷 en un rato')).toEqual({ type: 'text' })
  })

  it('an unrecognized/future AutoResponder format falls back to text rather than guessing', () => {
    expect(classifyAutoResponderMessage('🎥 Video (0:12)')).toEqual({ type: 'text' })
  })

  it('a malformed document placeholder with no filename falls back to text', () => {
    expect(classifyAutoResponderMessage('📄  (2 pages)')).toEqual({ type: 'text' })
  })
})

describe('classifyAutoResponderMessage — Fase 7 Parte C (optional page count + extension gating)', () => {
  it('📄 contrato.pdf (2 pages) → document, pages=2 (unchanged contract)', () => {
    expect(classifyAutoResponderMessage('📄 contrato.pdf (2 pages)')).toEqual({ type: 'document', filename: 'contrato.pdf', pages: 2 })
  })

  it('📄 contrato.pdf (1 page) → document, pages=1 (unchanged contract, singular)', () => {
    expect(classifyAutoResponderMessage('📄 contrato.pdf (1 page)')).toEqual({ type: 'document', filename: 'contrato.pdf', pages: 1 })
  })

  it('📄 contrato.pdf (no page-count suffix) → document, pages=null — the current transport (PDF MIME + magic bytes) fully supports it', () => {
    expect(classifyAutoResponderMessage('📄 contrato.pdf')).toEqual({ type: 'document', filename: 'contrato.pdf', pages: null })
  })

  it('📄 pc.jpeg → text, explicitly — the real physical placeholder observed in Fase 6; a JPEG-as-document media_event would be created for an upload the server is guaranteed to reject (415)', () => {
    expect(classifyAutoResponderMessage('📄 pc.jpeg')).toEqual({ type: 'text' })
  })

  it('an unsupported extension with an explicit page count also falls back to text (extension gate applies to both branches)', () => {
    expect(classifyAutoResponderMessage('📄 escaneo.png (3 pages)')).toEqual({ type: 'text' })
  })

  it('📄 alone (no filename at all) → text, never an empty-filename document', () => {
    expect(classifyAutoResponderMessage('📄')).toEqual({ type: 'text' })
    expect(classifyAutoResponderMessage('📄   ')).toEqual({ type: 'text' })
  })

  it('ordinary text without the document emoji is unaffected', () => {
    expect(classifyAutoResponderMessage('Hola, te mando el contrato en un rato')).toEqual({ type: 'text' })
  })

  it('extension check is case-insensitive (.PDF accepted)', () => {
    expect(classifyAutoResponderMessage('📄 Contrato.PDF')).toEqual({ type: 'document', filename: 'Contrato.PDF', pages: null })
  })
})

describe('sanitizeDisplayFilename', () => {
  it('strips path separators', () => {
    expect(sanitizeDisplayFilename('../../etc/passwd')).not.toMatch(/[/\\]/)
  })

  it('neutralizes path traversal sequences', () => {
    const result = sanitizeDisplayFilename('..\\..\\Contrato.pdf')
    expect(result).not.toContain('..')
  })

  it('preserves a normal filename unchanged', () => {
    expect(sanitizeDisplayFilename('JeronimoCarduCV_2026.pdf')).toBe('JeronimoCarduCV_2026.pdf')
  })

  it('never returns an empty string', () => {
    expect(sanitizeDisplayFilename('')).toBe('archivo')
    expect(sanitizeDisplayFilename('   ')).toBe('archivo')
  })
})

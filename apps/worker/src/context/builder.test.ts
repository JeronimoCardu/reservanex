import { describe, expect, it } from 'vitest'
import { extractMessage } from './builder'

// Minimal Meta Cloud API webhook envelope — same shape the real webhook
// route inserts verbatim into message_queue.raw_payload.
function makePayload(msg: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID',
      changes: [{ field: 'messages', value: { messages: [msg] } }],
    }],
  }
}

describe('extractMessage', () => {
  it('extracts a plain text message', () => {
    const result = extractMessage(makePayload({
      from: '5491100000000', id: 'wamid.TEXT1', type: 'text',
      text: { body: 'Hola, busco un depto' },
    }))

    expect(result.from).toBe('5491100000000')
    expect(result.whatsappMessageId).toBe('wamid.TEXT1')
    expect(result.messageType).toBe('text')
    expect(result.messageText).toBe('Hola, busco un depto')
    expect(result.mediaExtract).toBeNull()
  })

  it('extracts an image with a caption', () => {
    const result = extractMessage(makePayload({
      from: '5491100000000', id: 'wamid.IMG1', type: 'image',
      image: { id: 'media123', mime_type: 'image/jpeg', sha256: 'abc', caption: 'Living room' },
    }))

    expect(result.messageType).toBe('image')
    expect(result.messageText).toBe('[Imagen recibida. El equipo puede verla en el CRM.]\nCaption: Living room')
    expect(result.mediaExtract).toEqual({
      type: 'image', mediaId: 'media123', mimeType: 'image/jpeg',
      filename: null, sha256: 'abc', caption: 'Living room',
    })
  })

  it('extracts an image without a caption', () => {
    const result = extractMessage(makePayload({
      from: '5491100000000', id: 'wamid.IMG2', type: 'image',
      image: { id: 'media456', mime_type: 'image/png' },
    }))

    expect(result.messageText).toBe('[Imagen recibida. El equipo puede verla en el CRM.]')
    expect(result.mediaExtract?.caption).toBeNull()
  })

  it('extracts an audio message (no filename/caption, fixed placeholder text)', () => {
    const result = extractMessage(makePayload({
      from: '5491100000000', id: 'wamid.AUD1', type: 'audio',
      audio: { id: 'media789', mime_type: 'audio/ogg; codecs=opus' },
    }))

    expect(result.messageType).toBe('audio')
    expect(result.messageText).toBe('[Audio recibido. Transcribiendo...]')
    expect(result.mediaExtract).toEqual({
      type: 'audio', mediaId: 'media789', mimeType: 'audio/ogg; codecs=opus',
      filename: null, sha256: null, caption: null,
    })
  })

  it('extracts a document with filename and caption', () => {
    const result = extractMessage(makePayload({
      from: '5491100000000', id: 'wamid.DOC1', type: 'document',
      document: { id: 'media321', mime_type: 'application/pdf', filename: 'contrato.pdf', caption: 'Contrato' },
    }))

    expect(result.messageText).toBe('[Documento recibido: contrato.pdf. El equipo puede verlo en el CRM.]\nCaption: Contrato')
    expect(result.mediaExtract?.filename).toBe('contrato.pdf')
  })

  it('extracts a document without a filename', () => {
    const result = extractMessage(makePayload({
      from: '5491100000000', id: 'wamid.DOC2', type: 'document',
      document: { id: 'media654', mime_type: 'application/pdf' },
    }))

    expect(result.messageText).toBe('[Documento recibido. El equipo puede verlo en el CRM.]')
  })

  it('falls back to a bracketed type label for unsupported message types', () => {
    const result = extractMessage(makePayload({
      from: '5491100000000', id: 'wamid.LOC1', type: 'location',
      location: { latitude: 0, longitude: 0 },
    }))

    expect(result.messageText).toBe('[location]')
    expect(result.mediaExtract).toBeNull()
  })

  it('leaves mediaExtract null when the media object has no id', () => {
    const result = extractMessage(makePayload({
      from: '5491100000000', id: 'wamid.IMG3', type: 'image',
      image: { mime_type: 'image/jpeg' },
    }))

    expect(result.mediaExtract).toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMacroDroidUrl, dispatchToMacroDroid, buildMacroDroidMediaTriggerUrl, dispatchMediaTriggerToMacroDroid } from './outbound'

const OUTBOX_ID = '11111111-2222-4333-8444-555555555555'

describe('buildMacroDroidUrl', () => {
  it('builds rn_action=outbound, rn_phone, rn_message and rn_outbox_id as query params on the given webhook URL', () => {
    const url = buildMacroDroidUrl('https://trigger.macrodroid.com/abc-123/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
    expect(url.origin + url.pathname).toBe('https://trigger.macrodroid.com/abc-123/reservanex')
    expect(url.searchParams.get('rn_action')).toBe('outbound')
    expect(url.searchParams.get('rn_phone')).toBe('5492325471890')
    expect(url.searchParams.get('rn_message')).toBe('Hola')
    expect(url.searchParams.get('rn_outbox_id')).toBe(OUTBOX_ID)
  })

  it('never omits rn_action — the macro must always be able to discriminate the branch', () => {
    const url = buildMacroDroidUrl('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
    expect(url.searchParams.has('rn_action')).toBe(true)
  })

  it('never includes a tenant id or tenant name — only the outbox id, which the device token already scopes at auth time', () => {
    const url = buildMacroDroidUrl('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
    expect(url.searchParams.has('tenant_id')).toBe(false)
    expect(url.searchParams.has('tenant_name')).toBe(false)
    expect(url.searchParams.has('rn_tenant_id')).toBe(false)
  })

  it('encodes spaces, accents, ñ, punctuation and newlines correctly', () => {
    const message = 'Hola! ¿Cómo estás? Mañana a las 18:00.\nSaludos, José.'
    const url = buildMacroDroidUrl('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', message, OUTBOX_ID)

    // Round-trips exactly through URLSearchParams — this is what matters,
    // not any particular percent-encoding scheme.
    expect(url.searchParams.get('rn_message')).toBe(message)

    // The raw query string must actually be percent-encoded (no literal
    // spaces/newlines sitting unescaped in the URL).
    expect(url.search).not.toContain(' ')
    expect(url.search).not.toContain('\n')
  })

  it('encodes a bare "+" and "&" in the message without corrupting other params', () => {
    const url = buildMacroDroidUrl('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'A & B + C', OUTBOX_ID)
    expect(url.searchParams.get('rn_message')).toBe('A & B + C')
    expect(url.searchParams.get('rn_phone')).toBe('5492325471890')
    expect(url.searchParams.get('rn_outbox_id')).toBe(OUTBOX_ID)
  })
})

describe('buildMacroDroidMediaTriggerUrl', () => {
  it('always sets rn_action=media — never rn_action=outbound, regardless of media type', () => {
    const url = buildMacroDroidMediaTriggerUrl('https://trigger.macrodroid.com/abc/reservanex', 'evt-1', 'audio')
    expect(url.searchParams.get('rn_action')).toBe('media')
  })

  it('audio/image: sets rn_event_id and rn_media_type, no rn_filename', () => {
    const url = buildMacroDroidMediaTriggerUrl('https://trigger.macrodroid.com/abc/reservanex', 'evt-1', 'audio')
    expect(url.searchParams.get('rn_event_id')).toBe('evt-1')
    expect(url.searchParams.get('rn_media_type')).toBe('audio')
    expect(url.searchParams.has('rn_filename')).toBe(false)

    const imageUrl = buildMacroDroidMediaTriggerUrl('https://trigger.macrodroid.com/abc/reservanex', 'evt-2', 'image')
    expect(imageUrl.searchParams.get('rn_media_type')).toBe('image')
    expect(imageUrl.searchParams.has('rn_filename')).toBe(false)
  })

  it('document: also sets rn_filename', () => {
    const url = buildMacroDroidMediaTriggerUrl('https://trigger.macrodroid.com/abc/reservanex', 'evt-3', 'document', 'Contrato.pdf')
    expect(url.searchParams.get('rn_event_id')).toBe('evt-3')
    expect(url.searchParams.get('rn_media_type')).toBe('document')
    expect(url.searchParams.get('rn_filename')).toBe('Contrato.pdf')
  })

  it('document without a filename omits rn_filename rather than sending an empty param', () => {
    const url = buildMacroDroidMediaTriggerUrl('https://trigger.macrodroid.com/abc/reservanex', 'evt-4', 'document', null)
    expect(url.searchParams.has('rn_filename')).toBe(false)
  })

  it('never carries rn_outbox_id — that param belongs only to the outbound (text) branch', () => {
    const url = buildMacroDroidMediaTriggerUrl('https://trigger.macrodroid.com/abc/reservanex', 'evt-1', 'audio')
    expect(url.searchParams.has('rn_outbox_id')).toBe(false)
  })
})

describe('rn_action discriminator — cross-branch safety (Fase 6B.1 §2)', () => {
  it('an outbound URL never carries rn_media_type/rn_event_id, and a media URL never carries rn_phone/rn_message', () => {
    const outboundUrl = buildMacroDroidUrl('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
    expect(outboundUrl.searchParams.has('rn_media_type')).toBe(false)
    expect(outboundUrl.searchParams.has('rn_event_id')).toBe(false)

    const mediaUrl = buildMacroDroidMediaTriggerUrl('https://trigger.macrodroid.com/abc/reservanex', 'evt-1', 'image')
    expect(mediaUrl.searchParams.has('rn_phone')).toBe(false)
    expect(mediaUrl.searchParams.has('rn_message')).toBe(false)
  })

  it('outbound and media URLs always disagree on rn_action', () => {
    const outboundUrl = buildMacroDroidUrl('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
    const mediaUrl = buildMacroDroidMediaTriggerUrl('https://trigger.macrodroid.com/abc/reservanex', 'evt-1', 'audio')
    expect(outboundUrl.searchParams.get('rn_action')).not.toBe(mediaUrl.searchParams.get('rn_action'))
  })
})

describe('dispatchMediaTriggerToMacroDroid', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns dispatched on HTTP 200 "OK"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK', { status: 200 })))
    const result = await dispatchMediaTriggerToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', 'evt-1', 'audio')
    expect(result).toEqual({ status: 'dispatched' })
  })

  it('classifies HTTP error the same way as the text-send path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })))
    const result = await dispatchMediaTriggerToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', 'evt-1', 'image')
    expect(result).toEqual({ status: 'failed', error: 'http_500' })
  })
})

describe('dispatchToMacroDroid', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns dispatched when MacroDroid responds 200 with body "OK"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK', { status: 200 })))

    const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)

    expect(result).toEqual({ status: 'dispatched' })
  })

  it('sends rn_outbox_id on the actual request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(calledUrl.searchParams.get('rn_outbox_id')).toBe(OUTBOX_ID)
  })

  it('returns dispatched when the body has surrounding whitespace or different casing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(' ok\n', { status: 200 })))
    const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
    expect(result).toEqual({ status: 'dispatched' })
  })

  it('returns failed with a sanitized http_<status> error on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })))

    const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)

    expect(result).toEqual({ status: 'failed', error: 'http_500' })
  })

  it('returns failed with unexpected_response when the body is not "OK"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not Found', { status: 200 })))

    const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)

    expect(result).toEqual({ status: 'failed', error: 'unexpected_response' })
  })

  it('returns failed with "timeout" on an AbortError/timeout — and does not retry (single fetch call)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)

    expect(result).toEqual({ status: 'failed', error: 'timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns failed with "network_error" on a generic network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)

    expect(result).toEqual({ status: 'failed', error: 'network_error' })
  })

  it('never includes the webhook URL or message text in the returned error', async () => {
    const secretUrl = 'https://trigger.macrodroid.com/super-secret-id/reservanex'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`request to ${secretUrl} failed`)))

    const result = await dispatchToMacroDroid(secretUrl, '5492325471890', 'mensaje secreto del cliente', OUTBOX_ID)

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('super-secret-id')
    expect(serialized).not.toContain('mensaje secreto del cliente')
  })

  // Observability follow-up — a real physical E2E run produced a
  // 'network_error' with zero further detail anywhere. These cover the
  // allowlisted, low-level networkCode extraction from err.cause?.code.
  describe('networkCode (network_error observability)', () => {
    it('cause.code = ENOTFOUND is surfaced as networkCode', async () => {
      const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))

      const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)

      expect(result).toEqual({ status: 'failed', error: 'network_error', networkCode: 'ENOTFOUND' })
    })

    it('cause.code = ECONNRESET is surfaced as networkCode, and the result never carries the URL/hostname/query/token', async () => {
      const secretUrl = 'https://trigger.macrodroid.com/super-secret-id/reservanex'
      const err = Object.assign(new TypeError(`request to ${secretUrl} failed`), { cause: { code: 'ECONNRESET' } })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))

      const result = await dispatchToMacroDroid(secretUrl, '5492325471890', 'Hola', OUTBOX_ID)

      expect(result).toEqual({ status: 'failed', error: 'network_error', networkCode: 'ECONNRESET' })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('super-secret-id')
      expect(serialized).not.toContain('trigger.macrodroid.com')
    })

    it('a cause.code NOT on the allowlist is dropped rather than logged, even if it looks plausible', async () => {
      const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'SOME_UNEXPECTED_CODE' } })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))

      const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)

      expect(result).toEqual({ status: 'failed', error: 'network_error' })
      expect(result.networkCode).toBeUndefined()
    })

    it('an exception with no cause at all (or a non-object cause) never sets networkCode', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
      const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
      expect(result.networkCode).toBeUndefined()
    })

    it('a message/cause containing a URL or secret-like content never leaks into networkCode, even when code is absent', async () => {
      const secretUrl = 'https://trigger.macrodroid.com/super-secret-id/reservanex?token=abc123'
      const err = Object.assign(new TypeError(`request to ${secretUrl} failed`), { cause: { message: secretUrl } })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))

      const result = await dispatchToMacroDroid(secretUrl, '5492325471890', 'Hola', OUTBOX_ID)

      expect(result.networkCode).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('super-secret-id')
    })

    it('HTTP 4xx/5xx failures keep their existing http_<status> classification and never carry networkCode', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 503 })))
      const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
      expect(result).toEqual({ status: 'failed', error: 'http_503' })
      expect(result.networkCode).toBeUndefined()
    })

    it('a timeout keeps its existing "timeout" classification and never carries networkCode', async () => {
      const err = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError', cause: { code: 'ETIMEDOUT' } })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))
      const result = await dispatchToMacroDroid('https://trigger.macrodroid.com/abc/reservanex', '5492325471890', 'Hola', OUTBOX_ID)
      expect(result).toEqual({ status: 'failed', error: 'timeout' })
      expect(result.networkCode).toBeUndefined()
    })
  })
})

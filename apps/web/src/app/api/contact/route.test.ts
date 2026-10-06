import { beforeEach, describe, expect, it, vi } from 'vitest'

// Rate limiting Fase 1A — hardening de /api/contact. El sender está mockeado:
// ningún test manda un email real. Lo que importa es que cada rechazo ocurre
// ANTES de llegar a deliverContactSubmission. apps/marketing tiene la misma
// ruta (ver lib/http/public-post-guard-parity.test.ts).

vi.mock('@/lib/marketing/contact', () => ({ deliverContactSubmission: vi.fn() }))

import { deliverContactSubmission } from '@/lib/marketing/contact'
import { POST } from './route'

const URL_CONTACT = 'http://localhost:3001/api/contact'
const MAX_BODY_BYTES = 20_000

function contacto(overrides: Record<string, unknown> = {}) {
  return {
    name:           'Ana Pérez',
    company:        'Inmobiliaria Sur',
    country:        'Argentina',
    whatsapp:       '+54 9 11 5555-5555',
    email:          'ana@example.com',
    message:        'Quiero conocer ReservaNex para mi inmobiliaria.',
    acceptsPrivacy: true,
    ...overrides,
  }
}

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_CONTACT, {
    method:  'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(deliverContactSubmission).mockResolvedValue({ ok: true })
})

describe('POST /api/contact — hardening', () => {
  it('un contacto válido en application/json se envía una vez', async () => {
    const res = await POST(request(JSON.stringify(contacto())))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(deliverContactSubmission).toHaveBeenCalledTimes(1)
  })

  it('application/json; charset=utf-8 se acepta', async () => {
    const res = await POST(request(JSON.stringify(contacto()), { 'content-type': 'application/json; charset=utf-8' }))
    expect(res.status).toBe(200)
    expect(deliverContactSubmission).toHaveBeenCalledTimes(1)
  })

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    '%s → 415 y NO se envía nada',
    async (contentType) => {
      const req = request(JSON.stringify(contacto()), { 'content-type': contentType })
      const res = await POST(req)
      expect(res.status).toBe(415)
      expect(await res.json()).toEqual({ ok: false, reason: 'unsupported_media_type' })
      expect(req.bodyUsed).toBe(false)
      expect(deliverContactSubmission).not.toHaveBeenCalled()
    },
  )

  it('Sec-Fetch-Site: cross-site → 403 y NO se envía nada', async () => {
    const req = request(JSON.stringify(contacto()), { 'sec-fetch-site': 'cross-site' })
    const res = await POST(req)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: 'cross_site_request' })
    expect(req.bodyUsed).toBe(false)
    expect(deliverContactSubmission).not.toHaveBeenCalled()
  })

  it.each(['same-origin', 'same-site', 'none'])('Sec-Fetch-Site: %s está permitido', async (site) => {
    const res = await POST(request(JSON.stringify(contacto()), { 'sec-fetch-site': site }))
    expect(res.status).toBe(200)
    expect(deliverContactSubmission).toHaveBeenCalledTimes(1)
  })

  it('Content-Length > 20 000 → 413 sin leer el body y NO se envía nada', async () => {
    const req = request(JSON.stringify(contacto()), { 'content-length': String(MAX_BODY_BYTES + 1) })
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ ok: false, reason: 'payload_too_large' })
    expect(req.bodyUsed).toBe(false)
    expect(deliverContactSubmission).not.toHaveBeenCalled()
  })

  it('más de 20 000 bytes UTF-8 reales → 413 y NO se envía nada', async () => {
    const raw = JSON.stringify(contacto({ message: 'ñ'.repeat(10_500) }))
    expect(raw.length).toBeLessThan(MAX_BODY_BYTES)
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(MAX_BODY_BYTES)

    const res = await POST(request(raw))
    expect(res.status).toBe(413)
    expect(deliverContactSubmission).not.toHaveBeenCalled()
  })
})

describe('POST /api/contact — contrato previo intacto', () => {
  it('honeypot lleno: éxito falso y NO se envía nada', async () => {
    const res = await POST(request(JSON.stringify(contacto({ company_website: 'http://spam.example' }))))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(deliverContactSubmission).not.toHaveBeenCalled()
  })

  it('JSON inválido sigue siendo 400 invalid_body', async () => {
    const res = await POST(request('{no es json'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, reason: 'invalid_body' })
    expect(deliverContactSubmission).not.toHaveBeenCalled()
  })

  it('campos inválidos siguen siendo 422 invalid_fields', async () => {
    const res = await POST(request(JSON.stringify(contacto({ email: 'no-es-email' }))))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ ok: false, reason: 'invalid_fields' })
    expect(deliverContactSubmission).not.toHaveBeenCalled()
  })

  it('sin configuración de envío sigue siendo 503 not_configured', async () => {
    vi.mocked(deliverContactSubmission).mockResolvedValue({ ok: false, reason: 'not_configured' })
    const res = await POST(request(JSON.stringify(contacto())))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('falla de envío sigue siendo 502 delivery_failed', async () => {
    vi.mocked(deliverContactSubmission).mockResolvedValue({ ok: false, reason: 'delivery_failed' })
    const res = await POST(request(JSON.stringify(contacto())))
    expect(res.status).toBe(502)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { MAX_CART_LINES } from '@orderflow/validators'

// Rate limiting Fase 1A — hardening de /api/public/forms. Todo lo que toca la
// base está mockeado: lo que se prueba es que los rechazos tempranos ocurren
// ANTES de resolver el tenant, el carrito o la submission.

vi.mock('@/lib/repositories/public-site.repository', () => ({ getPublicTenant: vi.fn() }))
vi.mock('@/lib/forms/submissions.repository', () => ({
  createSubmission:               vi.fn(),
  findSubmissionByIdempotencyKey: vi.fn(),
  resolvePublicationContext:      vi.fn(),
}))
vi.mock('@/lib/forms/food-order-cart', () => ({
  resolveFoodOrderCart:          vi.fn(),
  buildResolvedFoodOrderPayload: vi.fn(),
}))

import { getPublicTenant } from '@/lib/repositories/public-site.repository'
import {
  createSubmission,
  findSubmissionByIdempotencyKey,
  resolvePublicationContext,
} from '@/lib/forms/submissions.repository'
import { resolveFoodOrderCart } from '@/lib/forms/food-order-cart'
import { POST } from './route'

const URL_FORMS = 'http://localhost:3001/api/public/forms'
const MAX_BODY_BYTES = 20_000

const TENANT = {
  id:                         '11111111-1111-4111-8111-111111111111',
  vertical:                   'food_service',
  delivery_enabled:           true,
  takeaway_enabled:           true,
  table_reservations_enabled: true,
}

function consulta(overrides: Record<string, unknown> = {}) {
  return {
    tenant_slug:     'pizzeria-demo',
    intent:          'general_inquiry',
    source:          'public_site',
    idempotency_key: 'a1b2c3d4-0000-4000-8000-000000000000',
    payload:         { name: 'Ana', message: '¿Hacen envíos a Palermo?' },
    ...overrides,
  }
}

function request(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(URL_FORMS, {
    method:  'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

function expectNoDbWork() {
  expect(getPublicTenant).not.toHaveBeenCalled()
  expect(findSubmissionByIdempotencyKey).not.toHaveBeenCalled()
  expect(resolveFoodOrderCart).not.toHaveBeenCalled()
  expect(resolvePublicationContext).not.toHaveBeenCalled()
  expect(createSubmission).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPublicTenant).mockResolvedValue(TENANT as never)
  vi.mocked(findSubmissionByIdempotencyKey).mockResolvedValue(null)
  vi.mocked(resolvePublicationContext).mockResolvedValue({ publicationRef: null, entityType: null, entityId: null })
  vi.mocked(createSubmission).mockResolvedValue({
    ok: true,
    deduplicated: false,
    submission: {
      id:         '22222222-2222-4222-8222-222222222222',
      reference:  'SUB-ABC234',
      intent:     'general_inquiry',
      status:     'submitted',
      created_at: '2026-10-06T12:00:00.000Z',
      expires_at: '2026-10-07T12:00:00.000Z',
    },
  })
})

describe('POST /api/public/forms — Content-Type', () => {
  it('application/json continúa hasta crear la submission', async () => {
    const res = await POST(request(JSON.stringify(consulta())))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, reference: 'SUB-ABC234', deduplicated: false })
    expect(createSubmission).toHaveBeenCalledTimes(1)
  })

  it('application/json; charset=utf-8 continúa', async () => {
    const res = await POST(request(JSON.stringify(consulta()), { 'content-type': 'application/json; charset=utf-8' }))
    expect(res.status).toBe(201)
    expect(createSubmission).toHaveBeenCalledTimes(1)
  })

  it.each(['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    '%s → 415 sin tocar la base ni leer el body',
    async (contentType) => {
      const req = request(JSON.stringify(consulta()), { 'content-type': contentType })
      const res = await POST(req)
      expect(res.status).toBe(415)
      expect(await res.json()).toEqual({ ok: false, reason: 'unsupported_media_type' })
      expect(req.bodyUsed).toBe(false)
      expectNoDbWork()
    },
  )

  it('sin Content-Type → 415', async () => {
    const req = new NextRequest(URL_FORMS, { method: 'POST', body: new TextEncoder().encode(JSON.stringify(consulta())) })
    expect(req.headers.get('content-type')).toBeNull()
    const res = await POST(req)
    expect(res.status).toBe(415)
    expectNoDbWork()
  })
})

describe('POST /api/public/forms — Sec-Fetch-Site', () => {
  it('cross-site → 403 sin tocar la base ni leer el body', async () => {
    const req = request(JSON.stringify(consulta()), { 'sec-fetch-site': 'cross-site' })
    const res = await POST(req)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, reason: 'cross_site_request' })
    expect(req.bodyUsed).toBe(false)
    expectNoDbWork()
  })

  it.each(['same-origin', 'same-site', 'none'])('%s está permitido', async (site) => {
    const res = await POST(request(JSON.stringify(consulta()), { 'sec-fetch-site': site }))
    expect(res.status).toBe(201)
  })

  it('sin el header está permitido (curl, navegadores viejos)', async () => {
    const req = request(JSON.stringify(consulta()))
    expect(req.headers.get('sec-fetch-site')).toBeNull()
    expect((await POST(req)).status).toBe(201)
  })
})

describe('POST /api/public/forms — tamaño', () => {
  it('Content-Length > 20 000 → 413 sin leer el body ni tocar la base', async () => {
    const req = request(JSON.stringify(consulta()), { 'content-length': String(MAX_BODY_BYTES + 1) })
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ ok: false, reason: 'payload_too_large' })
    expect(req.bodyUsed).toBe(false)
    expectNoDbWork()
  })

  it('body con más de 20 000 bytes UTF-8 → 413 aunque tenga menos de 20 000 caracteres', async () => {
    const raw = JSON.stringify(consulta({ payload: { name: 'Ana', message: 'é'.repeat(10_500) } }))
    expect(raw.length).toBeLessThan(MAX_BODY_BYTES)
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(MAX_BODY_BYTES)

    const res = await POST(request(raw))
    expect(res.status).toBe(413)
    expectNoDbWork()
  })

  it('sin Content-Length no se rechaza por eso', async () => {
    const req = request(JSON.stringify(consulta()))
    expect(req.headers.get('content-length')).toBeNull()
    expect((await POST(req)).status).toBe(201)
  })

  it('el peor caso razonable de un pedido entra y llega a resolver el carrito', async () => {
    // 25 líneas con 300 caracteres de aclaración, 1000 de observaciones, nombre
    // y dirección al máximo — el caso que justifica el tope de 20 000.
    const pedido = {
      tenant_slug:     'pizzeria-demo',
      intent:          'food_order',
      source:          'public_site',
      idempotency_key: 'a1b2c3d4-0000-4000-8000-000000000001',
      payload: {
        name:           'n'.repeat(120),
        fulfillment:    'delivery',
        address:        'd'.repeat(300),
        payment_method: 'transfer',
        notes:          'o'.repeat(1000),
        items: Array.from({ length: MAX_CART_LINES }, (_, i) => ({
          item_id:             `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
          quantity:            99,
          notes:               'a'.repeat(300),
          expected_unit_price: '99999999.99',
        })),
      },
    }
    const raw = JSON.stringify(pedido)
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES)

    // cart_changed corta el flujo en un 409 conocido: alcanza para probar que el
    // request pasó el hardening y llegó a la resolución del carrito.
    vi.mocked(resolveFoodOrderCart).mockResolvedValue({ ok: false, failure: { code: 'cart_changed', items: [] } })

    const res = await POST(request(raw))
    expect(res.status).toBe(409)
    expect(resolveFoodOrderCart).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/public/forms — contrato previo intacto', () => {
  it('JSON inválido sigue siendo 400 invalid_json', async () => {
    const res = await POST(request('{no es json'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, reason: 'invalid_json' })
    expect(getPublicTenant).not.toHaveBeenCalled()
  })

  it('un request que no cumple el schema sigue siendo 422 invalid_request', async () => {
    const res = await POST(request(JSON.stringify({ tenant_slug: 'x' })))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ ok: false, reason: 'invalid_request' })
    expect(getPublicTenant).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  createSubmissionRequestSchema,
  formIntentSchema,
  MAX_CART_LINES,
  validateSubmissionPayload,
  type FormIntent,
} from '@orderflow/validators'
import { MAX_PUBLIC_POST_BODY_BYTES } from '@/lib/http/public-post-guard'

// Rate limiting Fases 1A/1B — hardening de /api/public/forms. Todo lo que toca la
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
const MAX_BODY_BYTES = MAX_PUBLIC_POST_BODY_BYTES

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
  it('el tope es MAX_PUBLIC_POST_BODY_BYTES = 32 KiB', () => {
    expect(MAX_BODY_BYTES).toBe(32_768)
  })

  it('Content-Length > 32 KiB → 413 sin leer el body ni tocar la base', async () => {
    const req = request(JSON.stringify(consulta()), { 'content-length': String(MAX_BODY_BYTES + 1) })
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ ok: false, reason: 'payload_too_large' })
    expect(req.bodyUsed).toBe(false)
    expectNoDbWork()
  })

  it('body con más de 32 KiB UTF-8 → 413 aunque tenga menos de 32 768 caracteres', async () => {
    const raw = JSON.stringify(consulta({ payload: { name: 'Ana', message: 'é'.repeat(17_000) } }))
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
})

// ── El body válido más grande de cada intent ────────────────────────────────
//
// Todos los textos al máximo de su schema y escritos con '…' (U+2026): 3 bytes
// UTF-8 y UNA unidad UTF-16 para los .max() de zod — el carácter más caro que
// los schemas dejan pasar (un emoji pesa 4 bytes pero cuenta 2 unidades, o sea
// 2 bytes por unidad). Números, fechas, enums y montos en su forma más larga.
// Es la serialización canónica (JSON.stringify), no JSON inflado a mano.

const C3 = '…'
const texto = (n: number) => C3.repeat(n)
const PUB_REF = { publication_ref: 'OF-ABC234' }

function sobre(intent: FormIntent, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    tenant_slug:     texto(120),
    intent,
    source:          'public_site',
    idempotency_key: 'a1b2c3d4-0000-4000-8000-000000000002',
    ...extra,
    payload,
  }
}

// Record<FormIntent, …>: si se agrega un intent sin su caso máximo, no compila.
const BODY_MAXIMO: Record<FormIntent, ReturnType<typeof sobre>> = {
  food_order: sobre('food_order', {
    name:           texto(120),
    fulfillment:    'delivery',
    address:        texto(300),
    payment_method: 'transfer',
    notes:          texto(1000),
    items: Array.from({ length: MAX_CART_LINES }, (_, i) => ({
      item_id:             `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      quantity:            99,
      notes:               texto(300),
      expected_unit_price: '999999999999.99',
    })),
  }),
  general_inquiry:  sobre('general_inquiry', { name: texto(120), message: texto(1000) }),
  property_inquiry: sobre('property_inquiry', { name: texto(120), message: texto(1000) }, PUB_REF),
  monthly_rental_inquiry: sobre('monthly_rental_inquiry', {
    name: texto(120), move_in_date: '2026-12-01', occupants: 30, notes: texto(1000),
  }, PUB_REF),
  temporary_rental: sobre('temporary_rental', {
    name: texto(120), check_in: '2026-12-01', check_out: '2026-12-31',
    adults: 30, children: 30, infants: 10, has_pets: true, pet_details: texto(200), notes: texto(1000),
  }, PUB_REF),
  property_visit: sobre('property_visit', {
    name: texto(120), preferred_date: '2026-12-01', preferred_time_range: 'afternoon', notes: texto(1000),
  }, PUB_REF),
  table_reservation: sobre('table_reservation', {
    name: texto(120), date: '2026-12-01', time: '21:30', people: 50, notes: texto(1000),
  }),
}

const REAL_ESTATE = { ...TENANT, vertical: 'real_estate' }
const FOOD_INTENTS = new Set<FormIntent>(['general_inquiry', 'table_reservation', 'food_order'])

describe('POST /api/public/forms — el body válido más grande entra en 32 KiB', () => {
  it('hay un caso máximo para cada FormIntent', () => {
    expect(Object.keys(BODY_MAXIMO).sort()).toEqual([...formIntentSchema.options].sort())
  })

  it.each(formIntentSchema.options)('%s: es válido y pesa ≤ 32 KiB', (intent) => {
    const body = BODY_MAXIMO[intent]
    expect(createSubmissionRequestSchema.safeParse(body).success).toBe(true)
    expect(validateSubmissionPayload(intent, body.payload)).toMatchObject({ ok: true })
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES)
  })

  it('el pedido es el más grande de todos y deja margen', () => {
    const pesos = formIntentSchema.options.map((i) => [i, Buffer.byteLength(JSON.stringify(BODY_MAXIMO[i]), 'utf8')] as const)
    const [mayor, bytes] = [...pesos].sort((a, b) => b[1] - a[1])[0]!
    expect(mayor).toBe('food_order')
    expect(bytes).toBeGreaterThan(29_000) // de verdad es el caso pesado...
    expect(bytes).toBeLessThan(MAX_BODY_BYTES) // ...y aun así entra
  })

  it.each(formIntentSchema.options)('%s: la ruta lo acepta (no 413) y llega hasta el final', async (intent) => {
    vi.mocked(getPublicTenant).mockResolvedValue((FOOD_INTENTS.has(intent) ? TENANT : REAL_ESTATE) as never)
    // El pedido corta en un 409 conocido de la resolución del carrito: alcanza
    // para probar que pasó el hardening y la validación completa.
    vi.mocked(resolveFoodOrderCart).mockResolvedValue({ ok: false, failure: { code: 'cart_changed', items: [] } })

    const res = await POST(request(JSON.stringify(BODY_MAXIMO[intent])))

    if (intent === 'food_order') {
      expect(res.status).toBe(409)
      expect(resolveFoodOrderCart).toHaveBeenCalledTimes(1)
    } else {
      expect(res.status).toBe(201)
      expect(createSubmission).toHaveBeenCalledTimes(1)
    }
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

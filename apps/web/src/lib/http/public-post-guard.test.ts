import { describe, expect, it } from 'vitest'
import {
  declaredContentLength,
  isCrossSiteRequest,
  isJsonContentType,
  readPublicJsonBody,
} from './public-post-guard'

const MAX = 20_000

function post(body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  return new Request('http://localhost/api/x', { method: 'POST', headers, body })
}

describe('isJsonContentType', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=utf-8',
    'application/json ; charset=UTF-8',
    'Application/JSON; Charset="utf-8"',
    'application/json; charset=utf8',
    'application/json;',
    'application/json; ; charset=utf-8',
    'application/json; foo=bar',
  ])('acepta %j', (header) => {
    expect(isJsonContentType(header)).toBe(true)
  })

  it.each([
    [null],
    [''],
    ['text/plain'],
    ['text/plain; charset=utf-8'],
    ['application/x-www-form-urlencoded'],
    ['multipart/form-data; boundary=abc'],
    ['application/jsonp'],
    ['application/vnd.api+json'],
    ['application/json-patch+json'],
    ['application/json, text/plain'],
    ['application/json; charset=iso-8859-1'],
    ['application/json; charset'],
    ['application/json; =utf-8'],
    ['application/json; charset=utf 8'],
    ['*/*'],
  ])('rechaza %j', (header) => {
    expect(isJsonContentType(header)).toBe(false)
  })
})

describe('isCrossSiteRequest', () => {
  it('sólo cross-site es cross-site, sin importar mayúsculas', () => {
    expect(isCrossSiteRequest('cross-site')).toBe(true)
    expect(isCrossSiteRequest('Cross-Site')).toBe(true)
  })

  it.each([[null], ['same-origin'], ['same-site'], ['none'], ['']])('no rechaza %j', (header) => {
    expect(isCrossSiteRequest(header)).toBe(false)
  })
})

describe('declaredContentLength', () => {
  it('lee un entero decimal', () => {
    expect(declaredContentLength('20001')).toBe(20_001)
    expect(declaredContentLength('0')).toBe(0)
  })

  it.each([[null], ['abc'], ['-1'], ['1e5'], ['12.5'], ['10, 10'], ['']])(
    'ignora %j (no es motivo de rechazo)',
    (header) => {
      expect(declaredContentLength(header)).toBeNull()
    },
  )
})

describe('readPublicJsonBody', () => {
  it('devuelve el body cuando todo está en regla', async () => {
    const r = await readPublicJsonBody(post('{"a":1}'), MAX)
    expect(r).toEqual({ ok: true, raw: '{"a":1}' })
  })

  it('415 sin leer el body si no es application/json', async () => {
    const req = post('{}', { 'content-type': 'text/plain' })
    expect(await readPublicJsonBody(req, MAX)).toEqual({ ok: false, status: 415, reason: 'unsupported_media_type' })
    expect(req.bodyUsed).toBe(false)
  })

  it('415 si falta el Content-Type', async () => {
    const req = new Request('http://localhost/api/x', { method: 'POST', body: new Uint8Array([123, 125]) })
    expect(req.headers.get('content-type')).toBeNull()
    expect(await readPublicJsonBody(req, MAX)).toMatchObject({ ok: false, status: 415 })
  })

  it('403 sin leer el body si el navegador dice cross-site', async () => {
    const req = post('{}', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })
    expect(await readPublicJsonBody(req, MAX)).toEqual({ ok: false, status: 403, reason: 'cross_site_request' })
    expect(req.bodyUsed).toBe(false)
  })

  it('el Content-Type se evalúa antes que Sec-Fetch-Site', async () => {
    const req = post('{}', { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' })
    expect(await readPublicJsonBody(req, MAX)).toMatchObject({ status: 415 })
  })

  it('413 sin leer el body si Content-Length declara más del límite', async () => {
    const req = post('{}', { 'content-type': 'application/json', 'content-length': String(MAX + 1) })
    expect(await readPublicJsonBody(req, MAX)).toEqual({ ok: false, status: 413, reason: 'payload_too_large' })
    expect(req.bodyUsed).toBe(false)
  })

  it('un Content-Length inválido no rechaza: manda la medición real', async () => {
    const req = post('{}', { 'content-type': 'application/json', 'content-length': 'abc' })
    expect(await readPublicJsonBody(req, MAX)).toEqual({ ok: true, raw: '{}' })
  })

  it('mide bytes UTF-8, no unidades UTF-16', async () => {
    // 10 001 'ñ' = 10 001 unidades UTF-16 pero 20 002 bytes.
    const raw = 'ñ'.repeat(10_001)
    expect(raw.length).toBeLessThan(MAX)
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(MAX)

    expect(await readPublicJsonBody(post(raw), MAX)).toEqual({ ok: false, status: 413, reason: 'payload_too_large' })
  })

  it('exactamente en el límite pasa; un byte más no', async () => {
    expect(await readPublicJsonBody(post('a'.repeat(MAX)), MAX)).toMatchObject({ ok: true })
    expect(await readPublicJsonBody(post('a'.repeat(MAX + 1)), MAX)).toMatchObject({ ok: false, status: 413 })
  })

  it('decodifica UTF-8 igual que request.text()', async () => {
    const raw = '{"nombre":"Muñoz ☕"}'
    expect(await readPublicJsonBody(post(raw), MAX)).toEqual({ ok: true, raw })
  })

  it('400 si el body no se puede leer', async () => {
    const req = post('{}')
    await req.arrayBuffer() // ya consumido: una segunda lectura tira
    expect(await readPublicJsonBody(req, MAX)).toEqual({ ok: false, status: 400, reason: 'invalid_body' })
  })
})

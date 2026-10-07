import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NO_URL_STORAGE,
  RESUMABLE_UPLOAD_RETRY_DELAYS_MS,
  SUPABASE_TUS_CHUNK_SIZE_BYTES,
  assertUploadDestination,
  buildTusOptions,
  classifyUploadFailure,
  createResumableVideoUpload,
  createResumableVideoUploadForTesting,
  isSupabaseProjectRef,
  supabaseProjectRefFromUrl,
  supabaseResumableUploadEndpoint,
  uploadProgressPercent,
  type ResumableUploadStatus,
  type ResumableUploadTestSeam,
  type ResumableVideoUploadInput,
} from './resumable-upload'
import { LEGACY_VIDEO_UPLOAD_MAX_BYTES, MAX_VIDEO_SIZE_BYTES } from './limits'
import { FakeTusServer, decodeTusMetadata } from '@/testing/fake-tus'

// Property Videos Fase 2A — uploader TUS directo a Supabase Storage, todavía
// sin conectar a la UI. Corre contra el tus-js-client REAL (build de browser,
// ver vitest.config.mts) con un servidor TUS en memoria como pila HTTP. El
// servidor falso se inyecta por el seam de tests: el destino de las requests
// sigue siendo el endpoint que el uploader arma con el ref del proyecto.

const MB = 1024 * 1024
const PROJECT_REF = 'abcdefghijklmnopqrst'
const STORAGE_HOST = `${PROJECT_REF}.storage.supabase.co`
const ENDPOINT = `https://${STORAGE_HOST}/storage/v1/upload/resumable`
const TOKEN = 'eyJhbGciOi.SECRETO-DE-PRUEBA.firma'
const OBJECT_PATH = 'aaaaaaaa-0000-4000-8000-00000000000a/11111111-2222-4000-8000-333333333333.mp4'
// 13 MB → chunks de 6 + 6 + 1 MB. Más grande que el límite legacy (4 MiB): el
// uploader nuevo trabaja con el límite final. Se arma una sola vez.
const VIDEO = new File([new Uint8Array(13 * MB)], 'casa.mp4', { type: 'video/mp4' })

let server: FakeTusServer
let progress: number[]
let statuses: ResumableUploadStatus[]

function input(overrides: Partial<ResumableVideoUploadInput> = {}): ResumableVideoUploadInput {
  return {
    file: VIDEO,
    projectRef: PROJECT_REF,
    bucket: 'property-videos',
    objectPath: OBJECT_PATH,
    contentType: 'video/mp4',
    signedUploadToken: TOKEN,
    onProgress: (p) => progress.push(p),
    onStatusChange: (s) => statuses.push(s),
    ...overrides,
  }
}

function uploader(overrides: Partial<ResumableVideoUploadInput> = {}, seam: Partial<ResumableUploadTestSeam> = {}) {
  return createResumableVideoUploadForTesting(input(overrides), { httpStack: server, retryDelaysMs: [0, 0], ...seam })
}

/** Requests que llegaron a enviarse a un origen distinto del Storage del proyecto. */
function foreignRequests() {
  return server.requests.filter((r) => new URL(r.url).host !== STORAGE_HOST)
}

const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []

beforeEach(() => {
  server = new FakeTusServer(ENDPOINT, TOKEN)
  progress = []
  statuses = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined))
  }
})

afterEach(() => {
  // Ningún flujo —éxito, cancelación o error— escribe en consola.
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  consoleSpies.splice(0).forEach((spy) => spy.mockRestore())
  vi.restoreAllMocks()
})

describe('subida exitosa', () => {
  it('sube en chunks de 6 MB directo al endpoint de Storage del proyecto y termina en success', async () => {
    const upload = uploader()
    expect(upload.status).toBe('idle')

    expect(await upload.start()).toEqual({ status: 'success' })
    expect(upload.status).toBe('success')
    expect(statuses).toEqual(['uploading', 'success'])

    expect(server.requests.map((r) => [r.method, r.bodyBytes])).toEqual([
      ['POST', 6 * MB],
      ['PATCH', 6 * MB],
      ['PATCH', 1 * MB],
    ])
    expect(SUPABASE_TUS_CHUNK_SIZE_BYTES).toBe(6 * MB)
    expect([...server.uploads.values()]).toEqual([expect.objectContaining({ length: 13 * MB, offset: 13 * MB })])
  })

  it('usa el límite final (50 MiB), no el del transporte legacy (4 MiB)', async () => {
    expect(VIDEO.size).toBeGreaterThan(LEGACY_VIDEO_UPLOAD_MAX_BYTES)
    expect(await uploader().start()).toEqual({ status: 'success' })
  })

  it('progreso real: enteros 0..100, crecientes, con valores intermedios y 100 al final', async () => {
    await uploader().start()
    expect(progress.length).toBeGreaterThan(3)
    expect(progress.every((p) => Number.isInteger(p) && p >= 0 && p <= 100)).toBe(true)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(new Set(progress).size).toBe(progress.length) // sólo cuando cambia el entero
    expect(progress.some((p) => p > 0 && p < 100)).toBe(true)
    expect(progress.at(-1)).toBe(100)
  })

  it('volver a llamar start() después del éxito no sube de nuevo', async () => {
    const upload = uploader()
    await upload.start()
    const count = server.requests.length
    expect(await upload.start()).toEqual({ status: 'success' })
    expect(server.requests).toHaveLength(count)
  })

  it('start() mientras sube devuelve la misma promesa', async () => {
    const upload = uploader()
    const a = upload.start()
    const b = upload.start()
    expect(b).toBe(a)
    await a
    expect(server.requestsOf('POST')).toHaveLength(1)
  })
})

describe('contrato TUS de Supabase: headers y metadata', () => {
  // Headers que puede llevar una request: los del protocolo TUS y los dos del
  // flujo firmado. Ninguna otra credencial.
  const ALLOWED_HEADERS = new Set(['tus-resumable', 'x-signature', 'x-upsert', 'upload-length', 'upload-metadata', 'upload-offset', 'content-type'])

  it('la credencial es SOLO x-signature: sin Authorization, apikey ni otras claves', async () => {
    await uploader().start()
    for (const request of server.requests) {
      expect(Object.keys(request.headers).filter((h) => !ALLOWED_HEADERS.has(h)), `${request.method}`).toEqual([])
      expect(request.headers['x-signature']).toBe(TOKEN)
      expect(request.headers['x-upsert']).toBe('false')
      expect(request.headers['tus-resumable']).toBe('1.0.0')
      expect(request.headers).not.toHaveProperty('authorization')
      expect(request.headers).not.toHaveProperty('apikey')
    }
  })

  it('el token nunca va en la URL', async () => {
    await uploader().start()
    for (const request of server.requests) expect(request.url).not.toContain(TOKEN)
  })

  it('metadata: exactamente bucketName, objectName, contentType y cacheControl', async () => {
    await uploader().start()
    const [post] = server.requestsOf('POST')
    expect(post!.headers['upload-length']).toBe(String(13 * MB))
    expect(decodeTusMetadata(post!.headers['upload-metadata']!)).toEqual({
      bucketName: 'property-videos',
      objectName: OBJECT_PATH,
      contentType: 'video/mp4',
      cacheControl: '3600',
    })
  })

  it('configuración de tus-js-client: endpoint armado con el ref, chunk de 6 MB, sin persistencia', async () => {
    const options = buildTusOptions(input(), {})
    expect(options.endpoint).toBe(ENDPOINT)
    expect(options.chunkSize).toBe(6 * MB)
    expect(options.uploadDataDuringCreation).toBe(true)
    expect(options.headers).toEqual({ 'x-signature': TOKEN, 'x-upsert': 'false' })
    expect(options.storeFingerprintForResuming).toBe(false)
    expect(options.urlStorage).toBe(NO_URL_STORAGE)
    expect(options.retryDelays).toEqual([...RESUMABLE_UPLOAD_RETRY_DELAYS_MS])
    expect(options.httpStack).toBeUndefined() // producción: el XMLHttpRequest del browser

    await NO_URL_STORAGE.addUpload('fingerprint', { size: 1, metadata: {}, creationTime: '', urlStorageKey: '', uploadUrl: `${ENDPOINT}/x`, parallelUploadUrls: null })
    expect(await NO_URL_STORAGE.findAllUploads()).toEqual([])
    expect(await NO_URL_STORAGE.findUploadsByFingerprint('fingerprint')).toEqual([])
  })
})

describe('endpoint cerrado al proyecto', () => {
  it('el endpoint se arma sólo a partir del ref', () => {
    expect(supabaseResumableUploadEndpoint(PROJECT_REF)).toBe(ENDPOINT)
  })

  it.each([
    ['vacío', ''],
    ['19 letras', 'abcdefghijklmnopqrs'],
    ['21 letras', 'abcdefghijklmnopqrstu'],
    ['mayúsculas', 'ABCDEFGHIJKLMNOPQRST'],
    ['dígitos', 'abcdefghij0123456789'],
    ['URL https', `https://${PROJECT_REF}.supabase.co`],
    ['URL http', `http://${PROJECT_REF}.storage.supabase.co`],
    ['host arbitrario', 'evil.example.com'],
    ['subdominio parecido', `${PROJECT_REF}.storage.supabase.co.evil.com`],
    ['ref con sufijo de dominio', `${PROJECT_REF}.evil`],
    ['ref con path', `${PROJECT_REF}/../evil`],
    ['ref con query', `${PROJECT_REF}?x=1`],
    ['ref con userinfo', `user@${PROJECT_REF}`],
    ['ref con puerto', `${PROJECT_REF}:8443`],
    ['homoglifo cirílico', 'аbcdefghijklmnopqrst'],
    ['espacios', ` ${PROJECT_REF} `],
    ['salto de línea', `${PROJECT_REF}\n`],
  ])('projectRef %s → error antes de cualquier request', (_, projectRef) => {
    expect(isSupabaseProjectRef(projectRef)).toBe(false)
    expect(() => supabaseResumableUploadEndpoint(projectRef)).toThrow(TypeError)
    expect(() => uploader({ projectRef })).toThrow(TypeError)
    expect(() => createResumableVideoUpload(input({ projectRef }))).toThrow(TypeError)
    expect(server.requests).toHaveLength(0)
  })

  it('la API productiva no acepta un endpoint (ni por tipo ni en runtime)', async () => {
    // @ts-expect-error — ResumableVideoUploadInput no tiene `endpoint`
    const conEndpoint: ResumableVideoUploadInput = { ...input(), endpoint: 'https://evil.example.com/storage/v1/upload/resumable' }
    expect(createResumableVideoUpload.length).toBe(1) // sin parámetro de transporte
    // Aunque se cuele en runtime, se ignora: todo va al Storage del proyecto.
    expect(await createResumableVideoUploadForTesting(conEndpoint, { httpStack: server }).start()).toEqual({ status: 'success' })
    expect(foreignRequests()).toEqual([])
  })

  it('todo el tráfico va al host de Storage del proyecto; fetch (el transporte de las Server Actions) no se usa', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await uploader().start()
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const request of server.requests) {
      expect(request.url.startsWith(`${ENDPOINT}`)).toBe(true)
    }
    expect(server.requests.filter((r) => r.bodyBytes > 0).every((r) => r.bodyIsBlob)).toBe(true)
  })

  it.each([
    ['otro origen', (id: string) => `https://evil.example.com/storage/v1/upload/resumable/${id}`],
    ['subdominio parecido', (id: string) => `https://${STORAGE_HOST}.evil.com/storage/v1/upload/resumable/${id}`],
    ['mismo host por http', (id: string) => `http://${STORAGE_HOST}/storage/v1/upload/resumable/${id}`],
    ['mismo host, otro puerto', (id: string) => `https://${STORAGE_HOST}:8443/storage/v1/upload/resumable/${id}`],
    ['mismo host con userinfo', (id: string) => `https://user:pass@${STORAGE_HOST}/storage/v1/upload/resumable/${id}`],
    ['mismo host, otro path', (id: string) => `https://${STORAGE_HOST}/storage/v1/object/property-videos/${id}`],
    ['path parecido', (id: string) => `https://${STORAGE_HOST}/storage/v1/upload/resumable-evil/${id}`],
    ['relativo fuera del endpoint', (id: string) => `/storage/v1/object/${id}`],
  ])('Location de Storage hacia %s: ni el File ni x-signature salen; storage_error sin reintentos', async (_, location) => {
    server.locationFor = location
    const upload = uploader()
    expect(await upload.start()).toEqual({ status: 'storage_error', reason: 'unexpected_upload_url' })
    expect(foreignRequests()).toEqual([])
    // Sólo la creación, contra el endpoint real; ningún HEAD/PATCH a la URL ajena.
    expect(server.requests.map((r) => [r.method, r.url])).toEqual([['POST', ENDPOINT]])
    // Y un único intento contra ese destino (cortado antes de enviarse): no se reintenta.
    expect(server.created.filter((r) => r.url !== ENDPOINT)).toHaveLength(1)
  })

  it('un Location relativo debajo del endpoint es válido', async () => {
    server.locationFor = (id) => `/storage/v1/upload/resumable/${id}`
    expect(await uploader().start()).toEqual({ status: 'success' })
    expect(foreignRequests()).toEqual([])
  })

  it.each([
    [`${ENDPOINT}`, true],
    [`${ENDPOINT}/abc`, true],
    [`${ENDPOINT}/abc?x=1`, true],
    [`https://evil.example.com/storage/v1/upload/resumable`, false],
    [`${ENDPOINT}-x`, false],
    [`https://${STORAGE_HOST}/storage/v1/upload`, false],
    ['no es una url', false],
  ])('assertUploadDestination(%j) → permitido=%s', (url, allowed) => {
    const check = () => assertUploadDestination(url, ENDPOINT)
    if (allowed) expect(check).not.toThrow()
    else expect(check).toThrow()
  })

  it('supabaseProjectRefFromUrl: sólo https://<ref>.supabase.co', () => {
    expect(supabaseProjectRefFromUrl(`https://${PROJECT_REF}.supabase.co`)).toBe(PROJECT_REF)
    expect(supabaseProjectRefFromUrl(`https://${PROJECT_REF}.supabase.co/`)).toBe(PROJECT_REF)
    for (const bad of [
      `http://${PROJECT_REF}.supabase.co`,
      `https://${PROJECT_REF}.supabase.co:443x`,
      `https://${PROJECT_REF}.supabase.co:8443`,
      `https://user@${PROJECT_REF}.supabase.co`,
      `https://${PROJECT_REF}.supabase.co/rest`,
      `https://${PROJECT_REF}.supabase.co/?a=1`,
      `https://${PROJECT_REF}.supabase.co/#x`,
      `https://${PROJECT_REF}.supabase.co.evil.com`,
      `https://${PROJECT_REF}.storage.supabase.co`,
      'https://evil.example.com',
      'http://127.0.0.1:54321',
      'no es una url',
    ]) {
      expect(() => supabaseProjectRefFromUrl(bad), bad).toThrow(TypeError)
    }
  })
})

describe('cancelar', () => {
  it('cancel() con un chunk en vuelo: corta el request, resuelve cancelled y no hay más tráfico', async () => {
    server.failNext('PATCH', { kind: 'hang' })
    const upload = uploader()
    const result = upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))
    const progressAtCancel = progress.length

    upload.cancel()
    expect(await result).toEqual({ status: 'cancelled' })
    expect(upload.status).toBe('cancelled')
    expect(server.hanging[0]!.aborted).toBe(true)

    const count = server.requests.length
    await new Promise((r) => setTimeout(r, 20))
    expect(server.requests).toHaveLength(count)
    expect(progress).toHaveLength(progressAtCancel)
    expect(statuses).toEqual(['uploading', 'cancelled'])
  })

  it('AbortSignal abortado a mitad de la subida → cancelled', async () => {
    server.failNext('PATCH', { kind: 'hang' })
    const controller = new AbortController()
    const upload = uploader({ signal: controller.signal })
    const result = upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))
    controller.abort()
    expect(await result).toEqual({ status: 'cancelled' })
    expect(server.hanging[0]!.aborted).toBe(true)
  })

  it('signal ya abortado antes de empezar → cancelled sin ningún request', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await uploader({ signal: controller.signal }).start()).toEqual({ status: 'cancelled' })
    expect(server.requests).toHaveLength(0)
  })

  it('cancelar es definitivo: start() posterior no sube', async () => {
    const upload = uploader()
    upload.cancel()
    expect(await upload.start()).toEqual({ status: 'cancelled' })
    expect(server.requests).toHaveLength(0)
  })
})

describe('retry / resume', () => {
  it('red caída en un chunk: reintenta solo, consulta el offset con HEAD y sigue (un único POST)', async () => {
    server.failNext('PATCH', { kind: 'network' })
    expect(await uploader().start()).toEqual({ status: 'success' })
    expect(server.requests.map((r) => r.method)).toEqual(['POST', 'PATCH', 'HEAD', 'PATCH', 'PATCH'])
    expect([...server.uploads.values()][0]!.offset).toBe(13 * MB)
  })

  it('corte a mitad de un chunk: reanuda desde el offset que tiene el servidor, no desde cero', async () => {
    server.failNext('PATCH', { kind: 'partial-then-network' })
    expect(await uploader().start()).toEqual({ status: 'success' })
    const patches = server.requestsOf('PATCH')
    // 6 MB aceptados en el POST + 3 MB del chunk cortado → el siguiente PATCH arranca en 9 MB.
    expect(patches[1]!.headers['upload-offset']).toBe(String(9 * MB))
    const sent = server.requests.reduce((n, r) => n + r.bodyBytes, 0)
    expect(sent).toBeLessThan(13 * MB + 6 * MB)
  })

  it('sin reintentos automáticos: network_error, y start() reanuda la MISMA subida', async () => {
    server.failNext('PATCH', { kind: 'network' })
    const upload = uploader({}, { retryDelaysMs: [] })

    expect(await upload.start()).toEqual({ status: 'network_error' })
    expect(upload.status).toBe('network_error')

    expect(await upload.start()).toEqual({ status: 'success' })
    expect(server.requestsOf('POST')).toHaveLength(1)
    expect(server.requestsOf('HEAD')).toHaveLength(1)
    expect(statuses).toEqual(['uploading', 'network_error', 'uploading', 'success'])
  })

  it('resume no es indefinido: si Storage ya no reconoce la subida, se recrea desde el byte 0', async () => {
    server.failNext('PATCH', { kind: 'network' })
    const upload = uploader({}, { retryDelaysMs: [] })
    expect(await upload.start()).toEqual({ status: 'network_error' })

    server.expireUploads()
    expect(await upload.start()).toEqual({ status: 'success' })
    expect(server.requests.map((r) => r.method)).toEqual(['POST', 'PATCH', 'HEAD', 'POST', 'PATCH', 'PATCH'])
    expect(server.requestsOf('POST')[1]!.bodyBytes).toBe(6 * MB) // vuelve a mandar el primer chunk
  })

  it('subida vencida y token vencido: expired_token, hay que volver a prepare', async () => {
    server.failNext('PATCH', { kind: 'network' })
    const upload = uploader({}, { retryDelaysMs: [] })
    await upload.start()

    server.expireUploads()
    server.failNext('POST', { kind: 'status', status: 400, body: '{"statusCode":"403","error":"InvalidJWT","message":"jwt expired"}' })
    expect(await upload.start()).toEqual({ status: 'expired_token', httpStatus: 400 })
    expect(upload.status).toBe('expired_token')
  })

  it('reintentos por defecto: inmediato y después con espera creciente', () => {
    expect(RESUMABLE_UPLOAD_RETRY_DELAYS_MS).toEqual([0, 1000, 3000, 5000, 10000])
  })

  it.each([409, 423])('%s (conflicto/locked) se reintenta, como en tus-js-client', async (status) => {
    server.failNext('PATCH', { kind: 'status', status })
    expect(await uploader().start()).toEqual({ status: 'success' })
    expect(server.requestsOf('HEAD')).toHaveLength(1)
  })
})

describe('errores tipados', () => {
  it('token vencido (400 InvalidJWT) → expired_token, sin reintentos', async () => {
    server.failNext('POST', { kind: 'status', status: 400, body: '{"statusCode":"403","error":"InvalidJWT","message":"jwt expired"}' })
    const upload = uploader()
    expect(await upload.start()).toEqual({ status: 'expired_token', httpStatus: 400 })
    expect(server.requests).toHaveLength(1)
    // Es definitivo: hay que pedir un token nuevo a prepare.
    expect(await upload.start()).toEqual({ status: 'expired_token', httpStatus: 400 })
    expect(server.requests).toHaveLength(1)
  })

  it('firma rechazada (403) → expired_token', async () => {
    expect(await uploader({ signedUploadToken: 'otro-token' }).start()).toEqual({ status: 'expired_token', httpStatus: 403 })
  })

  it('error de Storage (413) → storage_error, sin reintentos', async () => {
    server.failNext('POST', { kind: 'status', status: 413, body: '{"error":"Payload too large"}' })
    expect(await uploader().start()).toEqual({ status: 'storage_error', httpStatus: 413 })
    expect(server.requests).toHaveLength(1)
  })

  it('5xx persistente → storage_error después de agotar los reintentos', async () => {
    server.failNext('POST', { kind: 'status', status: 503 }, 3)
    expect(await uploader().start()).toEqual({ status: 'storage_error', httpStatus: 503 })
    expect(server.requestsOf('POST')).toHaveLength(3) // 1 + 2 reintentos
  })

  it('red caída persistente → network_error (sin status HTTP)', async () => {
    server.failNext('POST', { kind: 'network' }, 3)
    expect(await uploader().start()).toEqual({ status: 'network_error' })
    expect(server.requestsOf('POST')).toHaveLength(3)
  })

  // Sin QA contra Storage real todavía (Fase 2B): el classifier reconoce una
  // firma rechazada por varias formas razonables, no por un único status.
  it.each([
    [401, ''],
    [403, ''],
    [403, '{"error":"Unauthorized"}'],
    [400, '{"statusCode":"403","error":"InvalidJWT","message":"jwt expired"}'],
    [400, '{"error":"InvalidSignature","message":"invalid signature"}'],
    [400, '{"message":"Invalid token"}'],
    [400, '{"message":"The token has expired"}'],
    [400, 'Unauthorized'],
  ])('%s %j → expired_token', (status, body) => {
    expect(classifyUploadFailure({ originalResponse: res(status, body) })).toEqual({ status: 'expired_token', httpStatus: status })
  })

  it.each([
    [400, '{"error":"Asset Already Exists"}'],
    [400, 'bucket not found'],
    [404, ''],
    [409, ''],
    [410, ''],
    [413, ''],
    [415, ''],
    [500, ''],
    [503, ''],
  ])('%s %j → storage_error', (status, body) => {
    expect(classifyUploadFailure({ originalResponse: res(status, body) })).toEqual({ status: 'storage_error', httpStatus: status })
  })

  it.each([
    [null],
    [{}],
    [{ originalResponse: null }],
    [{ originalResponse: res(0) }],
  ])('sin respuesta HTTP (%j) → network_error', (error) => {
    expect(classifyUploadFailure(error)).toEqual({ status: 'network_error' })
  })
})

function res(status: number, body = '') {
  return { getStatus: () => status, getHeader: () => undefined, getBody: () => body, getUnderlyingObject: () => null }
}

describe('sin logs ni persistencia de secretos', () => {
  it('los resultados no llevan token, URL de subida, endpoint ni path', async () => {
    const ok = await uploader().start()
    server.failNext('POST', { kind: 'status', status: 400, body: `jwt expired for ${TOKEN}` })
    const expired = await uploader().start()
    server.failNext('POST', { kind: 'network' }, 3)
    const network = await uploader().start()
    server.locationFor = (id) => `https://evil.example.com/${id}`
    const foreign = await uploader().start()

    const serialized = JSON.stringify([ok, expired, network, foreign])
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('upload-')
    expect(serialized).not.toContain(OBJECT_PATH)
    expect(serialized).not.toContain('supabase.co')
    expect(serialized).not.toContain('evil.example.com')
  })

  it('los errores de entrada no repiten el token ni el ref', () => {
    for (const bad of [{ projectRef: `${PROJECT_REF}.evil` }, { signedUploadToken: '' }, { contentType: 'video/x-matroska' as never }]) {
      try {
        uploader(bad)
        expect.unreachable()
      } catch (error) {
        expect(String(error)).not.toContain(TOKEN)
        expect(String(error)).not.toContain(PROJECT_REF)
      }
    }
  })
})

describe('entrada inválida (contrato con prepare)', () => {
  it.each([
    ['archivo vacío', { file: new File([], 'v.mp4', { type: 'video/mp4' }) }, RangeError],
    ['MIME no permitido', { contentType: 'video/x-matroska' as never }, TypeError],
    ['sin token', { signedUploadToken: '' }, TypeError],
    ['sin path', { objectPath: '' }, TypeError],
    ['sin bucket', { bucket: '' }, TypeError],
  ])('%s → error, sin requests', (_, overrides, errorType) => {
    expect(() => uploader(overrides)).toThrow(errorType)
    expect(server.requests).toHaveLength(0)
  })

  it('más de 50 MiB → RangeError, sin requests', () => {
    const big = new File([new Uint8Array(4)], 'v.mp4', { type: 'video/mp4' })
    Object.defineProperty(big, 'size', { value: MAX_VIDEO_SIZE_BYTES + 1 })
    expect(() => uploader({ file: big })).toThrow(RangeError)
    expect(server.requests).toHaveLength(0)
  })
})

describe('helpers', () => {
  it.each([
    [0, 100, 0],
    [50, 100, 50],
    [99.9, 100, 99],
    [100, 100, 100],
    [150, 100, 100],
    [-5, 100, 0],
    [10, 0, 0],
    [Number.NaN, 100, 0],
  ])('uploadProgressPercent(%s, %s) → %s', (sent, total, expected) => {
    expect(uploadProgressPercent(sent, total)).toBe(expected)
  })
})

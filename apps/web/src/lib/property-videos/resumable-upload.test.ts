import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Upload } from 'tus-js-client'
import {
  NO_URL_STORAGE,
  RESUMABLE_UPLOAD_RETRY_DELAYS_MS,
  SUPABASE_SIGNED_RESUMABLE_UPLOAD_PATH,
  SUPABASE_TUS_CHUNK_SIZE_BYTES,
  assertUploadDestination,
  buildTusOptions,
  classifyUploadFailure,
  createResumableVideoUpload,
  createResumableVideoUploadForTesting,
  isSupabaseProjectRef,
  signedTokenExpiryMs,
  supabaseProjectRefFromUrl,
  supabaseSignedResumableUploadEndpoint,
  uploadProgressPercent,
  type CancelTermination,
  type ResumableUploadResult,
  type ResumableUploadStatus,
  type ResumableUploadTestSeam,
  type ResumableVideoUploadInput,
} from './resumable-upload'
import { LEGACY_VIDEO_UPLOAD_MAX_BYTES, MAX_VIDEO_SIZE_BYTES } from './limits'
import {
  FAKE_SIGNED_ROUTE_REJECTION,
  FakeTusServer,
  STORAGE_BASE_ROUTE_REJECTION,
  decodeTusMetadata,
} from '@/testing/fake-tus'

// Property Videos Fase 2A / 2B0.1 — uploader TUS directo a Supabase Storage,
// todavía sin conectar a la UI. Corre contra el tus-js-client REAL (build de
// browser, ver vitest.config.mts) con un servidor TUS en memoria que refleja
// el contrato real de Storage (src/testing/fake-tus.ts). El servidor falso se
// inyecta por el seam de tests: el destino de las requests sigue siendo el
// endpoint que el uploader arma con el ref del proyecto.

const MB = 1024 * 1024
const PROJECT_REF = 'abcdefghijklmnopqrst'
const STORAGE_HOST = `${PROJECT_REF}.storage.supabase.co`
const ORIGIN = `https://${STORAGE_HOST}`
const SIGNED_ENDPOINT = `${ORIGIN}/storage/v1/upload/resumable/sign`
const BASE_ENDPOINT = `${ORIGIN}/storage/v1/upload/resumable`
const OBJECT_PATH = 'aaaaaaaa-0000-4000-8000-00000000000a/11111111-2222-4000-8000-333333333333.mp4'
// 13 MB → chunks de 6 + 6 + 1 MB. Más grande que el límite legacy (4 MiB): el
// uploader nuevo trabaja con el límite final. Se arma una sola vez.
const VIDEO = new File([new Uint8Array(13 * MB)], 'casa.mp4', { type: 'video/mp4' })
const SESSION_URL = new RegExp(`^${SIGNED_ENDPOINT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/[A-Za-z0-9_-]+$`)

/** JWT de prueba con la forma del token de createSignedUploadUrl (firma falsa: sólo se lee el exp). */
function fakeSignedToken(expSeconds: number): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ url: `property-videos/${OBJECT_PATH}`, scope: 'upload', upsert: false, iat: expSeconds - 7200, exp: expSeconds })}.firma-de-prueba`
}
const nowSeconds = () => Math.floor(Date.now() / 1000)
const TOKEN = fakeSignedToken(nowSeconds() + 7200)

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

const sentBytes = () => server.requests.reduce((n, r) => n + r.bodyBytes, 0)

const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []

beforeEach(() => {
  server = new FakeTusServer(ORIGIN, TOKEN)
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('subida exitosa', () => {
  it('crea la sesión en /sign con un POST sin bytes y sube chunks de 6 MB por PATCH', async () => {
    const upload = uploader()
    expect(upload.status).toBe('idle')

    expect(await upload.start()).toEqual({ status: 'success' })
    expect(upload.status).toBe('success')
    expect(statuses).toEqual(['uploading', 'success'])

    expect(server.requests.map((r) => [r.method, r.bodyBytes])).toEqual([
      ['POST', 0],
      ['PATCH', 6 * MB],
      ['PATCH', 6 * MB],
      ['PATCH', 1 * MB],
    ])
    expect(server.requests[0]!.url).toBe(SIGNED_ENDPOINT)
    for (const patch of server.requestsOf('PATCH')) expect(patch.url).toMatch(SESSION_URL)
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

describe('creación sin datos (uploadDataDuringCreation: false)', () => {
  it('el POST inicial no lleva ningún byte del File', async () => {
    await uploader().start()
    const [post] = server.requestsOf('POST')
    expect(post!.bodyBytes).toBe(0)
    expect(post!.bodyIsBlob).toBe(false)
    expect(post!.headers).not.toHaveProperty('content-type')
    expect(post!.headers['upload-length']).toBe(String(13 * MB))
  })

  it('el primer contenido real sale en un PATCH desde el offset 0', async () => {
    await uploader().start()
    const first = server.requests.find((r) => r.bodyBytes > 0)!
    expect(first.method).toBe('PATCH')
    expect(first.headers['upload-offset']).toBe('0')
    expect(first.headers['content-type']).toBe('application/offset+octet-stream')
  })

  it('si el POST falla, se transfieren 0 bytes del video', async () => {
    server.failNext('POST', { kind: 'status', status: 400, body: FAKE_SIGNED_ROUTE_REJECTION })
    expect(await uploader().start()).toEqual({ status: 'authorization_error', httpStatus: 400 })
    expect(server.requests).toHaveLength(1)
    expect(sentBytes()).toBe(0)
  })

  it('una firma que /sign no acepta también se detecta con 0 bytes enviados', async () => {
    expect(await uploader({ signedUploadToken: fakeSignedToken(nowSeconds() + 7200).replace('firma-de-prueba', 'otra') }).start())
      .toEqual({ status: 'authorization_error', httpStatus: 400 })
    expect(sentBytes()).toBe(0)
  })
})

describe('contrato real de Storage (reflejado en el fake)', () => {
  it('el endpoint base con x-signature y sin Authorization responde lo que respondió Storage real', async () => {
    const req = server.createRequest('POST', BASE_ENDPOINT)
    req.setHeader('Tus-Resumable', '1.0.0')
    req.setHeader('x-signature', TOKEN)
    req.setHeader('Upload-Length', '100')
    const res = await req.send(null)
    expect(res.getStatus()).toBe(400)
    expect(JSON.parse(res.getBody())).toEqual({ statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Invalid Compact JWS' })
  })

  it('formato EXACTO del Location observado en Storage real (smoke 2B0.1)', () => {
    // Observado: absoluto, https, host <ref>.storage.supabase.co exacto, sin
    // puerto/userinfo/query/hash, /storage/v1/upload/resumable/sign/<id> con
    // <id> = un único segmento base64url sin padding de
    // "property-videos/{objectName}/{versión UUID}": 191 caracteres para un
    // path de la forma {tenant}/qa-tus-smoke-{uuid}.mp4.
    const objectName = 'aaaaaaaa-0000-4000-8000-00000000000a/qa-tus-smoke-11111111-2222-4000-8000-333333333333.mp4'
    const id = Buffer.from(`property-videos/${objectName}/44444444-5555-4666-8777-888888888888`, 'utf8').toString('base64url')
    const observed = `${SIGNED_ENDPOINT}/${id}`
    expect(id).toHaveLength(191)
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(observed).toMatch(SESSION_URL)
    for (const method of ['HEAD', 'PATCH', 'DELETE']) expect(() => assertUploadDestination(method, observed, SIGNED_ENDPOINT)).not.toThrow()
    // POST sólo crea contra el endpoint, nunca contra una sesión.
    expect(() => assertUploadDestination('POST', observed, SIGNED_ENDPOINT)).toThrow()
    // El mismo id bajo el endpoint base (sin /sign) no se acepta.
    expect(() => assertUploadDestination('PATCH', `${BASE_ENDPOINT}/${id}`, SIGNED_ENDPOINT)).toThrow()
  })

  it('el Location del fake conserva /sign y el id es un único segmento base64url', async () => {
    await uploader().start()
    const sessionUrls = [...new Set(server.requestsOf('PATCH').map((r) => r.url))]
    expect(sessionUrls).toHaveLength(1)
    expect(sessionUrls[0]).toMatch(SESSION_URL)
  })

  it('regresión 2B0: la implementación vieja (endpoint base + datos en la creación) falla como en Storage real', async () => {
    const result = await new Promise<ResumableUploadResult>((resolve) => {
      new Upload(VIDEO, {
        ...buildTusOptions(input(), {
          onSuccess: () => resolve({ status: 'success' }),
          onError: (error) => resolve(classifyUploadFailure(error)),
        }, { httpStack: server, retryDelaysMs: [] }),
        endpoint: BASE_ENDPOINT,
        uploadDataDuringCreation: true,
        onBeforeRequest: undefined, // el control de destino viejo aceptaba el endpoint base
      }).start()
    })
    expect(result).toEqual({ status: 'authorization_error', httpStatus: 400 }) // ya no "expired_token"
    expect(server.requests.map((r) => [r.method, r.url, r.bodyBytes])).toEqual([['POST', BASE_ENDPOINT, 6 * MB]]) // 6 MiB perdidos
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
    expect(decodeTusMetadata(post!.headers['upload-metadata']!)).toEqual({
      bucketName: 'property-videos',
      objectName: OBJECT_PATH,
      contentType: 'video/mp4',
      cacheControl: '3600',
    })
  })

  it('configuración de tus-js-client: endpoint firmado, creación sin datos, chunk de 6 MB, sin persistencia', async () => {
    const options = buildTusOptions(input(), {})
    expect(options.endpoint).toBe(SIGNED_ENDPOINT)
    expect(options.uploadDataDuringCreation).toBe(false)
    expect(options.chunkSize).toBe(6 * MB)
    expect(options.headers).toEqual({ 'x-signature': TOKEN, 'x-upsert': 'false' })
    expect(options.storeFingerprintForResuming).toBe(false)
    expect(options.urlStorage).toBe(NO_URL_STORAGE)
    expect(options.retryDelays).toEqual([...RESUMABLE_UPLOAD_RETRY_DELAYS_MS])
    expect(options.httpStack).toBeUndefined() // producción: el XMLHttpRequest del browser

    await NO_URL_STORAGE.addUpload('fingerprint', { size: 1, metadata: {}, creationTime: '', urlStorageKey: '', uploadUrl: `${SIGNED_ENDPOINT}/x`, parallelUploadUrls: null })
    expect(await NO_URL_STORAGE.findAllUploads()).toEqual([])
    expect(await NO_URL_STORAGE.findUploadsByFingerprint('fingerprint')).toEqual([])
  })
})

describe('endpoint cerrado al proyecto', () => {
  it('el endpoint firmado se arma sólo a partir del ref', () => {
    expect(SUPABASE_SIGNED_RESUMABLE_UPLOAD_PATH).toBe('/storage/v1/upload/resumable/sign')
    expect(supabaseSignedResumableUploadEndpoint(PROJECT_REF)).toBe(SIGNED_ENDPOINT)
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
    expect(() => supabaseSignedResumableUploadEndpoint(projectRef)).toThrow(TypeError)
    expect(() => uploader({ projectRef })).toThrow(TypeError)
    expect(() => createResumableVideoUpload(input({ projectRef }))).toThrow(TypeError)
    expect(server.requests).toHaveLength(0)
  })

  it('la API productiva no acepta un endpoint (ni por tipo ni en runtime)', async () => {
    // @ts-expect-error — ResumableVideoUploadInput no tiene `endpoint`
    const conEndpoint: ResumableVideoUploadInput = { ...input(), endpoint: 'https://evil.example.com/storage/v1/upload/resumable/sign' }
    expect(createResumableVideoUpload.length).toBe(1) // sin parámetro de transporte
    // Aunque se cuele en runtime, se ignora: todo va al Storage del proyecto.
    expect(await createResumableVideoUploadForTesting(conEndpoint, { httpStack: server }).start()).toEqual({ status: 'success' })
    expect(foreignRequests()).toEqual([])
  })

  it('todo el tráfico va al endpoint firmado del proyecto; fetch (el transporte de las Server Actions) no se usa', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await uploader().start()
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const request of server.requests) {
      expect(request.url === SIGNED_ENDPOINT || SESSION_URL.test(request.url)).toBe(true)
    }
    expect(server.requests.filter((r) => r.bodyBytes > 0).every((r) => r.bodyIsBlob)).toBe(true)
  })

  it.each([
    ['otro origen', (id: string) => `https://evil.example.com/storage/v1/upload/resumable/sign/${id}`],
    ['subdominio parecido', (id: string) => `https://${STORAGE_HOST}.evil.com/storage/v1/upload/resumable/sign/${id}`],
    ['host de la API (no el de Storage)', (id: string) => `https://${PROJECT_REF}.supabase.co/storage/v1/upload/resumable/sign/${id}`],
    ['mismo host por http', (id: string) => `http://${STORAGE_HOST}/storage/v1/upload/resumable/sign/${id}`],
    ['mismo host, otro puerto', (id: string) => `https://${STORAGE_HOST}:8443/storage/v1/upload/resumable/sign/${id}`],
    ['mismo host con userinfo', (id: string) => `https://user:pass@${STORAGE_HOST}/storage/v1/upload/resumable/sign/${id}`],
    ['endpoint base, sin /sign', (id: string) => `${BASE_ENDPOINT}/${id}`],
    ['otro path del mismo host', (id: string) => `https://${STORAGE_HOST}/storage/v1/object/property-videos/${id}`],
    ['path parecido', (id: string) => `https://${STORAGE_HOST}/storage/v1/upload/resumable/sign-evil/${id}`],
    ['query agregada', (id: string) => `${SIGNED_ENDPOINT}/${id}?redirect=https://evil.example.com`],
    ['hash agregado', (id: string) => `${SIGNED_ENDPOINT}/${id}#x`],
    ['segmento extra', (id: string) => `${SIGNED_ENDPOINT}/${id}/extra`],
    ['traversal', (id: string) => `${SIGNED_ENDPOINT}/../../object/${id}`],
    ['traversal codificado', (id: string) => `${SIGNED_ENDPOINT}/%2e%2e/%2e%2e/object/${id}`],
    ['sin id', () => `${SIGNED_ENDPOINT}/`],
    ['relativo fuera de /sign', (id: string) => `/storage/v1/object/${id}`],
  ])('Location de Storage hacia %s: ni el File ni x-signature salen; storage_error sin reintentos', async (_, location) => {
    server.locationFor = location
    const upload = uploader()
    expect(await upload.start()).toEqual({ status: 'storage_error', reason: 'unexpected_upload_url' })
    expect(foreignRequests()).toEqual([])
    // Sólo la creación (sin bytes), contra el endpoint firmado; ningún PATCH a la URL rechazada.
    expect(server.requests.map((r) => [r.method, r.url, r.bodyBytes])).toEqual([['POST', SIGNED_ENDPOINT, 0]])
    // Y un único intento contra ese destino (cortado antes de enviarse): no se reintenta.
    expect(server.created.filter((r) => r.url !== SIGNED_ENDPOINT)).toHaveLength(1)
  })

  it('un Location relativo debajo de /sign es válido', async () => {
    server.locationFor = (id) => `/storage/v1/upload/resumable/sign/${id}`
    expect(await uploader().start()).toEqual({ status: 'success' })
    expect(foreignRequests()).toEqual([])
  })

  it.each([
    ['POST', SIGNED_ENDPOINT, true],
    ['POST', `${SIGNED_ENDPOINT}/abc`, false],
    ['POST', BASE_ENDPOINT, false],
    ['PATCH', `${SIGNED_ENDPOINT}/YWJj_ZGVm-Z2hp`, true],
    ['HEAD', `${SIGNED_ENDPOINT}/YWJj_ZGVm-Z2hp`, true],
    ['DELETE', `${SIGNED_ENDPOINT}/YWJj_ZGVm-Z2hp`, true],
    ['PATCH', SIGNED_ENDPOINT, false],
    ['PATCH', `${SIGNED_ENDPOINT}/`, false],
    ['PATCH', `${SIGNED_ENDPOINT}/abc=`, false],
    ['PATCH', `${SIGNED_ENDPOINT}/abc+def`, false],
    ['PATCH', `${SIGNED_ENDPOINT}/abc/def`, false],
    ['PATCH', `${SIGNED_ENDPOINT}/abc?x=1`, false],
    ['PATCH', `${BASE_ENDPOINT}/abc`, false],
    ['PATCH', `https://evil.example.com/storage/v1/upload/resumable/sign/abc`, false],
    ['PATCH', 'no es una url', false],
  ])('assertUploadDestination(%s %j) → permitido=%s', (method, url, allowed) => {
    const check = () => assertUploadDestination(method, url, SIGNED_ENDPOINT)
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

describe('cancelar: estado local, carreras y terminación de la sesión TUS', () => {
  const methods = () => server.requests.map((r) => r.method)
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Arranca, deja el primer PATCH colgado (con 64 KiB parciales al abortar, como en real) y cancela. */
  async function cancelDuringPatch(seam: Partial<ResumableUploadTestSeam> = {}) {
    server.failNext('PATCH', { kind: 'hang', partialBytesOnAbort: 65_536 })
    const upload = uploader({}, seam)
    const resultPromise = upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))
    const termination = await upload.cancel()
    return { upload, result: await resultPromise, termination }
  }

  it('cancel antes de crear la sesión (antes del POST): cancelled, no_session y ninguna request sale', async () => {
    const upload = uploader()
    const result = upload.start() // tus-js-client abre el archivo de forma asíncrona antes del POST
    expect(await upload.cancel()).toBe('no_session')
    expect(await result).toEqual({ status: 'cancelled' })
    await sleep(30)
    // La carrera de tus-js-client: al terminar de abrir el archivo resetea su
    // flag de abort y arma el POST igual. El control lo corta, y como la
    // cancelación no se reintenta, se arma una sola vez (sin bucle).
    expect(server.created.filter((r) => r.method === 'POST')).toHaveLength(1)
    expect(server.requests).toEqual([])
    expect(upload.status).toBe('cancelled')
    expect(statuses).toEqual(['uploading', 'cancelled'])
  })

  it('cancel con el POST en vuelo: lo aborta; sin Location no hay nada que terminar (no_session, sin HEAD/DELETE)', async () => {
    server.failNext('POST', { kind: 'hang' })
    const upload = uploader()
    const result = upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))
    expect(await upload.cancel()).toBe('no_session')
    expect(await result).toEqual({ status: 'cancelled' })
    expect(server.hanging[0]!.aborted).toBe(true)
    await sleep(30)
    expect(methods()).toEqual(['POST'])
  })

  it('cancel entre el 201 y el primer PATCH: el PATCH no sale; HEAD + DELETE una vez sobre la sesión', async () => {
    const upload = uploader()
    const holder: { cancelling?: Promise<CancelTermination> } = {}
    server.onCreateRequest = (method) => {
      if (method === 'PATCH' && !holder.cancelling) holder.cancelling = upload.cancel()
    }
    expect(await upload.start()).toEqual({ status: 'cancelled' })
    expect(await holder.cancelling).toBe('termination_success')
    expect(methods()).toEqual(['POST', 'HEAD', 'DELETE'])
    expect(server.created.filter((r) => r.method === 'PATCH')).toHaveLength(1) // armado, nunca enviado
    expect(server.sessions()).toEqual([])
  })

  it('cancel durante un PATCH: aborta el chunk y libera la sesión parcial (HEAD 200 → DELETE 204 → HEAD 404)', async () => {
    server.failNext('PATCH', { kind: 'hang', partialBytesOnAbort: 65_536 })
    const upload = uploader()
    const resultPromise = upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))
    const progressAtCancel = progress.length

    const termination = upload.cancel()
    expect(upload.status).toBe('cancelled') // en el acto, antes de terminar la sesión
    expect(upload.termination).toBe('pending')
    expect(await resultPromise).toEqual({ status: 'cancelled' })
    expect(server.hanging[0]!.aborted).toBe(true)
    expect(server.sessions()).toEqual([{ offset: 65_536, length: 13 * MB, complete: false }]) // parcial, como en real

    expect(await termination).toBe('termination_success')
    expect(upload.termination).toBe('termination_success')
    expect(methods()).toEqual(['POST', 'PATCH', 'HEAD', 'DELETE'])
    expect(server.sessions()).toEqual([])

    const sessionUrl = server.requestsOf('DELETE')[0]!.url
    const head = server.createRequest('HEAD', sessionUrl)
    head.setHeader('Tus-Resumable', '1.0.0')
    head.setHeader('x-signature', TOKEN)
    expect((await head.send(null)).getStatus()).toBe(404)

    await sleep(30)
    expect(progress).toHaveLength(progressAtCancel) // 0 progreso después de cancelar
    expect(statuses).toEqual(['uploading', 'cancelled'])
  })

  it('la terminación va SOLO a la URL de sesión firmada, con x-signature y sin otras credenciales', async () => {
    await cancelDuringPatch()
    const termination = server.requests.filter((r) => r.method === 'HEAD' || r.method === 'DELETE')
    expect(termination.map((r) => r.method)).toEqual(['HEAD', 'DELETE'])
    for (const request of termination) {
      expect(request.url).toMatch(SESSION_URL)
      expect(Object.keys(request.headers).sort()).toEqual(['tus-resumable', 'x-signature'])
      expect(request.headers['x-signature']).toBe(TOKEN)
    }
    expect(foreignRequests()).toEqual([])
  })

  it.each([
    [404, 'termination_success'], // ya no existía: idempotente
    [410, 'termination_success'],
    [423, 'termination_failed'],
    [500, 'termination_failed'],
    [503, 'termination_failed'],
  ] as const)('DELETE %s → sigue cancelled, %s, un solo DELETE (sin reintentos)', async (deleteStatus, expected) => {
    server.failNext('DELETE', { kind: 'status', status: deleteStatus })
    const { upload, result, termination } = await cancelDuringPatch()
    expect(result).toEqual({ status: 'cancelled' })
    expect(termination).toBe(expected)
    await sleep(30)
    expect(server.requestsOf('DELETE')).toHaveLength(1)
    expect(upload.status).toBe('cancelled')
  })

  it('DELETE sin red → termination_failed, un solo DELETE, sigue cancelled', async () => {
    server.failNext('DELETE', { kind: 'network' })
    const { upload, termination } = await cancelDuringPatch()
    expect(termination).toBe('termination_failed')
    await sleep(30)
    expect(server.requestsOf('DELETE')).toHaveLength(1)
    expect(upload.status).toBe('cancelled')
  })

  it.each([
    ['sin red', { kind: 'network' } as const, 'termination_failed'],
    ['5xx', { kind: 'status', status: 503 } as const, 'termination_failed'],
    ['404 (la sesión ya no existe)', { kind: 'status', status: 404 } as const, 'termination_success'],
    ['200 sin Upload-Offset ni Upload-Length (sin datos)', { kind: 'status', status: 200 } as const, 'termination_skipped'],
    ['200 con Upload-Length pero sin Upload-Offset', { kind: 'status', status: 200, headers: { 'Upload-Length': String(13 * MB) } } as const, 'termination_skipped'],
  ])('HEAD %s → %s y ningún DELETE a ciegas', async (_, fault, expected) => {
    server.failNext('HEAD', fault)
    const { upload, termination } = await cancelDuringPatch()
    expect(termination).toBe(expected)
    expect(server.requestsOf('DELETE')).toHaveLength(0)
    expect(upload.status).toBe('cancelled')
  })

  it('HEAD colgado → se corta por tiempo: termination_failed, sin DELETE', async () => {
    server.failNext('HEAD', { kind: 'hang' })
    const { termination } = await cancelDuringPatch({ terminationTimeoutMs: 30 })
    expect(termination).toBe('termination_failed')
    expect(server.requestsOf('HEAD')[0]!.aborted).toBe(true)
    expect(server.requestsOf('DELETE')).toHaveLength(0)
  })

  it('el último chunk llegó entero al servidor pero no su respuesta: HEAD ve la subida completa → termination_skipped, NUNCA DELETE', async () => {
    const small = new File([new Uint8Array(1 * MB)], 'corto.mp4', { type: 'video/mp4' })
    server.failNext('PATCH', { kind: 'complete-then-hang' })
    const upload = uploader({ file: small })
    const result = upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))
    expect(server.sessions()).toEqual([{ offset: MB, length: MB, complete: true }])

    expect(await upload.cancel()).toBe('termination_skipped')
    expect(await result).toEqual({ status: 'cancelled' })
    expect(server.requestsOf('DELETE')).toHaveLength(0)
    expect(server.sessions()).toEqual([{ offset: MB, length: MB, complete: true }]) // el objeto queda intacto
    expect(statuses).toEqual(['uploading', 'cancelled']) // ningún éxito tardío revive el estado
  })

  it('la respuesta del último PATCH llega DESPUÉS de cancelar: el éxito tardío no revive el estado y no se borra nada', async () => {
    // tus-js-client no revisa su flag de abort al procesar la respuesta de un
    // PATCH: si llega igual, dispara onSuccess. Tiene que ignorarse.
    const small = new File([new Uint8Array(1 * MB)], 'corto.mp4', { type: 'video/mp4' })
    server.failNext('PATCH', { kind: 'late-response', delayMs: 300 })
    const upload = uploader({ file: small })
    const result = upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))

    const termination = upload.cancel()
    expect(await result).toEqual({ status: 'cancelled' })
    expect(await termination).toBe('termination_skipped') // el HEAD ve la subida completa: no se borra
    await sleep(400) // la respuesta tardía ya llegó y tus-js-client la procesó
    expect(server.requestsOf('PATCH')[0]!.aborted).toBe(true)
    expect(upload.status).toBe('cancelled')
    expect(statuses).toEqual(['uploading', 'cancelled'])
    expect(progress.at(-1)).not.toBe(100)
    expect(server.requestsOf('DELETE')).toHaveLength(0)
  })

  it('cancel después de success: no hace nada (ni HEAD ni DELETE) y sigue success', async () => {
    const upload = uploader()
    expect(await upload.start()).toEqual({ status: 'success' })
    const count = server.requests.length
    expect(await upload.cancel()).toBe('not_cancelled')
    expect(upload.status).toBe('success')
    expect(upload.termination).toBe('not_cancelled')
    await sleep(30)
    expect(server.requests).toHaveLength(count)
    expect(server.sessions()[0]!.complete).toBe(true)
  })

  it('cancel dos veces: misma promesa, un solo HEAD y un solo DELETE', async () => {
    server.failNext('PATCH', { kind: 'hang' })
    const upload = uploader()
    void upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))
    const first = upload.cancel()
    const second = upload.cancel()
    expect(second).toBe(first)
    expect(await first).toBe('termination_success')
    expect(await upload.cancel()).toBe('termination_success')
    await sleep(30)
    expect(server.requestsOf('HEAD')).toHaveLength(1)
    expect(server.requestsOf('DELETE')).toHaveLength(1)
  })

  it('cancel después de un network_error con la sesión creada: también la termina', async () => {
    server.failNext('PATCH', { kind: 'network' })
    const upload = uploader({}, { retryDelaysMs: [] })
    expect(await upload.start()).toEqual({ status: 'network_error' })
    expect(await upload.cancel()).toBe('termination_success')
    expect(upload.status).toBe('cancelled')
    expect(methods()).toEqual(['POST', 'PATCH', 'HEAD', 'DELETE'])
  })

  it('una URL de sesión rechazada por el control de destino no se intenta terminar (no_session)', async () => {
    server.locationFor = (id) => `https://evil.example.com/storage/v1/upload/resumable/sign/${id}`
    const upload = uploader()
    expect(await upload.start()).toEqual({ status: 'storage_error', reason: 'unexpected_upload_url' })
    expect(await upload.cancel()).toBe('no_session')
    expect(foreignRequests()).toEqual([])
    expect(methods()).toEqual(['POST'])
  })

  it('AbortSignal a mitad de la subida → cancelled y la sesión se termina igual', async () => {
    server.failNext('PATCH', { kind: 'hang' })
    const controller = new AbortController()
    const upload = uploader({ signal: controller.signal })
    const result = upload.start()
    await vi.waitFor(() => expect(server.hanging).toHaveLength(1))
    controller.abort()
    expect(await result).toEqual({ status: 'cancelled' })
    await vi.waitFor(() => expect(upload.termination).toBe('termination_success'))
    expect(server.requestsOf('DELETE')).toHaveLength(1)
  })

  it('signal ya abortado antes de empezar → cancelled sin ningún request', async () => {
    const controller = new AbortController()
    controller.abort()
    const upload = uploader({ signal: controller.signal })
    expect(await upload.start()).toEqual({ status: 'cancelled' })
    await sleep(30)
    expect(server.requests).toHaveLength(0)
    expect(upload.termination).toBe('no_session')
  })

  it('cancelar es definitivo: start() posterior no sube', async () => {
    const upload = uploader()
    expect(await upload.cancel()).toBe('no_session')
    expect(await upload.start()).toEqual({ status: 'cancelled' })
    await sleep(30)
    expect(server.requests).toHaveLength(0)
  })

  it('ni resultados ni diagnóstico llevan URL de sesión, token ni path', async () => {
    const { result, termination } = await cancelDuringPatch()
    const sessionId = server.requestsOf('DELETE')[0]!.url.split('/').pop()!
    const serialized = JSON.stringify([result, termination])
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain(sessionId)
    expect(serialized).not.toContain(OBJECT_PATH)
    expect(serialized).not.toContain('supabase.co')
  })
})

describe('retry / resume', () => {
  it('red caída en un chunk: reintenta solo, consulta el offset con HEAD y sigue (un único POST)', async () => {
    server.failNext('PATCH', { kind: 'network' })
    expect(await uploader().start()).toEqual({ status: 'success' })
    expect(server.requests.map((r) => r.method)).toEqual(['POST', 'PATCH', 'HEAD', 'PATCH', 'PATCH', 'PATCH'])
    expect([...server.uploads.values()][0]!.offset).toBe(13 * MB)
  })

  it('corte a mitad de un chunk: reanuda desde el offset que tiene el servidor, no desde cero', async () => {
    server.failNext('PATCH', { kind: 'partial-then-network' })
    expect(await uploader().start()).toEqual({ status: 'success' })
    const patches = server.requestsOf('PATCH')
    // El primer PATCH (6 MB) quedó cortado en 3 MB → el siguiente arranca en 3 MB.
    expect(patches[1]!.headers['upload-offset']).toBe(String(3 * MB))
    expect(sentBytes()).toBeLessThan(13 * MB + 6 * MB)
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

  it('resume no es indefinido: si Storage ya no reconoce la sesión, se recrea desde el byte 0', async () => {
    server.failNext('PATCH', { kind: 'network' })
    const upload = uploader({}, { retryDelaysMs: [] })
    expect(await upload.start()).toEqual({ status: 'network_error' })

    server.expireUploads()
    expect(await upload.start()).toEqual({ status: 'success' })
    expect(server.requests.map((r) => r.method)).toEqual(['POST', 'PATCH', 'HEAD', 'POST', 'PATCH', 'PATCH', 'PATCH'])
    expect(server.requests[4]!.headers['upload-offset']).toBe('0') // vuelve a mandar desde el principio
  })

  it('sesión vencida y token ya vencido (claim exp): expired_token, hay que volver a prepare', async () => {
    server.failNext('PATCH', { kind: 'network' })
    const upload = uploader({}, { retryDelaysMs: [] })
    await upload.start()

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 1000) // pasan las 2 h de la firma
    server.expireUploads()
    server.failNext('POST', { kind: 'status', status: 400, body: FAKE_SIGNED_ROUTE_REJECTION })
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
  it('firma rechazada con el token vigente → authorization_error (nunca expired_token), definitivo', async () => {
    const upload = uploader({ signedUploadToken: fakeSignedToken(nowSeconds() + 7200).replace('firma-de-prueba', 'otra') })
    expect(await upload.start()).toEqual({ status: 'authorization_error', httpStatus: 400 })
    expect(server.requests).toHaveLength(1)
    expect(await upload.start()).toEqual({ status: 'authorization_error', httpStatus: 400 })
    expect(server.requests).toHaveLength(1)
  })

  it('firma rechazada con el token ya vencido según su exp → expired_token, definitivo', async () => {
    const upload = uploader({ signedUploadToken: fakeSignedToken(nowSeconds() - 60) })
    expect(await upload.start()).toEqual({ status: 'expired_token', httpStatus: 400 })
    expect(await upload.start()).toEqual({ status: 'expired_token', httpStatus: 400 })
    expect(server.requests).toHaveLength(1)
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

  // Credencial rechazada: HTTP 401/403, o HTTP 400 con statusCode 401/403 en
  // el body (el estilo real de Storage). Sin evidencia de vencimiento →
  // authorization_error; con el token vencido según su exp → expired_token.
  const CREDENTIAL_REJECTIONS: Array<[number, string]> = [
    [401, ''],
    [403, ''],
    [403, '{"error":"Unauthorized"}'],
    [400, STORAGE_BASE_ROUTE_REJECTION], // observado en el smoke 2B0
    [400, '{"statusCode":"401","error":"Unauthorized","message":"x"}'],
    [400, '{"statusCode":403,"message":"numérico"}'],
  ]

  it.each(CREDENTIAL_REJECTIONS)('%s %s, token vigente → authorization_error', (status, body) => {
    expect(classifyUploadFailure({ originalResponse: res(status, body) }, { tokenExpired: false })).toEqual({ status: 'authorization_error', httpStatus: status })
  })

  it.each(CREDENTIAL_REJECTIONS)('%s %s, token vencido → expired_token', (status, body) => {
    expect(classifyUploadFailure({ originalResponse: res(status, body) }, { tokenExpired: true })).toEqual({ status: 'expired_token', httpStatus: status })
  })

  it('"Invalid Compact JWS", 400 o AccessDenied NO alcanzan para decir "vencido"', () => {
    expect(classifyUploadFailure({ originalResponse: res(400, STORAGE_BASE_ROUTE_REJECTION) })).toEqual({ status: 'authorization_error', httpStatus: 400 })
    expect(classifyUploadFailure({ originalResponse: res(400, '{"code":"AccessDenied","message":"Invalid Compact JWS"}') })).toEqual({ status: 'storage_error', httpStatus: 400 })
  })

  // Sin estructura de rechazo de credencial no se adivina por el texto, ni
  // siquiera con el token vencido.
  it.each([
    [400, '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}'],
    [400, 'jwt expired'],
    [400, '{"message":"The token has expired"}'],
    [400, 'bucket not found'],
    [404, ''],
    [409, ''],
    [410, ''],
    [413, ''],
    [415, ''],
    [500, ''],
    [503, ''],
  ])('%s %s → storage_error (con o sin token vencido)', (status, body) => {
    for (const tokenExpired of [false, true]) {
      expect(classifyUploadFailure({ originalResponse: res(status, body) }, { tokenExpired })).toEqual({ status: 'storage_error', httpStatus: status })
    }
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

describe('signedTokenExpiryMs (evidencia de vencimiento)', () => {
  it('lee el claim exp del JWT, en ms', () => {
    expect(signedTokenExpiryMs(fakeSignedToken(1_900_000_000))).toBe(1_900_000_000_000)
  })

  it.each([
    ['sin puntos', 'no-es-un-jwt'],
    ['payload que no es base64/JSON', 'a.%%%.b'],
    ['sin exp', `x.${Buffer.from('{"url":"a"}').toString('base64url')}.y`],
    ['exp no numérico', `x.${Buffer.from('{"exp":"mañana"}').toString('base64url')}.y`],
  ])('%s → null (sin evidencia, nunca "vencido")', (_, token) => {
    expect(signedTokenExpiryMs(token)).toBeNull()
  })
})

describe('sin logs ni persistencia de secretos', () => {
  it('los resultados no llevan token, URL de sesión, endpoint ni path', async () => {
    const ok = await uploader().start()
    server.failNext('POST', { kind: 'status', status: 400, body: `jwt expired for ${TOKEN}` })
    const rejected = await uploader().start()
    server.failNext('POST', { kind: 'network' }, 3)
    const network = await uploader().start()
    server.locationFor = (id) => `https://evil.example.com/${id}`
    const foreign = await uploader().start()

    const serialized = JSON.stringify([ok, rejected, network, foreign])
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain(OBJECT_PATH)
    expect(serialized).not.toContain('supabase.co')
    expect(serialized).not.toContain('evil.example.com')
    for (const { url } of server.created) expect(serialized).not.toContain(url.split('/').pop()!)
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

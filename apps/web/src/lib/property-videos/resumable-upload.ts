// Property Videos Fase 2A — subida resumable (TUS) DIRECTA a Supabase Storage.
//
// Todavía NO está conectada a PropertyVideoManager: la subida productiva sigue
// siendo uploadPropertyVideoAction hasta la Fase 2B/2C (ver limits.ts). Este
// módulo usa el límite FINAL (MAX_VIDEO_SIZE_BYTES, 50 MiB), no el temporal
// del transporte legacy.
//
// Flujo final previsto: prepare (servidor: valida y emite un token de
// createSignedUploadUrl para {tenant}/{uuid}.{ext}) → ESTE módulo sube el
// archivo desde el browser directo a Storage → finalize (servidor: inspecciona
// el objeto por rangos y recién ahí lo registra). El File nunca pasa por una
// Server Action ni por una ruta de ReservaNex.
//
// Contrato con Supabase (TUS 1.0) — verificado físicamente contra Storage
// real (smokes 2B0 y 2B0.1, video MP4 de 16 MB) y su código fuente
// (src/http/routes/tus):
//   · las subidas FIRMADAS van a /storage/v1/upload/resumable/sign. El endpoint
//     base (/upload/resumable) autentica con Authorization (JWT) e ignora la
//     firma: con sólo x-signature responde 400 {"statusCode":"403",
//     "code":"AccessDenied","error":"Unauthorized","message":"Invalid Compact JWS"};
//   · la ÚNICA credencial es el token firmado, en el header `x-signature`
//     (+ x-upsert): en /sign alcanza, sin Authorization ni apikey. Nada de anon
//     key ni service role; nunca en la URL;
//   · x-upsert: false → si el objeto ya existe, Storage rechaza (no pisa);
//   · creación SIN datos (uploadDataDuringCreation: false): POST → 201 sin
//     un solo byte del video (la firma se valida antes); los chunks van por
//     PATCH → 204, con Upload-Offset;
//   · chunks de exactamente 6 MB (requisito de Supabase), el último puede ser menor;
//   · la URL de sesión (Location) es absoluta, en el mismo host:
//     https://<ref>.storage.supabase.co/storage/v1/upload/resumable/sign/<id>,
//     con <id> = un solo segmento base64url de {bucket}/{objeto}/{versión};
//   · CORS: Storage expone Location y Upload-Offset al browser;
//   · DELETE sobre la URL de sesión (con x-signature) termina una subida
//     incompleta (204; después HEAD → 404). Un PATCH abortado puede dejar
//     bytes parciales en la sesión (observado: 64 KiB);
//   · metadata: sólo bucketName, objectName, contentType y cacheControl (el
//     mismo 3600 que usa la subida legacy; el objeto queda con
//     max-age=3600). Nada de tenant, propiedad ni usuario aparte del path del
//     objeto, que es el que firmó prepare.
//
// Destino cerrado: el endpoint se ARMA con el ref del proyecto (la API no
// acepta una URL) y TODA request pasa por el mismo control antes del envío:
// el POST de creación sólo al endpoint firmado; HEAD/PATCH/DELETE sólo a una
// URL de sesión /sign/<id> del mismo host, por https, sin puerto, userinfo,
// query ni hash. Así ni el File ni x-signature pueden salir hacia otro lado,
// aunque Storage devolviera un Location ajeno. (Una redirección HTTP la sigue
// el propio browser y queda fuera de este control; el origen es Supabase
// sobre TLS.)
//
// Credenciales y reanudación — dos vidas distintas, sin prometer de más:
//   · signed upload token: vale 2 horas (claim exp, verificado en el smoke);
//   · URL de sesión TUS: su vida la decide Storage (Supabase documenta hasta
//     24 h). No se persiste: vive en memoria en esta instancia, así que
//     recargar la página = empezar de cero (tus-js-client, por defecto, la
//     guarda en localStorage: acá está desactivado);
//   · reanudar NO es indefinido: start() después de network_error o
//     storage_error consulta el offset (HEAD) y sigue; si Storage ya no
//     reconoce la subida, tus-js-client crea una nueva desde el byte 0 con el
//     mismo token.
//
// Cancelar — cancel():
//   1. marca `cancelled` en el acto (resuelve la promesa de start());
//   2. aborta la request en vuelo (POST/PATCH/HEAD) y los reintentos;
//   3. desde ahí NINGUNA request de la subida sale: el control de destino la
//      corta. Esto tapa una carrera de tus-js-client: start() abre el archivo
//      de forma asíncrona y luego resetea su flag de abort, así que un abort
//      en esa ventana no alcanzaba para frenar el POST;
//   4. ningún callback tardío (éxito, error, progreso) revive el estado;
//   5. si ya hay URL de sesión, la termina — best-effort, un solo intento,
//      sin reintentos: HEAD primero y DELETE sólo si la subida sigue
//      incompleta. Si el HEAD muestra la subida completa (el último chunk
//      llegó entero al servidor y la respuesta todavía no), NO borra: nunca
//      se elimina un objeto ya terminado. Que la terminación falle no cambia
//      `cancelled`: la sesión vence sola en Storage. El resultado queda en
//      `termination` (diagnóstico interno, sin URLs ni tokens).
//   Sin URL de sesión (cancelado antes del 201) no hay nada que terminar. Si
//   el POST ya estaba en vuelo, Storage puede haber creado una sesión vacía
//   (0 bytes) que nadie conoce: vence sola.
//
// Errores — clasificación conservadora (sin heurísticas sobre el texto):
//   · credencial rechazada = HTTP 401/403, o el estilo de Storage: HTTP 400
//     con statusCode "401"/"403" en el body JSON (observado en el smoke 2B0);
//   · expired_token sólo si, además, el propio token ya venció según su claim
//     exp (evidencia, no un mensaje); si no, authorization_error. El formato
//     real de un token vencido todavía no se observó en QA;
//   · todo otro error HTTP es storage_error.
//
// Nada de esto se loguea: ni el token, ni el endpoint, ni la URL de sesión.

import {
  Upload,
  defaultOptions,
  type DetailedError,
  type HttpResponse,
  type HttpStack,
  type UploadOptions,
  type UrlStorage,
} from 'tus-js-client'
import { MAX_VIDEO_SIZE_BYTES, isAllowedVideoMimeType, type AllowedVideoMimeType } from './limits'

/** Endpoint TUS de Supabase para subidas FIRMADAS (x-signature). */
export const SUPABASE_SIGNED_RESUMABLE_UPLOAD_PATH = '/storage/v1/upload/resumable/sign'
/** Supabase exige chunks de exactamente 6 MB en TUS. */
export const SUPABASE_TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024
/** Reintentos automáticos ante red caída o 5xx/409/423 (los demás 4xx no se reintentan). */
export const RESUMABLE_UPLOAD_RETRY_DELAYS_MS: readonly number[] = [0, 1_000, 3_000, 5_000, 10_000]
/** Tope de cada request de terminación (HEAD/DELETE): es best-effort, no puede quedar colgada. */
export const TERMINATION_REQUEST_TIMEOUT_MS = 15_000

/** Ref de un proyecto Supabase hosteado: 20 letras minúsculas. */
const PROJECT_REF = /^[a-z]{20}$/
/** Id de sesión TUS de Storage: base64url (sin padding) de {bucket}/{objeto}/{versión}, un solo segmento. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/

export type ResumableUploadStatus =
  | 'idle'
  | 'uploading'
  | 'success'
  | 'cancelled'
  | 'expired_token'       // la firma fue rechazada Y el token ya venció: hay que pedir otro a prepare
  | 'authorization_error' // la firma no fue aceptada (inválida, endpoint equivocado, sin permiso)
  | 'storage_error'       // Storage respondió otro error, o devolvió una URL de sesión fuera del proyecto
  | 'network_error'       // sin respuesta HTTP tras los reintentos

export type ResumableUploadResult =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'expired_token'; httpStatus: number }
  | { status: 'authorization_error'; httpStatus: number }
  | { status: 'storage_error'; httpStatus: number }
  | { status: 'storage_error'; reason: 'unexpected_upload_url' }
  | { status: 'network_error' }

/** Qué pasó con la sesión TUS al cancelar. Diagnóstico interno: sin URLs ni tokens. */
export type CancelTermination =
  | 'not_cancelled'       // no se canceló, o cancel() llegó después de un estado final (p. ej. success)
  | 'pending'             // terminación en curso
  | 'no_session'          // no había URL de sesión válida: nada que terminar
  | 'termination_success' // la sesión ya no existe: DELETE 204, o 404/410
  | 'termination_skipped' // el HEAD mostró la subida completa (o sin datos claros): no se borra
  | 'termination_failed'  // HEAD/DELETE fallaron (red, 5xx, 423, timeout): la sesión vence sola

export interface ResumableVideoUploadInput {
  file: Blob
  /**
   * Ref del proyecto Supabase (20 letras minúsculas). El endpoint se arma acá:
   * https://<ref>.storage.supabase.co/storage/v1/upload/resumable/sign. Ver
   * supabaseProjectRefFromUrl para obtenerlo de NEXT_PUBLIC_SUPABASE_URL.
   */
  projectRef: string
  bucket: string
  /** Path del objeto dentro del bucket, el mismo para el que se firmó el token. */
  objectPath: string
  /** MIME ya validado por el servidor (prepare). */
  contentType: AllowedVideoMimeType
  /** `token` de createSignedUploadUrl(objectPath). */
  signedUploadToken: string
  /** Progreso real 0..100 (bytes enviados / total). Sólo se emite cuando cambia el entero. */
  onProgress?: (percent: number) => void
  onStatusChange?: (status: ResumableUploadStatus) => void
  /** Abortar = cancelar. */
  signal?: AbortSignal
}

/**
 * SOLO TESTS: reemplaza la pila HTTP de tus-js-client (XMLHttpRequest) por un
 * servidor en memoria. No cambia el destino: las requests siguen dirigidas al
 * endpoint del proyecto y pasan por el mismo control de destino.
 */
export interface ResumableUploadTestSeam {
  httpStack: HttpStack
  retryDelaysMs?: readonly number[]
  terminationTimeoutMs?: number
}

export interface ResumableVideoUpload {
  readonly status: ResumableUploadStatus
  /** Resultado de la terminación de la sesión al cancelar (diagnóstico interno). */
  readonly termination: CancelTermination
  /**
   * Arranca, o reanuda tras network_error/storage_error (ver "Credenciales y
   * reanudación" arriba). Mientras sube, devuelve la misma promesa. En
   * success/cancelled/expired_token/authorization_error devuelve ese resultado.
   */
  start(): Promise<ResumableUploadResult>
  /**
   * Cancela (ver "Cancelar" arriba). `status` pasa a `cancelled` en el acto;
   * la promesa resuelve cuando termina el intento de terminar la sesión.
   * Idempotente: llamarla de nuevo devuelve la misma promesa.
   */
  cancel(): Promise<CancelTermination>
}

/** Hooks de una subida para tus-js-client. `ensureActive` corta cualquier request si la subida ya se canceló. */
export interface TusUploadHooks {
  onProgress?: UploadOptions['onProgress']
  onSuccess?: UploadOptions['onSuccess']
  onError?: UploadOptions['onError']
  ensureActive?: () => void
}

export function isSupabaseProjectRef(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_REF.test(value)
}

/** Endpoint TUS firmado del proyecto. Es la ÚNICA forma de construirlo. */
export function supabaseSignedResumableUploadEndpoint(projectRef: string): string {
  if (!isSupabaseProjectRef(projectRef)) throw new TypeError('projectRef inválido: tienen que ser 20 letras minúsculas')
  return `https://${projectRef}.storage.supabase.co${SUPABASE_SIGNED_RESUMABLE_UPLOAD_PATH}`
}

/**
 * Ref del proyecto a partir de la URL pública de Supabase
 * (https://<ref>.supabase.co). Rechaza cualquier otra forma: http, puerto,
 * userinfo, path, query, hash, dominios propios o parecidos.
 */
export function supabaseProjectRefFromUrl(supabaseUrl: string): string {
  let url: URL
  try {
    url = new URL(supabaseUrl)
  } catch {
    throw new TypeError('URL de Supabase inválida')
  }
  const match = /^([a-z]{20})\.supabase\.co$/.exec(url.hostname)
  const clean = url.protocol === 'https:' && !url.port && !url.username && !url.password
    && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash
  if (!match || !clean) throw new TypeError('URL de Supabase inválida: se espera https://<ref>.supabase.co')
  return match[1]!
}

/** Progreso entero 0..100. */
export function uploadProgressPercent(bytesSent: number, bytesTotal: number): number {
  if (!(bytesTotal > 0) || !Number.isFinite(bytesSent)) return 0
  return Math.min(100, Math.max(0, Math.floor((bytesSent / bytesTotal) * 100)))
}

/** URL storage de tus-js-client que no guarda nada: la URL de sesión no sale de la memoria. */
export const NO_URL_STORAGE: UrlStorage = {
  findAllUploads: () => Promise.resolve([]),
  findUploadsByFingerprint: () => Promise.resolve([]),
  removeUpload: () => Promise.resolve(),
  addUpload: () => Promise.resolve(''),
}

/** Una request de la subida apuntaba fuera de donde corresponde: se cortó antes de enviarse. */
class UnexpectedUploadDestinationError extends Error {
  constructor() {
    super('destino de subida fuera del endpoint TUS firmado del proyecto')
    this.name = 'UnexpectedUploadDestinationError'
  }
}

/** La subida ya se canceló: ninguna request suya puede salir. */
class UploadCancelledError extends Error {
  constructor() {
    super('subida cancelada')
    this.name = 'UploadCancelledError'
  }
}

/**
 * Corta (antes del envío) cualquier request que no vaya a donde corresponde:
 * POST (creación) sólo al endpoint firmado; HEAD/PATCH/DELETE sólo a una URL
 * de sesión <endpoint>/<id base64url>. Mismo host, https, sin puerto,
 * userinfo, query ni hash.
 */
export function assertUploadDestination(method: string, requestUrl: string, endpoint: string): void {
  let target: URL
  try {
    target = new URL(requestUrl)
  } catch {
    throw new UnexpectedUploadDestinationError()
  }
  const expected = new URL(endpoint)
  const sameOrigin = target.protocol === 'https:' && target.origin === expected.origin && !target.username && !target.password
  const clean = !target.search && !target.hash
  const sessionId = target.pathname.startsWith(`${expected.pathname}/`) ? target.pathname.slice(expected.pathname.length + 1) : null
  const allowedPath = method.toUpperCase() === 'POST'
    ? target.pathname === expected.pathname
    : sessionId !== null && SESSION_ID.test(sessionId)
  if (!sameOrigin || !clean || !allowedPath) throw new UnexpectedUploadDestinationError()
}

/** Opciones de tus-js-client para una subida. Exportada para verificar la configuración en tests. */
export function buildTusOptions(
  input: ResumableVideoUploadInput,
  hooks: TusUploadHooks,
  seam: ResumableUploadTestSeam | null = null,
): UploadOptions {
  const endpoint = supabaseSignedResumableUploadEndpoint(input.projectRef)
  return {
    endpoint,
    headers: {
      'x-signature': input.signedUploadToken,
      'x-upsert':    'false',
    },
    metadata: {
      bucketName:   input.bucket,
      objectName:   input.objectPath,
      contentType:  input.contentType,
      cacheControl: '3600',
    },
    chunkSize: SUPABASE_TUS_CHUNK_SIZE_BYTES,
    retryDelays: [...(seam?.retryDelaysMs ?? RESUMABLE_UPLOAD_RETRY_DELAYS_MS)],
    uploadDataDuringCreation: false,
    storeFingerprintForResuming: false,
    removeFingerprintOnSuccess: true,
    urlStorage: NO_URL_STORAGE,
    onBeforeRequest: (req) => {
      hooks.ensureActive?.()
      assertUploadDestination(req.getMethod(), req.getURL(), endpoint)
    },
    onShouldRetry: shouldRetryUpload,
    onProgress: hooks.onProgress ?? null,
    onSuccess: hooks.onSuccess ?? null,
    onError: hooks.onError ?? null,
    ...(seam ? { httpStack: seam.httpStack } : {}),
  }
}

/** La subida productiva: destino cerrado al proyecto, transporte XMLHttpRequest del browser. */
export function createResumableVideoUpload(input: ResumableVideoUploadInput): ResumableVideoUpload {
  return createUpload(input, null)
}

/** SOLO TESTS (lo verifica guards.test.ts). Misma subida, con la pila HTTP reemplazada. */
export function createResumableVideoUploadForTesting(input: ResumableVideoUploadInput, seam: ResumableUploadTestSeam): ResumableVideoUpload {
  return createUpload(input, seam)
}

const FINAL_STATUSES: ReadonlySet<ResumableUploadStatus> = new Set(['success', 'cancelled', 'expired_token', 'authorization_error'])

function createUpload(input: ResumableVideoUploadInput, seam: ResumableUploadTestSeam | null): ResumableVideoUpload {
  assertUploadInput(input)
  const endpoint = supabaseSignedResumableUploadEndpoint(input.projectRef)
  const transport: HttpStack = seam?.httpStack ?? defaultOptions.httpStack
  const terminationTimeoutMs = seam?.terminationTimeoutMs ?? TERMINATION_REQUEST_TIMEOUT_MS
  const tokenExpiresAtMs = signedTokenExpiryMs(input.signedUploadToken)

  let status: ResumableUploadStatus = 'idle'
  let lastResult: ResumableUploadResult | null = null
  let inFlight: Promise<ResumableUploadResult> | null = null
  let settle: ((result: ResumableUploadResult) => void) | null = null
  let lastPercent: number | null = null
  let cancelRequested = false
  let termination: CancelTermination = 'not_cancelled'
  let terminationPromise: Promise<CancelTermination> | null = null

  function setStatus(next: ResumableUploadStatus): void {
    if (next === status) return
    status = next
    input.onStatusChange?.(next)
  }

  function finish(result: ResumableUploadResult): void {
    // Un estado final no se revive: callbacks tardíos de tus-js-client (un
    // éxito o un error que llegan después de cancelar) se ignoran.
    if (FINAL_STATUSES.has(status)) return
    lastResult = result
    setStatus(result.status)
    if (FINAL_STATUSES.has(result.status)) input.signal?.removeEventListener('abort', onAbortSignal)
    const resolve = settle
    settle = null
    inFlight = null
    resolve?.(result)
  }

  function reportProgress(bytesSent: number, bytesTotal: number): void {
    if (status !== 'uploading') return
    const percent = uploadProgressPercent(bytesSent, bytesTotal)
    if (percent === lastPercent) return
    lastPercent = percent
    input.onProgress?.(percent)
  }

  const upload = new Upload(input.file, buildTusOptions(input, {
    onProgress: reportProgress,
    onSuccess: () => finish({ status: 'success' }),
    onError: (error) => finish(classifyUploadFailure(error, {
      tokenExpired: tokenExpiresAtMs !== null && Date.now() >= tokenExpiresAtMs,
    })),
    ensureActive: () => {
      if (cancelRequested) throw new UploadCancelledError()
    },
  }, seam))

  /** Una request de terminación (HEAD/DELETE): mismo control de destino, un solo intento, con tope de tiempo. */
  async function sendTerminationRequest(method: 'HEAD' | 'DELETE', sessionUrl: string): Promise<HttpResponse | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      assertUploadDestination(method, sessionUrl, endpoint)
      const req = transport.createRequest(method, sessionUrl)
      req.setHeader('Tus-Resumable', '1.0.0')
      req.setHeader('x-signature', input.signedUploadToken)
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          void req.abort()
          resolve(null)
        }, terminationTimeoutMs)
      })
      return await Promise.race([req.send(null), timeout])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function terminateSession(): Promise<CancelTermination> {
    const sessionUrl = upload.url
    if (!sessionUrl) return 'no_session'
    try {
      assertUploadDestination('DELETE', sessionUrl, endpoint)
    } catch {
      return 'no_session' // una URL rechazada por el control de destino no es una sesión a terminar
    }

    const head = await sendTerminationRequest('HEAD', sessionUrl)
    if (!head) return 'termination_failed'
    const headStatus = head.getStatus()
    if (headStatus === 404 || headStatus === 410) return 'termination_success'
    if (headStatus !== 200) return 'termination_failed'
    const offset = headerNumber(head, 'Upload-Offset')
    const length = headerNumber(head, 'Upload-Length') ?? input.file.size
    // Completa —o sin datos para afirmar lo contrario—: no se borra. Nunca se
    // elimina un objeto que pudo haber quedado terminado.
    if (offset === null || offset >= length) return 'termination_skipped'

    const del = await sendTerminationRequest('DELETE', sessionUrl)
    if (!del) return 'termination_failed'
    const delStatus = del.getStatus()
    return delStatus === 204 || delStatus === 404 || delStatus === 410 ? 'termination_success' : 'termination_failed'
  }

  function cancel(): Promise<CancelTermination> {
    if (terminationPromise) return terminationPromise
    if (FINAL_STATUSES.has(status)) return Promise.resolve(termination)
    cancelRequested = true
    // 1. Estado local en el acto (resuelve start()). Cualquier evento que el
    //    abort dispare de forma sincrónica ya encuentra la subida cancelada.
    finish({ status: 'cancelled' })
    // 2. Cortar la request en vuelo y los reintentos pendientes. abort(false):
    //    el DELETE de tus-js-client reintentaría; la terminación es propia.
    void upload.abort(false)
    // 3. Terminar la sesión, si existe. Best-effort: nunca cambia `cancelled`.
    termination = 'pending'
    terminationPromise = terminateSession().then(
      (outcome) => (termination = outcome),
      () => (termination = 'termination_failed'),
    )
    return terminationPromise
  }

  function onAbortSignal(): void {
    void cancel()
  }

  input.signal?.addEventListener('abort', onAbortSignal, { once: true })

  function start(): Promise<ResumableUploadResult> {
    if (input.signal?.aborted) void cancel()
    if (inFlight) return inFlight
    if (FINAL_STATUSES.has(status) && lastResult) return Promise.resolve(lastResult)

    lastPercent = null
    setStatus('uploading')
    const promise = new Promise<ResumableUploadResult>((resolve) => {
      settle = resolve
    })
    inFlight = promise
    upload.start()
    return promise
  }

  return {
    get status() {
      return status
    },
    get termination() {
      return termination
    },
    start,
    cancel,
  }
}

function headerNumber(response: HttpResponse, header: string): number | null {
  const raw = response.getHeader(header)
  if (raw === undefined || raw === null || raw === '') return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Vencimiento del token firmado (claim exp de su JWT), en ms; null si no se
 * puede leer. Se lee localmente sólo como evidencia para clasificar un
 * rechazo: el token no se valida acá ni sale de este módulo.
 */
export function signedTokenExpiryMs(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const exp: unknown = JSON.parse(atob(base64))?.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

function causedBy(error: unknown, type: new () => Error): boolean {
  return error instanceof type || (error as { causingError?: unknown } | null)?.causingError instanceof type
}

// Mismo criterio que el default de tus-js-client 4.x (reintenta sin respuesta,
// 5xx, 409 y 423, salvo que el browser esté offline), más dos excepciones: un
// destino rechazado y una subida cancelada no se reintentan.
function shouldRetryUpload(error: DetailedError): boolean {
  if (causedBy(error, UnexpectedUploadDestinationError) || causedBy(error, UploadCancelledError)) return false
  const httpStatus = error.originalResponse?.getStatus() ?? 0
  const clientError = httpStatus >= 400 && httpStatus < 500
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return (!clientError || httpStatus === 409 || httpStatus === 423) && !offline
}

/**
 * Error de tus-js-client → resultado tipado. Del error sólo se usa el status
 * HTTP y, del body, el statusCode estructurado de Storage; el mensaje —que
 * trae la URL de sesión— no sale de acá. `tokenExpired` es la evidencia de
 * vencimiento (claim exp del token): sin ella, un rechazo de credencial es
 * authorization_error, nunca expired_token.
 */
export function classifyUploadFailure(error: unknown, context: { tokenExpired?: boolean } = {}): ResumableUploadResult {
  if (causedBy(error, UploadCancelledError)) return { status: 'cancelled' }
  if (causedBy(error, UnexpectedUploadDestinationError)) return { status: 'storage_error', reason: 'unexpected_upload_url' }
  const response = (error as { originalResponse?: HttpResponse | null } | null)?.originalResponse ?? null
  const httpStatus = response?.getStatus() ?? 0
  // Status 0 = el request no tuvo respuesta HTTP (red, CORS, DNS).
  if (!response || !httpStatus) return { status: 'network_error' }
  if (isCredentialRejection(httpStatus, safeBody(response))) {
    return context.tokenExpired ? { status: 'expired_token', httpStatus } : { status: 'authorization_error', httpStatus }
  }
  return { status: 'storage_error', httpStatus }
}

// HTTP 401/403, o el estilo de error de Storage: HTTP 400 con el status real
// en el body (observado: 400 {"statusCode":"403","code":"AccessDenied",...}).
function isCredentialRejection(httpStatus: number, body: string): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true
  if (httpStatus !== 400) return false
  try {
    const statusCode: unknown = JSON.parse(body)?.statusCode
    return statusCode === '401' || statusCode === '403' || statusCode === 401 || statusCode === 403
  } catch {
    return false
  }
}

function safeBody(response: HttpResponse): string {
  try {
    return String(response.getBody() ?? '')
  } catch {
    return ''
  }
}

function assertUploadInput(input: ResumableVideoUploadInput): void {
  if (!(input.file instanceof Blob)) throw new TypeError('file tiene que ser un File/Blob')
  if (input.file.size <= 0 || input.file.size > MAX_VIDEO_SIZE_BYTES) throw new RangeError('tamaño de archivo fuera del límite')
  if (!isAllowedVideoMimeType(input.contentType)) throw new TypeError('contentType no permitido')
  if (!input.bucket || !input.objectPath) throw new TypeError('faltan bucket u objectPath')
  if (!input.signedUploadToken) throw new TypeError('falta el token de subida firmada')
  supabaseSignedResumableUploadEndpoint(input.projectRef)
}

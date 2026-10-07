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
// Contrato con Supabase (TUS 1.0 sobre /storage/v1/upload/resumable):
//   · la ÚNICA credencial es el token firmado, en el header `x-signature`.
//     Nada de Authorization, apikey, anon key ni service role; nunca en la URL;
//   · x-upsert: false → si el objeto ya existe, Storage rechaza (no pisa);
//   · chunks de exactamente 6 MB (requisito de Supabase), el último puede ser menor;
//   · metadata: sólo bucketName, objectName, contentType y cacheControl (el
//     mismo 3600 que usa la subida legacy). Nada de tenant, propiedad ni usuario
//     aparte del path del objeto, que es el que firmó prepare.
//
// Destino cerrado: el endpoint se ARMA con el ref del proyecto (la API no
// acepta una URL) y TODA request —la creación y cada HEAD/PATCH sobre la URL
// que devuelve Storage— pasa por onBeforeRequest, que corta ANTES del envío si
// el destino no es https://<ref>.storage.supabase.co/storage/v1/upload/resumable[/…].
// Así ni el File ni x-signature pueden salir hacia otro origen, aunque Storage
// devolviera un Location ajeno. (Una redirección HTTP la sigue el propio
// browser y queda fuera de este control; el origen es Supabase sobre TLS.)
//
// Credenciales y reanudación — dos vidas distintas, sin prometer de más:
//   · signed upload token: vale 2 horas (fijo en createSignedUploadUrl);
//   · URL de la subida TUS (el Location que devuelve Storage al crearla): su
//     vida la decide Storage (Supabase documenta hasta 24 h). No se persiste:
//     vive en memoria en esta instancia, así que recargar la página = empezar
//     de cero (tus-js-client, por defecto, la guarda en localStorage: acá está
//     desactivado);
//   · reanudar NO es indefinido: start() después de network_error o
//     storage_error consulta el offset (HEAD) y sigue; si Storage ya no
//     reconoce la subida, tus-js-client crea una nueva desde el byte 0 con el
//     mismo token; si el token ya no sirve → expired_token y hay que pedir otro
//     a prepare;
//   · "firma rechazada" se reconoce de forma deliberadamente amplia (401/403,
//     o 400 con jwt/signature/expired/token en el body) hasta validarlo contra
//     Storage real en la Fase 2B; todo otro error HTTP es storage_error.
//
// Nada de esto se loguea: ni el token, ni el endpoint, ni la URL de la subida.

import { Upload, type DetailedError, type HttpResponse, type HttpStack, type UploadOptions, type UrlStorage } from 'tus-js-client'
import { MAX_VIDEO_SIZE_BYTES, isAllowedVideoMimeType, type AllowedVideoMimeType } from './limits'

export const SUPABASE_RESUMABLE_UPLOAD_PATH = '/storage/v1/upload/resumable'
/** Supabase exige chunks de exactamente 6 MB en TUS. */
export const SUPABASE_TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024
/** Reintentos automáticos ante red caída o 5xx/409/423 (los demás 4xx no se reintentan). */
export const RESUMABLE_UPLOAD_RETRY_DELAYS_MS: readonly number[] = [0, 1_000, 3_000, 5_000, 10_000]

/** Ref de un proyecto Supabase hosteado: 20 letras minúsculas. */
const PROJECT_REF = /^[a-z]{20}$/

export type ResumableUploadStatus =
  | 'idle'
  | 'uploading'
  | 'success'
  | 'cancelled'
  | 'expired_token' // Storage rechazó la firma (vencida o inválida): hay que pedir otra a prepare
  | 'storage_error' // Storage respondió un error, o devolvió una URL de subida fuera del proyecto
  | 'network_error' // sin respuesta HTTP tras los reintentos

export type ResumableUploadResult =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'expired_token'; httpStatus: number }
  | { status: 'storage_error'; httpStatus: number }
  | { status: 'storage_error'; reason: 'unexpected_upload_url' }
  | { status: 'network_error' }

export interface ResumableVideoUploadInput {
  file: Blob
  /**
   * Ref del proyecto Supabase (20 letras minúsculas). El endpoint se arma acá:
   * https://<ref>.storage.supabase.co/storage/v1/upload/resumable. Ver
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
}

export interface ResumableVideoUpload {
  readonly status: ResumableUploadStatus
  /**
   * Arranca, o reanuda tras network_error/storage_error (ver "Credenciales y
   * reanudación" arriba). Mientras sube, devuelve la misma promesa. En
   * success/cancelled/expired_token devuelve ese resultado.
   */
  start(): Promise<ResumableUploadResult>
  cancel(): void
}

export function isSupabaseProjectRef(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_REF.test(value)
}

/** Endpoint TUS del proyecto. Es la ÚNICA forma de construirlo. */
export function supabaseResumableUploadEndpoint(projectRef: string): string {
  if (!isSupabaseProjectRef(projectRef)) throw new TypeError('projectRef inválido: tienen que ser 20 letras minúsculas')
  return `https://${projectRef}.storage.supabase.co${SUPABASE_RESUMABLE_UPLOAD_PATH}`
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

/** URL storage de tus-js-client que no guarda nada: la URL de la subida no sale de la memoria. */
export const NO_URL_STORAGE: UrlStorage = {
  findAllUploads: () => Promise.resolve([]),
  findUploadsByFingerprint: () => Promise.resolve([]),
  removeUpload: () => Promise.resolve(),
  addUpload: () => Promise.resolve(''),
}

/** Una request de la subida apuntaba fuera del endpoint del proyecto: se cortó antes de enviarse. */
class UnexpectedUploadDestinationError extends Error {
  constructor() {
    super('destino de subida fuera del endpoint TUS del proyecto')
    this.name = 'UnexpectedUploadDestinationError'
  }
}

/** Corta (antes del envío) cualquier request que no vaya al endpoint TUS del proyecto o debajo de él. */
export function assertUploadDestination(requestUrl: string, endpoint: string): void {
  let target: URL
  try {
    target = new URL(requestUrl)
  } catch {
    throw new UnexpectedUploadDestinationError()
  }
  const expected = new URL(endpoint)
  const underEndpoint = target.pathname === expected.pathname || target.pathname.startsWith(`${expected.pathname}/`)
  if (target.origin !== expected.origin || target.username || target.password || !underEndpoint) {
    throw new UnexpectedUploadDestinationError()
  }
}

/** Opciones de tus-js-client para una subida. Exportada para verificar la configuración en tests. */
export function buildTusOptions(
  input: ResumableVideoUploadInput,
  callbacks: Pick<UploadOptions, 'onProgress' | 'onSuccess' | 'onError'>,
  seam: ResumableUploadTestSeam | null = null,
): UploadOptions {
  const endpoint = supabaseResumableUploadEndpoint(input.projectRef)
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
    uploadDataDuringCreation: true,
    storeFingerprintForResuming: false,
    removeFingerprintOnSuccess: true,
    urlStorage: NO_URL_STORAGE,
    onBeforeRequest: (req) => assertUploadDestination(req.getURL(), endpoint),
    onShouldRetry: shouldRetryUpload,
    ...(seam ? { httpStack: seam.httpStack } : {}),
    ...callbacks,
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

const FINAL_STATUSES: ReadonlySet<ResumableUploadStatus> = new Set(['success', 'cancelled', 'expired_token'])

function createUpload(input: ResumableVideoUploadInput, seam: ResumableUploadTestSeam | null): ResumableVideoUpload {
  assertUploadInput(input)

  let status: ResumableUploadStatus = 'idle'
  let lastResult: ResumableUploadResult | null = null
  let inFlight: Promise<ResumableUploadResult> | null = null
  let settle: ((result: ResumableUploadResult) => void) | null = null
  let lastPercent: number | null = null

  function setStatus(next: ResumableUploadStatus): void {
    if (next === status) return
    status = next
    input.onStatusChange?.(next)
  }

  function finish(result: ResumableUploadResult): void {
    lastResult = result
    setStatus(result.status)
    if (FINAL_STATUSES.has(result.status)) input.signal?.removeEventListener('abort', cancel)
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
    onError: (error) => finish(classifyUploadFailure(error)),
  }, seam))

  function cancel(): void {
    if (FINAL_STATUSES.has(status)) return
    // Primero el estado: cualquier evento que el abort dispare de forma
    // sincrónica (progreso encolado, error) ya encuentra la subida cancelada.
    finish({ status: 'cancelled' })
    // abort(false): corta el request en vuelo y los reintentos pendientes, sin
    // pedir el DELETE de terminación. La subida incompleta vence sola en
    // Storage y nunca llega a ser un objeto.
    void upload.abort(false)
  }

  input.signal?.addEventListener('abort', cancel, { once: true })

  function start(): Promise<ResumableUploadResult> {
    if (input.signal?.aborted) cancel()
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
    start,
    cancel,
  }
}

function isDestinationRejection(error: unknown): boolean {
  return error instanceof UnexpectedUploadDestinationError
    || (error as { causingError?: unknown } | null)?.causingError instanceof UnexpectedUploadDestinationError
}

// Mismo criterio que el default de tus-js-client 4.x (reintenta sin respuesta,
// 5xx, 409 y 423, salvo que el browser esté offline), más una excepción: un
// destino rechazado no se reintenta.
function shouldRetryUpload(error: DetailedError): boolean {
  if (isDestinationRejection(error)) return false
  const httpStatus = error.originalResponse?.getStatus() ?? 0
  const clientError = httpStatus >= 400 && httpStatus < 500
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return (!clientError || httpStatus === 409 || httpStatus === 423) && !offline
}

/**
 * Error de tus-js-client → resultado tipado. Del error sólo se usa el status
 * HTTP (y el body, únicamente para reconocer una firma rechazada); el mensaje
 * —que trae la URL de la subida— no sale de acá.
 */
export function classifyUploadFailure(error: unknown): ResumableUploadResult {
  if (isDestinationRejection(error)) return { status: 'storage_error', reason: 'unexpected_upload_url' }
  const response = (error as { originalResponse?: HttpResponse | null } | null)?.originalResponse ?? null
  const httpStatus = response?.getStatus() ?? 0
  // Status 0 = el request no tuvo respuesta HTTP (red, CORS, DNS).
  if (!response || !httpStatus) return { status: 'network_error' }
  if (isRejectedSignature(httpStatus, safeBody(response))) return { status: 'expired_token', httpStatus }
  return { status: 'storage_error', httpStatus }
}

const SIGNATURE_REJECTION = /jwt|signature|expired|invalid.?token|unauthori[sz]ed/i

function isRejectedSignature(httpStatus: number, body: string): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true
  return httpStatus === 400 && SIGNATURE_REJECTION.test(body)
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
  supabaseResumableUploadEndpoint(input.projectRef)
}

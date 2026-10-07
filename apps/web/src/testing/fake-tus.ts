// Servidor TUS 1.0 en memoria que se inyecta como HttpStack de tus-js-client.
// Refleja el contrato REAL de Supabase Storage para subidas firmadas (smoke
// 2B0 + código fuente de storage, src/http/routes/tus):
//   · la creación firmada existe SÓLO en /storage/v1/upload/resumable/sign;
//   · el endpoint base /storage/v1/upload/resumable autentica con
//     Authorization (JWT): con x-signature y sin Authorization responde
//     exactamente lo que respondió Storage real (STORAGE_BASE_ROUTE_REJECTION);
//   · el Location conserva /sign: <origen>/storage/v1/upload/resumable/sign/<id>,
//     absoluto y en el mismo host, con <id> = base64url sin padding de
//     {bucket}/{objeto}/{versión UUID} (formato observado en el smoke 2B0.1);
//   · PATCH por offset, HEAD para reanudar y DELETE para terminar.
// Registra cada request para que los tests verifiquen destino, headers y
// tamaños de chunk, y permite inyectar fallas: caída de red, status HTTP,
// request colgado (para cancelar en vuelo; un PATCH abortado puede dejar bytes
// parciales, como en real), corte a mitad de un chunk (para probar que se
// reanuda desde el offset del servidor) y un PATCH final que el servidor
// completa pero cuya respuesta no llega (para probar que cancelar nunca borra
// un objeto ya terminado). `onCreateRequest` permite cancelar en un punto
// exacto del flujo (p. ej. entre el 201 y el primer PATCH).

import type { HttpRequest, HttpResponse, HttpStack } from 'tus-js-client'

export const FAKE_TUS_BASE_PATH = '/storage/v1/upload/resumable'
export const FAKE_TUS_SIGNED_PATH = '/storage/v1/upload/resumable/sign'

/** Respuesta REAL de Storage (smoke 2B0) a x-signature sin Authorization en el endpoint base. HTTP 400. */
export const STORAGE_BASE_ROUTE_REJECTION = '{"statusCode":"403","code":"AccessDenied","error":"Unauthorized","message":"Invalid Compact JWS"}'

/**
 * Firma inválida en /sign. APROXIMACIÓN: el formato real todavía no se observó
 * en QA; sigue el estilo de error de Storage (HTTP 400 + statusCode en el body).
 */
export const FAKE_SIGNED_ROUTE_REJECTION = '{"statusCode":"403","code":"InvalidSignature","error":"Unauthorized","message":"invalid signature"}'

export type FakeTusFault =
  | { kind: 'network' }
  | { kind: 'status'; status: number; body?: string; headers?: Record<string, string> }
  /** No responde hasta que la abortan. En un PATCH, `partialBytesOnAbort` imita a Storage real, que conservó 64 KiB de un chunk abortado. */
  | { kind: 'hang'; partialBytesOnAbort?: number }
  | { kind: 'partial-then-network' }
  /** PATCH que el servidor aplica entero (la subida puede quedar completa) pero cuya respuesta no llega antes del abort. */
  | { kind: 'complete-then-hang' }
  /** PATCH cuya respuesta (204) llega igual DESPUÉS de un abort: la carrera de una respuesta que ya estaba en tránsito. */
  | { kind: 'late-response'; delayMs: number }

export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  bodyBytes: number
  bodyIsBlob: boolean
  aborted: boolean
}

interface StoredUpload {
  length: number
  offset: number
  metadata: Record<string, string>
}

export class FakeTusServer implements HttpStack {
  readonly requests: RecordedRequest[] = []
  readonly uploads = new Map<string, StoredUpload>()
  readonly hanging: RecordedRequest[] = []
  /** Toda request que tus-js-client CREÓ, se haya enviado o no (el control de destino corta antes de send). */
  readonly created: Array<{ method: string; url: string }> = []
  readonly baseEndpoint: string
  readonly signedEndpoint: string
  private readonly faults: Array<{ method: string; fault: FakeTusFault }> = []
  /** Location que devuelve la creación; por defecto, la URL de sesión bajo /sign. Permite simular un Storage que apunta afuera. */
  locationFor: (id: string) => string = (id) => `${this.signedEndpoint}/${id}`
  /** Se llama al CREAR cada request (antes de que tus-js-client la envíe): permite cancelar en un punto exacto. */
  onCreateRequest: ((method: string, url: string) => void) | null = null

  constructor(
    /** Origen de Storage, p. ej. https://<ref>.storage.supabase.co */
    readonly origin: string,
    readonly acceptedSignature: string,
  ) {
    this.baseEndpoint = `${origin}${FAKE_TUS_BASE_PATH}`
    this.signedEndpoint = `${origin}${FAKE_TUS_SIGNED_PATH}`
  }

  /** La próxima request con ese método falla así (en orden de registro). */
  failNext(method: 'POST' | 'PATCH' | 'HEAD' | 'DELETE', fault: FakeTusFault, times = 1): this {
    for (let i = 0; i < times; i++) this.faults.push({ method, fault })
    return this
  }

  /** Storage "olvida" las subidas en curso (su URL de sesión venció): HEAD/PATCH → 404. */
  expireUploads(): void {
    this.uploads.clear()
  }

  createRequest(method: string, url: string): HttpRequest {
    this.created.push({ method, url })
    const request = new FakeRequest(this, method, url)
    this.onCreateRequest?.(method, url)
    return request
  }

  /** Sesiones abiertas con su offset (para verificar terminación y subidas completas). */
  sessions(): Array<{ offset: number; length: number; complete: boolean }> {
    return [...this.uploads.values()].map((u) => ({ offset: u.offset, length: u.length, complete: u.offset === u.length }))
  }

  getName(): string {
    return 'FakeTusServer'
  }

  requestsOf(method: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method)
  }

  /** @internal — lo llama FakeRequest.send. */
  async handle(req: FakeRequest, body: unknown): Promise<HttpResponse> {
    const blob = body instanceof Blob ? body : null
    const record: RecordedRequest = {
      method: req.getMethod(),
      url: req.getURL(),
      headers: { ...req.headers },
      bodyBytes: blob?.size ?? 0,
      bodyIsBlob: blob !== null,
      aborted: false,
    }
    this.requests.push(record)
    await Promise.resolve()

    const index = this.faults.findIndex((f) => f.method === record.method)
    const fault = index >= 0 ? this.faults.splice(index, 1)[0]!.fault : null

    if (fault?.kind === 'network') throw new Error('fake: conexión caída')
    if (fault?.kind === 'hang') {
      const partial = fault.partialBytesOnAbort ?? 0
      const upload = record.method === 'PATCH' ? this.uploadAt(record.url) : undefined
      return this.hangUntilAbort(req, record, () => {
        if (upload) upload.offset += Math.min(partial, record.bodyBytes)
      })
    }
    if (fault?.kind === 'status') return response(fault.status, fault.headers ?? {}, fault.body ?? '')

    if (record.headers['tus-resumable'] !== '1.0.0') return response(412)

    const url = new URL(record.url)
    if (url.origin !== this.origin) return response(404)
    const signed = url.pathname === FAKE_TUS_SIGNED_PATH || url.pathname.startsWith(`${FAKE_TUS_SIGNED_PATH}/`)
    const base = !signed && (url.pathname === FAKE_TUS_BASE_PATH || url.pathname.startsWith(`${FAKE_TUS_BASE_PATH}/`))

    // Endpoint base: Storage lo autentica con Authorization (JWT) e ignora la firma.
    if (base) {
      if (!record.headers['authorization']) return response(400, {}, STORAGE_BASE_ROUTE_REJECTION)
      return response(400, {}, '{"statusCode":"400","error":"fake","message":"auth JWT no simulada"}')
    }
    if (!signed) return response(404)
    if (record.headers['x-signature'] !== this.acceptedSignature) return response(400, {}, FAKE_SIGNED_ROUTE_REJECTION)

    switch (record.method) {
      case 'POST': {
        if (url.pathname !== FAKE_TUS_SIGNED_PATH) return response(404)
        const metadata = decodeTusMetadata(record.headers['upload-metadata'] ?? '')
        const upload: StoredUpload = { length: Number(record.headers['upload-length']), offset: 0, metadata }
        // Mismo formato que Storage real (smoke 2B0.1): base64url sin padding
        // de {bucket}/{objeto}/{versión UUID}.
        const id = Buffer.from(`${metadata.bucketName}/${metadata.objectName}/${crypto.randomUUID()}`, 'utf8').toString('base64url')
        this.uploads.set(id, upload)
        if (blob) {
          // creation-with-upload: Storage lo admite; nuestro uploader ya no lo usa.
          if (record.headers['content-type'] !== 'application/offset+octet-stream') return response(415)
          req.reportProgress(blob.size)
          upload.offset += blob.size
        }
        return response(201, { Location: this.locationFor(id), 'Upload-Offset': String(upload.offset) })
      }
      case 'PATCH': {
        const upload = this.uploadAt(record.url)
        if (!upload) return response(404)
        if (Number(record.headers['upload-offset']) !== upload.offset) return response(409)
        const size = blob?.size ?? 0
        if (fault?.kind === 'complete-then-hang') {
          upload.offset += size
          return this.hangUntilAbort(req, record)
        }
        if (fault?.kind === 'late-response') {
          this.hanging.push(record)
          req.onAbort(() => {
            record.aborted = true
          })
          upload.offset += size
          await new Promise((resolve) => setTimeout(resolve, fault.delayMs))
          return response(204, { 'Upload-Offset': String(upload.offset) })
        }
        if (fault?.kind === 'partial-then-network') {
          const half = Math.floor(size / 2)
          req.reportProgress(half)
          upload.offset += half
          throw new Error('fake: se cortó a mitad del chunk')
        }
        req.reportProgress(size)
        upload.offset += size
        return response(204, { 'Upload-Offset': String(upload.offset) })
      }
      case 'HEAD': {
        const upload = this.uploadAt(record.url)
        if (!upload) return response(404)
        return response(200, { 'Upload-Offset': String(upload.offset), 'Upload-Length': String(upload.length), 'Cache-Control': 'no-store' })
      }
      case 'DELETE': {
        const id = this.sessionIdOf(record.url)
        if (!id || !this.uploads.delete(id)) return response(404)
        return response(204)
      }
      default:
        return response(405)
    }
  }

  /** Request que no responde hasta que la abortan (entonces rechaza, como XHR). */
  private hangUntilAbort(req: FakeRequest, record: RecordedRequest, onAbort?: () => void): Promise<HttpResponse> {
    this.hanging.push(record)
    return new Promise<HttpResponse>((_, reject) => {
      req.onAbort(() => {
        record.aborted = true
        onAbort?.()
        // Como un evento de progreso de XHR que ya estaba encolado cuando
        // llegó el abort: el uploader no tiene que reenviarlo a la UI.
        req.reportProgress(record.bodyBytes)
        reject(new Error('fake: request abortado'))
      })
    })
  }

  private sessionIdOf(url: string): string | null {
    return url.startsWith(`${this.signedEndpoint}/`) ? url.slice(this.signedEndpoint.length + 1) : null
  }

  private uploadAt(url: string): StoredUpload | undefined {
    const id = this.sessionIdOf(url)
    return id ? this.uploads.get(id) : undefined
  }
}

class FakeRequest implements HttpRequest {
  readonly headers: Record<string, string> = {}
  private progressHandler: ((bytesSent: number) => void) | null = null
  private abortHandlers: Array<() => void> = []

  constructor(
    private readonly server: FakeTusServer,
    private readonly method: string,
    private readonly url: string,
  ) {}

  getMethod(): string {
    return this.method
  }

  getURL(): string {
    return this.url
  }

  setHeader(header: string, value: string): void {
    this.headers[header.toLowerCase()] = value
  }

  getHeader(header: string): string | undefined {
    return this.headers[header.toLowerCase()]
  }

  setProgressHandler(handler: (bytesSent: number) => void): void {
    this.progressHandler = handler
  }

  send(body: unknown): Promise<HttpResponse> {
    return this.server.handle(this, body)
  }

  abort(): Promise<void> {
    for (const handler of this.abortHandlers) handler()
    return Promise.resolve()
  }

  getUnderlyingObject(): unknown {
    return null
  }

  /** Progreso como el de XHR: a mitad y al final. */
  reportProgress(bytes: number): void {
    this.progressHandler?.(Math.floor(bytes / 2))
    this.progressHandler?.(bytes)
  }

  onAbort(handler: () => void): void {
    this.abortHandlers.push(handler)
  }
}

function response(status: number, headers: Record<string, string> = {}, body = ''): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    getStatus: () => status,
    getHeader: (header: string) => lower[header.toLowerCase()],
    getBody: () => body,
    getUnderlyingObject: () => null,
  }
}

/** Decodifica Upload-Metadata ("clave base64,clave base64"). */
export function decodeTusMetadata(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of header.split(',').filter(Boolean)) {
    const [key, value = ''] = pair.trim().split(' ')
    out[key!] = Buffer.from(value, 'base64').toString('utf8')
  }
  return out
}

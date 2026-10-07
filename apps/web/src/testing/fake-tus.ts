// Servidor TUS 1.0 en memoria que se inyecta como HttpStack de tus-js-client.
// Implementa lo que usa Supabase Storage: creación con datos (POST con el
// primer chunk), PATCH por offset y HEAD para reanudar; valida x-signature y
// Tus-Resumable, y registra cada request para que los tests verifiquen
// destino, headers y tamaños de chunk. Permite inyectar fallas: caída de red,
// status HTTP, request colgado (para cancelar en vuelo) y corte a mitad de un
// chunk (para probar que se reanuda desde el offset del servidor).

import type { HttpRequest, HttpResponse, HttpStack } from 'tus-js-client'

export type FakeTusFault =
  | { kind: 'network' }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'hang' }
  | { kind: 'partial-then-network' }

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
  metadata: string
}

export class FakeTusServer implements HttpStack {
  readonly requests: RecordedRequest[] = []
  readonly uploads = new Map<string, StoredUpload>()
  readonly hanging: RecordedRequest[] = []
  private readonly faults: Array<{ method: string; fault: FakeTusFault }> = []
  private nextId = 1
  /** Location que devuelve la creación; por defecto, debajo del endpoint. Permite simular un Storage que apunta afuera. */
  locationFor: (id: string) => string = (id) => `${this.endpoint}/${id}`

  constructor(
    readonly endpoint: string,
    readonly acceptedSignature: string,
  ) {}

  /** Storage "olvida" las subidas en curso (su URL TUS venció): HEAD/PATCH → 404. */
  expireUploads(): void {
    this.uploads.clear()
  }

  /** La próxima request con ese método falla así (en orden de registro). */
  failNext(method: 'POST' | 'PATCH' | 'HEAD', fault: FakeTusFault, times = 1): this {
    for (let i = 0; i < times; i++) this.faults.push({ method, fault })
    return this
  }

  /** Toda request que tus-js-client CREÓ, se haya enviado o no (el control de destino corta antes de send). */
  readonly created: Array<{ method: string; url: string }> = []

  createRequest(method: string, url: string): HttpRequest {
    this.created.push({ method, url })
    return new FakeRequest(this, method, url)
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
      this.hanging.push(record)
      return new Promise<HttpResponse>((_, reject) => {
        req.onAbort(() => {
          record.aborted = true
          // Como un evento de progreso de XHR que ya estaba encolado cuando
          // llegó el abort: el uploader no tiene que reenviarlo a la UI.
          req.reportProgress(record.bodyBytes)
          reject(new Error('fake: request abortado'))
        })
      })
    }
    if (fault?.kind === 'status') return response(fault.status, {}, fault.body ?? '')

    if (record.headers['tus-resumable'] !== '1.0.0') return response(412)
    if (record.headers['x-signature'] !== this.acceptedSignature) {
      return response(403, {}, '{"statusCode":"403","error":"Unauthorized","message":"invalid signature"}')
    }

    switch (record.method) {
      case 'POST': {
        if (record.url !== this.endpoint) return response(404)
        const upload: StoredUpload = {
          length: Number(record.headers['upload-length']),
          offset: 0,
          metadata: record.headers['upload-metadata'] ?? '',
        }
        const id = `upload-${this.nextId++}`
        this.uploads.set(id, upload)
        if (blob) {
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
      default:
        return response(405)
    }
  }

  private uploadAt(url: string): StoredUpload | undefined {
    if (!url.startsWith(`${this.endpoint}/`)) return undefined
    return this.uploads.get(url.slice(this.endpoint.length + 1))
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

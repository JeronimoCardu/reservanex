// Fake mínimo de supabase-js para tests: tablas en memoria y un query builder
// que APLICA los filtros (eq / is / in), la proyección del select, order y
// limit. Sirve para probar qué devuelve una consulta — por ejemplo, que un
// video de otro tenant NO aparece — y no sólo con qué argumentos se llamó al
// builder. Cada consulta ejecutada queda registrada en `queries`.
//
// Cubre únicamente lo que usan los módulos que lo importan. No es PostgREST:
// sin joins, sin RLS, sin tipos. No lo importa código de producción.

import { randomUUID } from 'node:crypto'

type Row = Record<string, unknown>
type Op = 'select' | 'insert' | 'update' | 'delete'

export interface FakeError { code: string; message: string }

export interface FakeQueryRecord {
  table:   string
  op:      Op
  filters: string[]
}

export interface FakeResult {
  data:   unknown
  error:  FakeError | null
  count?: number | null
}

export class FakeSupabase {
  readonly tables:  Record<string, Row[]>
  readonly queries: FakeQueryRecord[] = []
  readonly storage: FakeStorage
  readonly auth:    FakeAuth

  private readonly failing = new Map<string, FakeError>()

  constructor(tables: Record<string, Row[]> = {}) {
    this.tables  = tables
    this.storage = new FakeStorage()
    this.auth    = new FakeAuth()
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table)
  }

  /** Toda consulta sobre `table` devuelve este error. */
  failOn(table: string, error: FakeError = { code: 'XX000', message: 'fake failure' }): this {
    this.failing.set(table, error)
    return this
  }

  /** @internal */
  failureFor(table: string): FakeError | null {
    return this.failing.get(table) ?? null
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= [])
  }

  queriesOn(table: string): FakeQueryRecord[] {
    return this.queries.filter((q) => q.table === table)
  }
}

class FakeQuery implements PromiseLike<FakeResult> {
  private op: Op = 'select'
  private columns: string[] | null = null
  private countExact = false
  private head = false
  private payload: Row | Row[] | null = null
  private readonly filters: ((row: Row) => boolean)[] = []
  private readonly filterLog: string[] = []
  private readonly orders: { column: string; ascending: boolean }[] = []
  private limitTo: number | null = null

  constructor(private readonly db: FakeSupabase, private readonly table: string) {}

  select(columns = '*', opts: { count?: 'exact'; head?: boolean } = {}): this {
    const cols = columns.split(',').map((c) => c.trim()).filter(Boolean)
    this.columns    = cols.includes('*') ? null : cols
    this.countExact = opts.count === 'exact'
    this.head       = opts.head === true
    return this
  }

  insert(payload: Row | Row[]): this { this.op = 'insert'; this.payload = payload; return this }
  update(patch: Row): this           { this.op = 'update'; this.payload = patch; return this }
  delete(): this                     { this.op = 'delete'; return this }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value)
    this.filterLog.push(`${column}=${String(value)}`)
    return this
  }

  is(column: string, value: null): this {
    this.filters.push((row) => (row[column] ?? null) === value)
    this.filterLog.push(`${column} is null`)
    return this
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push((row) => values.includes(row[column]))
    this.filterLog.push(`${column} in (${values.map(String).join(',')})`)
    return this
  }

  order(column: string, opts: { ascending?: boolean } = {}): this {
    this.orders.push({ column, ascending: opts.ascending !== false })
    return this
  }

  limit(n: number): this { this.limitTo = n; return this }

  maybeSingle(): Promise<FakeResult> {
    return this.execute().then((r) => {
      if (r.error) return r
      const rows = r.data as Row[]
      if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } }
      return { data: rows[0] ?? null, error: null }
    })
  }

  single(): Promise<FakeResult> {
    return this.execute().then((r) => {
      if (r.error) return r
      const rows = r.data as Row[]
      if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: `${rows.length} rows` } }
      return { data: rows[0], error: null }
    })
  }

  then<T1 = FakeResult, T2 = never>(
    onfulfilled?: ((value: FakeResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private project(row: Row): Row {
    if (!this.columns) return { ...row }
    return Object.fromEntries(this.columns.map((c) => [c, row[c] ?? null]))
  }

  private async execute(): Promise<FakeResult> {
    this.db.queries.push({ table: this.table, op: this.op, filters: [...this.filterLog] })

    const failure = this.db.failureFor(this.table)
    if (failure) return { data: null, error: failure, count: null }

    const table   = this.db.rows(this.table)
    const matches = (row: Row) => this.filters.every((f) => f(row))

    if (this.op === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}]
      const inserted = incoming.map((r) => ({ id: randomUUID(), ...r }))
      table.push(...inserted)
      return { data: inserted.map((r) => this.project(r)), error: null }
    }

    if (this.op === 'update') {
      const hit = table.filter(matches)
      for (const row of hit) Object.assign(row, this.payload)
      return { data: hit.map((r) => this.project(r)), error: null }
    }

    if (this.op === 'delete') {
      const keep = table.filter((r) => !matches(r))
      const gone = table.filter(matches)
      table.splice(0, table.length, ...keep)
      return { data: gone.map((r) => this.project(r)), error: null }
    }

    let rows = table.filter(matches)
    for (const { column, ascending } of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const x = a[column] as number | string
        const y = b[column] as number | string
        return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1)
      })
    }
    if (this.limitTo !== null) rows = rows.slice(0, this.limitTo)

    const count = this.countExact ? rows.length : null
    return { data: this.head ? null : rows.map((r) => this.project(r)), error: null, count }
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

export interface FakeStorageCall {
  bucket: string
  method: 'createSignedUrl' | 'download' | 'upload' | 'remove'
  args:   unknown[]
}

type SignedUrlResult =
  | { data: { signedUrl: string }; error: null }
  | { data: null; error: { message: string; status?: number; statusCode?: string } }

export class FakeStorage {
  readonly calls: FakeStorageCall[] = []
  uploadError: { message: string } | null = null
  signedUrl: (bucket: string, path: string, expiresIn: number) => SignedUrlResult =
    (bucket, path, expiresIn) => ({
      data:  { signedUrl: `https://storage.test/storage/v1/object/sign/${bucket}/${path}?token=tok-${expiresIn}` },
      error: null,
    })

  from(bucket: string) {
    const record = (method: FakeStorageCall['method'], args: unknown[]) => this.calls.push({ bucket, method, args })
    return {
      createSignedUrl: async (path: string, expiresIn: number) => {
        record('createSignedUrl', [path, expiresIn])
        return this.signedUrl(bucket, path, expiresIn)
      },
      download: async (...args: unknown[]) => {
        record('download', args)
        return { data: null, error: { message: 'download no está permitido en este test' } }
      },
      upload: async (path: string, ...rest: unknown[]) => {
        record('upload', [path, ...rest])
        return this.uploadError ? { data: null, error: this.uploadError } : { data: { path }, error: null }
      },
      remove: async (paths: string[]) => {
        record('remove', [paths])
        return { data: [], error: null }
      },
    }
  }

  callsOf(method: FakeStorageCall['method']): FakeStorageCall[] {
    return this.calls.filter((c) => c.method === method)
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Sesión del cliente server: sin token = visitante anónimo. */
export class FakeAuth {
  private accessToken: string | null = null

  signIn(accessToken: string): void { this.accessToken = accessToken }

  getUser = async () => ({
    data:  { user: this.accessToken ? { id: 'user-1' } : null },
    error: null,
  })

  getSession = async () => ({
    data: { session: this.accessToken ? { access_token: this.accessToken } : null },
  })
}

/** Un access token con los app_metadata dados, como lo lee parseAccessTokenClaims. */
export function fakeAccessToken(appMetadata: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ app_metadata: appMetadata })).toString('base64url')
  return `header.${payload}.signature`
}

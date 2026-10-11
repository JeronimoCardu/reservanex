/**
 * Property Videos 2B1 — reservas de subida e invariantes de property_videos,
 * validadas contra la base REAL del laboratorio (reservanex-lab).
 *
 *   pnpm --filter @orderflow/web validate:property-video-uploads
 *
 * Pasa por el guard anti-producción (scripts/lab/lab-db-target.ts): sin un
 * .env.lab.local válido no conecta. Usa varias conexiones pg REALES y
 * separadas; las operaciones concurrentes salen juntas de una barrera y cada
 * transacción retiene sus locks un rato antes del COMMIT, para que las demás
 * choquen de verdad contra ellos.
 *
 * Todos los datos son sintéticos (tenants lab-2b1-*, un usuario de auth
 * @example.invalid) y se borran al final, pase lo que pase.
 *
 * HARNESS — finalize con objeto: la consigna prohíbe escribir en
 * storage.objects y la subida de un objeto real no forma parte de 2B1. Para
 * ejercitar finalize hasta el INSERT se crea una COPIA de laboratorio de
 * finalize/get (esquema lab_2b1_harness) generada desde pg_get_functiondef con
 * UNA sola sustitución: storage.objects → lab_2b1_harness.objects. El resto
 * del cuerpo —locks, máquina de estados, cupo, trigger, tablas reales— es el de
 * la migración. Los caminos de finalize que no necesitan objeto se corren
 * contra la función REAL. El esquema harness se borra al terminar.
 */

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { requireLabConnection } from './lab/lab-db'

const lab = requireLabConnection()
const RUN = Date.now().toString(36)
const HR = '─'.repeat(78)
const HOLD_MS = 250
const WORKERS = 6

let passed = 0
let failed = 0
let deadlockErrors = 0
const summary: Record<string, unknown> = {}

function log(text: string) { console.log(lab.redact(text)) }
function ok(label: string) { log(`  ✓ ${label}`); passed++ }
function nok(label: string, detail?: string) {
  console.error(lab.redact(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`))
  failed++
}
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) ok(label)
  else nok(label, detail === undefined ? undefined : JSON.stringify(detail))
}
function section(title: string) { log(`\n${title}`) }

type Json = Record<string, unknown>
type Role = 'postgres' | 'service_role' | 'authenticated' | 'anon'
type PgError = { code?: string; message: string; constraint?: string }
type Settled<T> = { ok: true; value: T } | { ok: false; error: PgError }

function asPgError(error: unknown): PgError {
  const e = error as { code?: unknown; message?: unknown; constraint?: unknown }
  return {
    code: typeof e?.code === 'string' ? e.code : undefined,
    message: String(e?.message ?? error),
    constraint: typeof e?.constraint === 'string' ? e.constraint : undefined,
  }
}

// ── Conexiones ───────────────────────────────────────────────────────────────

let main: pg.Client
const workers: pg.Client[] = []

/** Una transacción en `c` con el rol (y claims) indicados. */
async function tx<T>(c: pg.Client, role: Role, run: () => Promise<T>, claims?: Json): Promise<T> {
  await c.query('BEGIN')
  try {
    if (role !== 'postgres') await c.query(`SET LOCAL ROLE ${role}`)
    if (claims) await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    const value = await run()
    await c.query('COMMIT')
    return value
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function attempt<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try { return { ok: true, value: await run() } } catch (error) { return { ok: false, error: asPgError(error) } }
}

function barrier(n: number) {
  let count = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return () => { if (++count === n) release(); return gate }
}

interface RaceOp<T> { role: Role; claims?: Json; run: (c: pg.Client) => Promise<T> }

/**
 * Lanza las operaciones a la vez, cada una en su conexión y su transacción:
 * BEGIN → barrera → operación → pg_sleep(HOLD) → COMMIT.
 */
async function race<T>(ops: RaceOp<T>[], holdMs = HOLD_MS): Promise<Settled<T>[]> {
  if (ops.length > workers.length) throw new Error('más operaciones que conexiones')
  const arrive = barrier(ops.length)
  return Promise.all(ops.map(async (op, i): Promise<Settled<T>> => {
    const c = workers[i]!
    let arrived = false
    try {
      await c.query('BEGIN')
      if (op.role !== 'postgres') await c.query(`SET LOCAL ROLE ${op.role}`)
      if (op.claims) await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(op.claims)])
      arrived = true
      await arrive()
      const value = await op.run(c)
      if (holdMs > 0) await c.query('SELECT pg_sleep($1)', [holdMs / 1000])
      await c.query('COMMIT')
      return { ok: true, value }
    } catch (error) {
      if (!arrived) void arrive()
      await c.query('ROLLBACK').catch(() => undefined)
      const pgError = asPgError(error)
      if (pgError.code === '40P01') deadlockErrors++
      return { ok: false, error: pgError }
    }
  }))
}

// ── RPCs ─────────────────────────────────────────────────────────────────────

async function scalar(c: pg.Client, sql: string, params: unknown[] = []): Promise<Json> {
  const { rows } = await c.query<{ r: Json }>(sql, params)
  return rows[0]!.r
}

const MP4 = 'video/mp4'
const TTL_DEFAULT = 2 * 3600

function reserveSql(fn = 'public.reserve_property_video_upload') {
  return `SELECT ${fn}($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) AS r`
}
function reserve(c: pg.Client, t: string, p: string, o: { user?: string | null; request?: string; mime?: string; ttl?: number } = {}) {
  return scalar(c, reserveSql(), [t, p, o.user ?? null, o.request ?? randomUUID(), o.mime ?? MP4, o.ttl ?? TTL_DEFAULT])
}
const cancel = (c: pg.Client, t: string, u: string) => scalar(c, 'SELECT public.cancel_property_video_upload($1, $2) AS r', [t, u])
const fail = (c: pg.Client, t: string, u: string, reason: string) =>
  scalar(c, 'SELECT public.fail_property_video_upload($1, $2, $3) AS r', [t, u, reason])
const getObject = (c: pg.Client, t: string, u: string, schema = 'public') =>
  scalar(c, `SELECT ${schema}.get_property_video_upload_object($1, $2) AS r`, [t, u])
function finalize(c: pg.Client, t: string, u: string, o: { id: string | null; version: string | null; size: number; duration?: number }, schema = 'public') {
  return scalar(c, `SELECT ${schema}.finalize_property_video_upload($1, $2, $3, $4, $5, $6) AS r`,
    [t, u, o.id, o.version, o.size, o.duration ?? 12])
}
const H = 'lab_2b1_harness'

// ── Fixtures (como postgres, autocommit) ────────────────────────────────────

const tenantIds: string[] = []
let syntheticUserId: string | null = null
let harnessCreated = false

async function newTenant(label: string, status = 'active'): Promise<string> {
  const id = randomUUID()
  await main.query(
    `INSERT INTO public.tenants (id, name, slug, status, max_properties) VALUES ($1, $2, $3, $4::tenant_status, NULL)`,
    [id, `[LAB 2B1] ${label} ${RUN}`, `lab-2b1-${label}-${RUN}`, status])
  tenantIds.push(id)
  return id
}
async function newProperty(tenantId: string): Promise<string> {
  const id = randomUUID()
  await main.query(`INSERT INTO public.properties (id, tenant_id, title) VALUES ($1, $2, $3)`, [id, tenantId, `[LAB 2B1] ${RUN}`])
  return id
}
const legacyInsertSql =
  `INSERT INTO public.property_videos (tenant_id, property_id, storage_path, mime_type, file_size_bytes, sort_order, created_by)
   VALUES ($1, $2, $1::uuid::text || '/' || gen_random_uuid()::text || '.mp4', 'video/mp4', 1000, 0, $3)`
async function legacyVideo(tenantId: string, propertyId: string, createdBy: string | null = null) {
  await main.query(legacyInsertSql, [tenantId, propertyId, createdBy])
}
async function counts(propertyId: string) {
  const { rows } = await main.query<{ videos: number; live: number }>(
    `SELECT (SELECT count(*)::int FROM public.property_videos WHERE property_id = $1) AS videos,
            (SELECT count(*)::int FROM public.property_video_uploads
              WHERE property_id = $1 AND status = 'reserved' AND expires_at > now()) AS live`, [propertyId])
  return rows[0]!
}
async function uploadRow(id: string) {
  const { rows } = await main.query<Json>(`SELECT * FROM public.property_video_uploads WHERE id = $1`, [id])
  return rows[0]
}
async function fakeObject(path: string, size: number, mimetype = MP4, version = randomUUID()) {
  const { rows } = await main.query<{ id: string; version: string }>(
    `INSERT INTO ${H}.objects (bucket_id, name, version, metadata)
     VALUES ('property-videos', $1, $2, jsonb_build_object('size', $3::bigint, 'mimetype', $4::text))
     RETURNING id, version`, [path, version, size, mimetype])
  return rows[0]!
}
function ownerClaims(tenantId: string): Json {
  return {
    sub: randomUUID(), role: 'authenticated',
    app_metadata: { user_type: 'tenant_user', tenant_id: tenantId, role: 'owner' },
  }
}
const outcomes = <T extends Json>(rs: Settled<T>[]) =>
  rs.map((r) => (r.ok ? String(r.value.outcome) + (r.value.already === true ? '(already)' : '') : `ERR:${r.error.code}`))
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {})

// ── Harness ──────────────────────────────────────────────────────────────────

async function createHarness() {
  await main.query(`CREATE SCHEMA ${H}`)
  harnessCreated = true
  await main.query(`CREATE TABLE ${H}.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL,
    version text, metadata jsonb, archived_at timestamptz, is_delete_marker boolean NOT NULL DEFAULT false)`)
  const copies: Array<[string, string, (def: string) => string]> = [
    ['public.finalize_property_video_upload(uuid,uuid,uuid,text,bigint,integer)', 'finalize_property_video_upload', (d) => d],
    ['public.get_property_video_upload_object(uuid,uuid)', 'get_property_video_upload_object', (d) => d],
    // Control negativo: reserve SIN el lock de la propiedad.
    ['public.reserve_property_video_upload(uuid,uuid,uuid,uuid,text,timestamptz)', 'reserve_without_lock', (d) => {
      const lockClause = /AND p\.deleted_at IS NULL\s+FOR UPDATE;/
      if (!lockClause.test(d)) throw new Error('no encontré el lock de reserve')
      return d.replace(lockClause, 'AND p.deleted_at IS NULL;')
    }],
  ]
  for (const [signature, name, transform] of copies) {
    const { rows } = await main.query<{ def: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS def`, [signature])
    let def = rows[0]!.def
    const header = def.match(/^CREATE OR REPLACE FUNCTION public\.\w+\(/)
    if (!header) throw new Error(`cabecera inesperada en ${signature}`)
    def = def.replace(header[0], `CREATE OR REPLACE FUNCTION ${H}.${name}(`)
    const storageRefs = def.split('storage.objects').length - 1
    if (name !== 'reserve_without_lock' && storageRefs !== 1) throw new Error(`${name}: ${storageRefs} referencias a storage.objects`)
    def = transform(def.replace('storage.objects', `${H}.objects`))
    await main.query(def)
  }
  await main.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${H} FROM PUBLIC`)
  await main.query(`GRANT USAGE ON SCHEMA ${H} TO service_role`)
  await main.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${H} TO service_role`)
}

// ── Pruebas ──────────────────────────────────────────────────────────────────

const RPCS = [
  'public.reserve_property_video_upload(uuid,uuid,uuid,uuid,text,timestamptz)',
  'public.cancel_property_video_upload(uuid,uuid)',
  'public.fail_property_video_upload(uuid,uuid,text)',
  'public.get_property_video_upload_object(uuid,uuid)',
  'public.finalize_property_video_upload(uuid,uuid,uuid,text,bigint,integer)',
]
const TRIGGER_FNS = ['public.property_videos_enforce_capacity()', 'public.property_videos_guard_identity()']

async function physicalSchema() {
  section('C/D/L · esquema físico, RLS y grants')
  const { rows: cols } = await main.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'property_video_uploads' ORDER BY ordinal_position`)
  summary.uploads_columns = cols.map((c) => `${c.column_name}:${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`)
  check('property_video_uploads: 12 columnas esperadas',
    cols.map((c) => c.column_name).join(',') ===
      'id,tenant_id,property_id,request_id,storage_path,mime_type,status,failure_reason,expires_at,created_by,created_at,resolved_at',
    cols.map((c) => c.column_name))

  const { rows: cons } = await main.query<{ conrelid: string; conname: string; contype: string; confdeltype: string; def: string }>(
    `SELECT conrelid::regclass::text AS conrelid, conname, contype, confdeltype, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid IN ('public.property_video_uploads'::regclass, 'public.property_videos'::regclass, 'public.properties'::regclass)`)
  const con = (name: string) => cons.find((c) => c.conname === name)
  summary.uploads_constraints = cons.filter((c) => c.conrelid === 'property_video_uploads').map((c) => c.conname).sort()
  check('properties UNIQUE (id, tenant_id)', con('properties_id_tenant_id_key')?.def === 'UNIQUE (id, tenant_id)')
  check('uploads: FK compuesta (property_id, tenant_id) CASCADE',
    con('property_video_uploads_property_tenant_fkey')?.confdeltype === 'c' &&
    /FOREIGN KEY \(property_id, tenant_id\) REFERENCES properties\(id, tenant_id\)/.test(con('property_video_uploads_property_tenant_fkey')?.def ?? ''))
  check('uploads: created_by ON DELETE SET NULL', cons.some((c) => c.conrelid === 'property_video_uploads' && c.contype === 'f' && /created_by/.test(c.def) && c.confdeltype === 'n'))
  check('uploads: UNIQUE storage_path y (tenant_id, request_id)',
    con('property_video_uploads_storage_path_key')?.contype === 'u' && con('property_video_uploads_request_key')?.def === 'UNIQUE (tenant_id, request_id)')
  check('uploads: CHECKs de mime, status, path derivado, resolved, failure, TTL',
    ['mime_type_check', 'status_check', 'storage_path_check', 'resolved_check', 'failure_check', 'failure_reason_check', 'expiry_check']
      .every((s) => con(`property_video_uploads_${s}`)?.contype === 'c'))
  check('status: sólo reserved/completed/cancelled/failed',
    /reserved.*completed.*cancelled.*failed/.test(con('property_video_uploads_status_check')?.def ?? '') &&
    !/expired|uploaded|finalizing/.test(con('property_video_uploads_status_check')?.def ?? ''))
  check('property_videos: UNIQUE storage_path', con('property_videos_storage_path_key')?.def === 'UNIQUE (storage_path)')
  check('property_videos: CHECK prefijo de tenant', con('property_videos_storage_path_tenant_check')?.contype === 'c')
  check('property_videos: FK compuesta CASCADE', con('property_videos_property_tenant_fkey')?.confdeltype === 'c')
  check('property_videos: created_by ON DELETE SET NULL', con('property_videos_created_by_fkey')?.confdeltype === 'n')

  const { rows: trg } = await main.query<{ tgname: string; def: string }>(
    `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'public.property_videos'::regclass AND NOT tgisinternal`)
  check('trigger BEFORE INSERT de cupo', trg.some((t) => t.tgname === 'property_videos_enforce_capacity' && /BEFORE INSERT/.test(t.def)))
  check('trigger BEFORE UPDATE de identidad', trg.some((t) => t.tgname === 'property_videos_guard_identity' && /BEFORE UPDATE/.test(t.def)))

  const { rows: rls } = await main.query<{ relrowsecurity: boolean; policies: number; acl: string[] | null }>(
    `SELECT c.relrowsecurity, (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'property_video_uploads') AS policies,
            c.relacl::text[] AS acl
     FROM pg_class c WHERE c.oid = 'public.property_video_uploads'::regclass`)
  check('uploads: RLS habilitado y 0 policies', rls[0]!.relrowsecurity && rls[0]!.policies === 0, rls[0])
  summary.uploads_acl = rls[0]!.acl
  check('uploads: ACL = owner + service_role SELECT (sin PUBLIC/anon/authenticated)',
    JSON.stringify([...(rls[0]!.acl ?? [])].sort()) === JSON.stringify(['postgres=arwdDxtm/postgres', 'service_role=r/postgres'].sort()),
    rls[0]!.acl)

  const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  const tablePriv: Record<string, string[]> = {}
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const { rows } = await main.query<{ p: string; has: boolean }>(
      `SELECT p, has_table_privilege($1, 'public.property_video_uploads', p) AS has FROM unnest($2::text[]) p`, [role, privs])
    tablePriv[role] = rows.filter((r) => r.has).map((r) => r.p)
  }
  summary.uploads_table_privileges = tablePriv
  check('uploads: anon y authenticated sin ningún privilegio', tablePriv.anon!.length === 0 && tablePriv.authenticated!.length === 0, tablePriv)
  check('uploads: service_role sólo SELECT', JSON.stringify(tablePriv.service_role) === '["SELECT"]', tablePriv)

  const fnInfo: Json[] = []
  for (const fn of [...RPCS, ...TRIGGER_FNS]) {
    const { rows } = await main.query<{ secdef: boolean; config: string[] | null; acl: string[] | null; anon: boolean; auth: boolean; svc: boolean; public_x: boolean }>(
      `SELECT p.prosecdef AS secdef, p.proconfig AS config, p.proacl::text[] AS acl,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_x
       FROM pg_proc p WHERE p.oid = $1::regprocedure`, [fn])
    fnInfo.push({ fn: fn.replace(/\(.*$/, ''), ...rows[0]! })
  }
  summary.functions = fnInfo
  const rpcInfo = fnInfo.slice(0, RPCS.length)
  check('RPCs: SECURITY DEFINER + search_path vacío', rpcInfo.every((f) => f.secdef === true && JSON.stringify(f.config) === '["search_path=\\"\\""]'), rpcInfo)
  check('RPCs: EXECUTE sólo service_role (ni PUBLIC, ni anon, ni authenticated)',
    rpcInfo.every((f) => f.svc === true && f.anon === false && f.auth === false && f.public_x === false), rpcInfo)
  const trgInfo = fnInfo.slice(RPCS.length)
  check('funciones de trigger: nadie con EXECUTE', trgInfo.every((f) => !f.svc && !f.anon && !f.auth && !f.public_x), trgInfo)
  check('trigger de cupo SECURITY DEFINER + search_path vacío', trgInfo[0]!.secdef === true && JSON.stringify(trgInfo[0]!.config) === '["search_path=\\"\\""]')

  const { rows: defacl } = await main.query<{ objtype: string; acl: string[] }>(
    `SELECT d.defaclobjtype AS objtype, d.defaclacl::text[] AS acl FROM pg_default_acl d
     JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(d.defaclrole) = 'postgres' AND d.defaclobjtype IN ('f', 'r')`)
  summary.default_privileges = defacl
  check('default privileges siguen dando EXECUTE/ALL a anon/authenticated (por eso los REVOKE explícitos)',
    defacl.some((d) => d.objtype === 'f' && d.acl.some((a) => a.startsWith('anon=X'))))
}

async function permissionBehavior(tA: string, pA: string) {
  section('20 · permisos ejercitados (SET ROLE real)')
  const r = await tx(main, 'service_role', () => reserve(main, tA, pA))
  const uploadId = String(r.upload_id)
  const calls: Array<[string, string, unknown[]]> = [
    ['reserve', reserveSql(), [tA, pA, null, randomUUID(), MP4, 60]],
    ['cancel', 'SELECT public.cancel_property_video_upload($1, $2) AS r', [tA, uploadId]],
    ['fail', 'SELECT public.fail_property_video_upload($1, $2, $3) AS r', [tA, uploadId, 'empty_file']],
    ['get', 'SELECT public.get_property_video_upload_object($1, $2) AS r', [tA, uploadId]],
    ['finalize', 'SELECT public.finalize_property_video_upload($1, $2, $3, $4, $5, $6) AS r', [tA, uploadId, randomUUID(), 'v', 1, 1]],
  ]
  for (const role of ['anon', 'authenticated'] as const) {
    const denied: string[] = []
    for (const [name, sql, params] of calls) {
      const res = await attempt(() => tx(main, role, () => main.query(sql, params), role === 'authenticated' ? ownerClaims(tA) : undefined))
      if (!res.ok && res.error.code === '42501') denied.push(name)
    }
    check(`${role}: las 5 RPCs → 42501`, denied.length === 5, denied)
    const sel = await attempt(() => tx(main, role, () => main.query('SELECT 1 FROM public.property_video_uploads LIMIT 1')))
    const ins = await attempt(() => tx(main, role, () => main.query(
      `INSERT INTO public.property_video_uploads (id, tenant_id, property_id, request_id, storage_path, mime_type, expires_at)
       VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'x', 'video/mp4', now() + interval '1 hour')`, [tA, pA])))
    check(`${role}: SELECT/INSERT directo en property_video_uploads → 42501`,
      !sel.ok && sel.error.code === '42501' && !ins.ok && ins.error.code === '42501')
  }
  const svcSel = await attempt(() => tx(main, 'service_role', () => main.query('SELECT count(*) FROM public.property_video_uploads')))
  const svcWrites: Settled<unknown>[] = []
  for (const [sql, params] of [
    [`INSERT INTO public.property_video_uploads (id, tenant_id, property_id, request_id, storage_path, mime_type, expires_at)
      VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'x', 'video/mp4', now() + interval '1 hour')`, [tA, pA]],
    [`UPDATE public.property_video_uploads SET status = 'completed' WHERE id = $1`, [uploadId]],
    [`DELETE FROM public.property_video_uploads WHERE id = $1`, [uploadId]],
  ] as Array<[string, unknown[]]>) svcWrites.push(await attempt(() => tx(main, 'service_role', () => main.query(sql, params))))
  check('service_role: SELECT permitido', svcSel.ok)
  check('service_role: INSERT/UPDATE/DELETE directo → 42501', svcWrites.every((w) => !w.ok && w.error.code === '42501'),
    svcWrites.map((w) => (w.ok ? 'ok' : w.error.code)))
  const trgCall = await attempt(() => tx(main, 'service_role', () => main.query('SELECT public.property_videos_enforce_capacity()')))
  check('service_role: no puede invocar la función de trigger', !trgCall.ok && trgCall.error.code === '42501', trgCall)
  await tx(main, 'service_role', () => cancel(main, tA, uploadId))
}

async function reserveRpc(tA: string, tB: string) {
  section('E/F/K · reserve, idempotencia y TTL')
  const p = await newProperty(tA)
  const req = randomUUID()
  const r1 = await tx(main, 'service_role', () => reserve(main, tA, p, { request: req, user: syntheticUserId }))
  const row = await uploadRow(String(r1.upload_id))
  check('reserve → reserved, already=false', r1.outcome === 'reserved' && r1.already === false, r1)
  check('path generado en SQL = <tenant>/<upload_id>.mp4', r1.storage_path === `${tA}/${r1.upload_id}.mp4` && row?.storage_path === r1.storage_path, r1)
  check('fila: status reserved, resolved_at NULL, created_by = usuario', row?.status === 'reserved' && row?.resolved_at === null && row?.created_by === syntheticUserId)
  const again = await tx(main, 'service_role', () => reserve(main, tA, p, { request: req, user: syntheticUserId }))
  check('mismo request_id → misma reserva (already=true)', again.outcome === 'reserved' && again.already === true && again.upload_id === r1.upload_id, again)
  const otherMime = await tx(main, 'service_role', () => reserve(main, tA, p, { request: req, user: syntheticUserId, mime: 'video/webm' }))
  const pOther = await newProperty(tA)
  const otherProp = await tx(main, 'service_role', () => reserve(main, tA, pOther, { request: req, user: syntheticUserId }))
  const otherUser = await tx(main, 'service_role', () => reserve(main, tA, p, { request: req, user: null }))
  check('mismo request_id con otro MIME / propiedad / usuario → request_conflict',
    [otherMime, otherProp, otherUser].every((x) => x.outcome === 'request_conflict'), [otherMime, otherProp, otherUser])
  const pB = await newProperty(tB)
  const sameReqOtherTenant = await tx(main, 'service_role', () => reserve(main, tB, pB, { request: req }))
  check('el request_id es por tenant: otro tenant puede usar el mismo UUID', sameReqOtherTenant.outcome === 'reserved', sameReqOtherTenant)
  await tx(main, 'service_role', () => cancel(main, tA, String(r1.upload_id)))
  const reused = await tx(main, 'service_role', () => reserve(main, tA, p, { request: req, user: syntheticUserId }))
  check('request_id de una reserva ya resuelta → request_already_used', reused.outcome === 'request_already_used', reused)

  const mimes: string[] = []
  for (const mime of ['video/mp4', 'video/webm', 'video/quicktime']) {
    const pp = await newProperty(tA)
    const x = await tx(main, 'service_role', () => reserve(main, tA, pp, { mime }))
    mimes.push(String(String(x.storage_path).split('.').pop()))
  }
  check('extensiones mp4/webm/mov derivadas del MIME', mimes.join(',') === 'mp4,webm,mov', mimes)
  const invalid: Json[] = []
  for (const mime of ['video/x-msvideo', 'text/plain', 'VIDEO/MP4']) invalid.push(await tx(main, 'service_role', () => reserve(main, tA, p, { mime })))
  check('MIME fuera de la lista → invalid_mime', invalid.every((x) => x.outcome === 'invalid_mime'), invalid)

  section('K · TTL parametrizado (rango defensivo de la base)')
  const ttl = async (secs: number) => {
    const pp = await newProperty(tA)
    return (await tx(main, 'service_role', () => reserve(main, tA, pp, { ttl: secs }))).outcome
  }
  const ttlResults = { past: await ttl(-10), zero: await ttl(0), m15: await ttl(900), h2: await ttl(7200), h3: await ttl(10800), h3plus1s: await ttl(10801), h24: await ttl(86400) }
  summary.ttl = ttlResults
  check('TTL: pasado y 0 → invalid_expiry', ttlResults.past === 'invalid_expiry' && ttlResults.zero === 'invalid_expiry', ttlResults)
  check('TTL: 15 min, 2 h y exactamente 3 h → reserved', ttlResults.m15 === 'reserved' && ttlResults.h2 === 'reserved' && ttlResults.h3 === 'reserved', ttlResults)
  check('TTL: 3 h + 1 s y 24 h → invalid_expiry', ttlResults.h3plus1s === 'invalid_expiry' && ttlResults.h24 === 'invalid_expiry', ttlResults)
  const directTtl = await attempt(() => main.query(
    `INSERT INTO public.property_video_uploads (id, tenant_id, property_id, request_id, storage_path, mime_type, expires_at)
     SELECT g, $1::uuid, $2::uuid, gen_random_uuid(), $1::uuid::text || '/' || g::text || '.mp4', 'video/mp4', now() + interval '4 hours'
     FROM gen_random_uuid() g`, [tA, p]))
  check('CHECK de tabla rechaza TTL > 3 h aunque se escriba directo',
    !directTtl.ok && directTtl.error.constraint === 'property_video_uploads_expiry_check', directTtl)

  section('E · validaciones de tenant y propiedad')
  const suspended = await newTenant('susp', 'suspended')
  const pS = await newProperty(suspended)
  const deletedT = await newTenant('del')
  const pD = await newProperty(deletedT)
  await main.query(`UPDATE public.tenants SET deleted_at = now() WHERE id = $1`, [deletedT])
  const trial = await newTenant('trial', 'trial')
  const pT = await newProperty(trial)
  const pSoft = await newProperty(tA)
  await main.query(`UPDATE public.properties SET deleted_at = now() WHERE id = $1`, [pSoft])
  const v = {
    suspended: (await tx(main, 'service_role', () => reserve(main, suspended, pS))).outcome,
    deleted: (await tx(main, 'service_role', () => reserve(main, deletedT, pD))).outcome,
    trial: (await tx(main, 'service_role', () => reserve(main, trial, pT))).outcome,
    softDeletedProperty: (await tx(main, 'service_role', () => reserve(main, tA, pSoft))).outcome,
    missingProperty: (await tx(main, 'service_role', () => reserve(main, tA, randomUUID()))).outcome,
    nullInput: (await tx(main, 'service_role', () => scalar(main, reserveSql(), [tA, null, null, randomUUID(), MP4, 60]))).outcome,
  }
  summary.reserve_validations = v
  check('tenant suspended / borrado → tenant_unavailable; trial → reserved',
    v.suspended === 'tenant_unavailable' && v.deleted === 'tenant_unavailable' && v.trial === 'reserved', v)
  check('propiedad archivada / inexistente → property_not_found; null → invalid_input',
    v.softDeletedProperty === 'property_not_found' && v.missingProperty === 'property_not_found' && v.nullInput === 'invalid_input', v)
}

async function cancelFailRpcs(tA: string, tB: string) {
  section('G · cancel / fail')
  const p = await newProperty(tA)
  const a = await tx(main, 'service_role', () => reserve(main, tA, p))
  const b = await tx(main, 'service_role', () => reserve(main, tA, p))
  const full = await tx(main, 'service_role', () => reserve(main, tA, p))
  check('2 reservas vivas → la 3ª limit_reached', full.outcome === 'limit_reached', full)
  const c1 = await tx(main, 'service_role', () => cancel(main, tA, String(a.upload_id)))
  const c2 = await tx(main, 'service_role', () => cancel(main, tA, String(a.upload_id)))
  const rowA = await uploadRow(String(a.upload_id))
  check('cancel → cancelled; repetido → cancelled already=true',
    c1.outcome === 'cancelled' && c1.already === false && c2.outcome === 'cancelled' && c2.already === true, [c1, c2])
  check('cancel: resolved_at seteado, sin failure_reason', rowA?.status === 'cancelled' && rowA?.resolved_at !== null && rowA?.failure_reason === null)
  const freed = await tx(main, 'service_role', () => reserve(main, tA, p))
  check('cancelar libera el cupo', freed.outcome === 'reserved', freed)

  const bad = await tx(main, 'service_role', () => fail(main, tA, String(b.upload_id), 'whatever'))
  const nul = await attempt(() => tx(main, 'service_role', () => fail(main, tA, String(b.upload_id), null as unknown as string)))
  check('fail con razón fuera del conjunto cerrado → invalid_reason', bad.outcome === 'invalid_reason' && nul.ok && nul.value.outcome === 'invalid_reason', [bad, nul])
  const f1 = await tx(main, 'service_role', () => fail(main, tA, String(b.upload_id), 'duration_too_long'))
  const f2 = await tx(main, 'service_role', () => fail(main, tA, String(b.upload_id), 'empty_file'))
  check('fail → failed(reason); repetido conserva la primera razón',
    f1.outcome === 'failed' && f1.already === false && f2.outcome === 'failed' && f2.already === true && f2.reason === 'duration_too_long', [f1, f2])
  const crossC = await tx(main, 'service_role', () => cancel(main, tA, String(b.upload_id)))
  const crossF = await tx(main, 'service_role', () => fail(main, tA, String(a.upload_id), 'empty_file'))
  check('cancel de failed → already_failed; fail de cancelled → already_cancelled',
    crossC.outcome === 'already_failed' && crossF.outcome === 'already_cancelled', [crossC, crossF])
  const fid = String(freed.upload_id)
  const otherTenant = [
    await tx(main, 'service_role', () => cancel(main, tB, fid)),
    await tx(main, 'service_role', () => fail(main, tB, fid, 'empty_file')),
    await tx(main, 'service_role', () => getObject(main, tB, fid)),
    await tx(main, 'service_role', () => finalize(main, tB, fid, { id: randomUUID(), version: 'v', size: 1 })),
  ]
  check('cancel/fail/get/finalize con OTRO tenant → not_found (sin efecto)',
    otherTenant.every((x) => x.outcome === 'not_found') && (await uploadRow(String(freed.upload_id)))?.status === 'reserved', otherTenant)
}

async function finalizeRpc(tA: string) {
  section('H · finalize (función REAL: caminos sin objeto)')
  const p = await newProperty(tA)
  const r = await tx(main, 'service_role', () => reserve(main, tA, p, { user: syntheticUserId }))
  const id = String(r.upload_id)
  const g = await tx(main, 'service_role', () => getObject(main, tA, id))
  check('get (real) lee storage.objects sin error: object = null, expired=false', g.outcome === 'found' && g.object === null && g.expired === false, g)
  const missing = await tx(main, 'service_role', () => finalize(main, tA, id, { id: randomUUID(), version: 'v1', size: 1000 }))
  check('finalize (real) sin objeto → object_missing, la reserva sigue reserved',
    missing.outcome === 'object_missing' && (await uploadRow(id))?.status === 'reserved', missing)
  const invalid: Json[] = []
  for (const o of [
    { id: null, version: 'v', size: 1000 },
    { id: randomUUID(), version: 'v', size: 52428801 },
    { id: randomUUID(), version: 'v', size: 1000, duration: 61 },
    { id: randomUUID(), version: 'v', size: 1000, duration: 0 },
    { id: randomUUID(), version: 'v', size: 0 },
  ]) invalid.push(await tx(main, 'service_role', () => finalize(main, tA, id, o)))
  check('finalize: object_id nulo, > 50 MiB, > 60 s, 0 s, 0 bytes → invalid_input', invalid.every((x) => x.outcome === 'invalid_input'), invalid)
  await tx(main, 'service_role', () => cancel(main, tA, id))
  const afterCancel = await tx(main, 'service_role', () => finalize(main, tA, id, { id: randomUUID(), version: 'v1', size: 1000 }))
  check('finalize de cancelled → cancelled', afterCancel.outcome === 'cancelled', afterCancel)
  const r2 = await tx(main, 'service_role', () => reserve(main, tA, p))
  await tx(main, 'service_role', () => fail(main, tA, String(r2.upload_id), 'content_mismatch'))
  const afterFail = await tx(main, 'service_role', () => finalize(main, tA, String(r2.upload_id), { id: randomUUID(), version: 'v1', size: 1000 }))
  check('finalize de failed → failed already=true con su razón', afterFail.outcome === 'failed' && afterFail.reason === 'content_mismatch', afterFail)

  section('H · finalize hasta el INSERT [harness: identidad desde lab_2b1_harness.objects]')
  const r3 = await tx(main, 'service_role', () => reserve(main, tA, p, { user: syntheticUserId }))
  const id3 = String(r3.upload_id)
  const obj = await fakeObject(String(r3.storage_path), 4_000_000)
  const g3 = await tx(main, 'service_role', () => getObject(main, tA, id3, H))
  const ident = g3.object as { id: string; version: string; size: number; mimetype: string }
  check('get [harness] devuelve id, version, size y mimetype del objeto vigente',
    ident?.id === obj.id && ident?.version === obj.version && ident?.size === 4_000_000 && ident?.mimetype === MP4, g3)

  // TOCTOU: el objeto se reemplaza entre la inspección y finalize.
  await main.query(`DELETE FROM ${H}.objects WHERE id = $1`, [obj.id])
  const replaced = await fakeObject(String(r3.storage_path), 4_000_000)
  const changed = await tx(main, 'service_role', () => finalize(main, tA, id3, { id: ident.id, version: ident.version, size: 4_000_000 }, H))
  check('TOCTOU: objeto re-subido (otro id) → object_changed, sin escribir nada',
    changed.outcome === 'object_changed' && (await uploadRow(id3))?.status === 'reserved' && (await counts(p)).videos === 0, changed)
  await main.query(`UPDATE ${H}.objects SET version = $2 WHERE id = $1`, [replaced.id, randomUUID()])
  const changedVersion = await tx(main, 'service_role', () => finalize(main, tA, id3, { id: replaced.id, version: replaced.version, size: 4_000_000 }, H))
  check('TOCTOU: mismo id con otra version → object_changed', changedVersion.outcome === 'object_changed', changedVersion)
  const fresh = (await tx(main, 'service_role', () => getObject(main, tA, id3, H))).object as { id: string; version: string }
  const done = await tx(main, 'service_role', () => finalize(main, tA, id3, { id: fresh.id, version: fresh.version, size: 4_000_000, duration: 33 }, H))
  const { rows: vids } = await main.query<Json>(`SELECT * FROM public.property_videos WHERE property_id = $1`, [p])
  const v = vids[0]
  check('finalize con la identidad vigente → completed + INSERT', done.outcome === 'completed' && done.already === false && vids.length === 1, done)
  check('video: tenant, property, path de la reserva, mime, size/duración inspeccionados, created_by de la reserva',
    v?.id === done.video_id && v?.tenant_id === tA && v?.property_id === p && v?.storage_path === r3.storage_path &&
    v?.mime_type === MP4 && String(v?.file_size_bytes) === '4000000' && v?.duration_seconds === 33 && v?.created_by === syntheticUserId, v)
  const row3 = await uploadRow(id3)
  check('reserva → completed con resolved_at', row3?.status === 'completed' && row3?.resolved_at !== null)
  const again = await tx(main, 'service_role', () => finalize(main, tA, id3, { id: fresh.id, version: fresh.version, size: 4_000_000 }, H))
  check('finalize repetido → completed already=true, mismo video_id', again.outcome === 'completed' && again.already === true && again.video_id === done.video_id, again)
  const cancelDone = await tx(main, 'service_role', () => cancel(main, tA, id3))
  check('cancel de completed → already_completed (no deshace)', cancelDone.outcome === 'already_completed', cancelDone)

  const mismatch = async (setup: (path: string) => Promise<unknown>, declaredSize: number) => {
    const pp = await newProperty(tA)
    const rr = await tx(main, 'service_role', () => reserve(main, tA, pp))
    await setup(String(rr.storage_path))
    const o = (await tx(main, 'service_role', () => getObject(main, tA, String(rr.upload_id), H))).object as { id: string; version: string } | null
    return tx(main, 'service_role', () => finalize(main, tA, String(rr.upload_id), { id: o?.id ?? randomUUID(), version: o?.version ?? 'v', size: declaredSize }, H))
  }
  const sizeMismatch = await mismatch((path) => fakeObject(path, 5000), 4999)
  const mimeMismatch = await mismatch((path) => fakeObject(path, 5000, 'video/webm'), 5000)
  const archived = await mismatch(async (path) => { const o = await fakeObject(path, 5000); await main.query(`UPDATE ${H}.objects SET archived_at = now() WHERE id = $1`, [o.id]) }, 5000)
  check('tamaño distinto al del objeto → failed object_mismatch', sizeMismatch.outcome === 'failed' && sizeMismatch.reason === 'object_mismatch', sizeMismatch)
  check('MIME del objeto distinto al reservado → failed object_mismatch', mimeMismatch.outcome === 'failed' && mimeMismatch.reason === 'object_mismatch', mimeMismatch)
  check('objeto archivado no cuenta → object_missing', archived.outcome === 'object_missing', archived)

  const late = async (mutate: (tenant: string, property: string) => Promise<unknown>) => {
    const t = await newTenant(`late${randomUUID().slice(0, 6)}`)
    const pp = await newProperty(t)
    const rr = await tx(main, 'service_role', () => reserve(main, t, pp))
    const o = await fakeObject(String(rr.storage_path), 5000)
    await mutate(t, pp)
    return tx(main, 'service_role', () => finalize(main, t, String(rr.upload_id), { id: o.id, version: o.version, size: 5000 }, H))
  }
  const suspendedLate = await late((t) => main.query(`UPDATE public.tenants SET status = 'suspended' WHERE id = $1`, [t]))
  const deletedLate = await late((t) => main.query(`UPDATE public.tenants SET deleted_at = now() WHERE id = $1`, [t]))
  const propLate = await late((_t, pp) => main.query(`UPDATE public.properties SET deleted_at = now() WHERE id = $1`, [pp]))
  check('tenant suspendido / borrado entre reserve y finalize → failed tenant_unavailable',
    suspendedLate.reason === 'tenant_unavailable' && deletedLate.reason === 'tenant_unavailable', [suspendedLate, deletedLate])
  check('propiedad archivada entre reserve y finalize → failed property_unavailable', propLate.reason === 'property_unavailable', propLate)
}

async function concurrency(tA: string, tB: string) {
  section('M · concurrencia real (barrera + transacciones que retienen locks)')

  // Control negativo: misma barrera, reserve SIN lock → la carrera aparece.
  const pc = await newProperty(tA)
  const control = await race([0, 1, 2].map(() => ({ role: 'service_role' as Role, run: (c: pg.Client) =>
    scalar(c, reserveSql(`${H}.reserve_without_lock`), [tA, pc, null, randomUUID(), MP4, TTL_DEFAULT]) })))
  const controlLive = (await counts(pc)).live
  summary.control_negativo = { outcomes: tally(outcomes(control)), live: controlLive }
  check('control negativo: sin el lock la barrera produce > 2 reservas (el test detecta la carrera)', controlLive > 2, summary.control_negativo)
  await main.query(`DELETE FROM public.property_video_uploads WHERE property_id = $1`, [pc])

  // 1 · 3 reserves concurrentes → 2
  const p1 = await newProperty(tA)
  const c1 = await race([0, 1, 2].map(() => ({ role: 'service_role' as Role, run: (c: pg.Client) => reserve(c, tA, p1) })))
  const k1 = await counts(p1)
  summary.case1 = { outcomes: tally(outcomes(c1)), ...k1 }
  check('1 · 3 reserves concurrentes → 2 reserved + 1 limit_reached',
    tally(outcomes(c1)).reserved === 2 && tally(outcomes(c1)).limit_reached === 1 && k1.live === 2, summary.case1)

  // 2 · 1 video + 2 reserves → 1
  const p2 = await newProperty(tA)
  await legacyVideo(tA, p2)
  const c2 = await race([0, 1].map(() => ({ role: 'service_role' as Role, run: (c: pg.Client) => reserve(c, tA, p2) })))
  const k2 = await counts(p2)
  summary.case2 = { outcomes: tally(outcomes(c2)), ...k2 }
  check('2 · 1 video + 2 reserves concurrentes → 1 reserved + 1 limit_reached',
    tally(outcomes(c2)).reserved === 1 && tally(outcomes(c2)).limit_reached === 1 && k2.videos + k2.live === 2, summary.case2)

  // 2b · mismo request_id en paralelo (misma propiedad y en dos propiedades)
  const p2b = await newProperty(tA)
  const p2c = await newProperty(tA)
  const req = randomUUID()
  const c2b = await race([0, 1].map(() => ({ role: 'service_role' as Role, run: (c: pg.Client) => reserve(c, tA, p2b, { request: req }) })))
  const ids2b = new Set(c2b.map((r) => (r.ok ? r.value.upload_id : null)))
  const reqShared = randomUUID()
  const c2c = await race([p2b, p2c].map((pp) => ({ role: 'service_role' as Role, run: (c: pg.Client) => reserve(c, tA, pp, { request: reqShared }) })))
  summary.case2b = { same_property: outcomes(c2b), other_property: outcomes(c2c) }
  check('idempotencia concurrente: mismo request_id → 1 fila, un already=false y un already=true, mismo upload_id',
    tally(outcomes(c2b))['reserved'] === 1 && tally(outcomes(c2b))['reserved(already)'] === 1 && ids2b.size === 1, summary.case2b)
  check('mismo request_id nuevo en 2 propiedades a la vez → 1 reserved + 1 request_conflict (unique_violation mapeado)',
    tally(outcomes(c2c)).reserved === 1 && tally(outcomes(c2c)).request_conflict === 1, summary.case2b)

  // 3 · dos finalize del mismo upload → 1 INSERT, ambos idempotentes
  const p3 = await newProperty(tA)
  const r3 = await tx(main, 'service_role', () => reserve(main, tA, p3))
  const o3 = await fakeObject(String(r3.storage_path), 7777)
  const c3 = await race([0, 1].map(() => ({ role: 'service_role' as Role, run: (c: pg.Client) =>
    finalize(c, tA, String(r3.upload_id), { id: o3.id, version: o3.version, size: 7777 }, H) })))
  const k3 = await counts(p3)
  const vids3 = new Set(c3.map((r) => (r.ok ? r.value.video_id : null)))
  summary.case3 = { outcomes: outcomes(c3), ...k3, distinct_video_ids: vids3.size }
  check('3 · 2 finalize concurrentes [harness] → 1 INSERT; completed + completed(already), mismo video_id',
    tally(outcomes(c3)).completed === 1 && tally(outcomes(c3))['completed(already)'] === 1 && k3.videos === 1 && vids3.size === 1, summary.case3)

  // 4 · reserve vs finalize
  const p4 = await newProperty(tA)
  await legacyVideo(tA, p4)
  const r4 = await tx(main, 'service_role', () => reserve(main, tA, p4))
  const o4 = await fakeObject(String(r4.storage_path), 1234)
  const c4 = await race<Json>([
    { role: 'service_role', run: (c) => finalize(c, tA, String(r4.upload_id), { id: o4.id, version: o4.version, size: 1234 }, H) },
    { role: 'service_role', run: (c) => reserve(c, tA, p4) },
  ])
  const k4 = await counts(p4)
  summary.case4 = { outcomes: outcomes(c4), ...k4 }
  check('4 · 1 video + 1 reserva: finalize ‖ reserve → completed + limit_reached, 2 videos, 0 vivas',
    outcomes(c4)[0] === 'completed' && outcomes(c4)[1] === 'limit_reached' && k4.videos === 2 && k4.live === 0, summary.case4)
  const p4b = await newProperty(tA)
  const r4b = await tx(main, 'service_role', () => reserve(main, tA, p4b))
  const o4b = await fakeObject(String(r4b.storage_path), 1234)
  const c4b = await race<Json>([
    { role: 'service_role', run: (c) => finalize(c, tA, String(r4b.upload_id), { id: o4b.id, version: o4b.version, size: 1234 }, H) },
    { role: 'service_role', run: (c) => reserve(c, tA, p4b) },
    { role: 'service_role', run: (c) => reserve(c, tA, p4b) },
  ])
  const k4b = await counts(p4b)
  summary.case4b = { outcomes: outcomes(c4b), ...k4b }
  check('4b · 0 videos + 1 reserva: finalize ‖ 2 reserves → completed + 1 reserved + 1 limit_reached (total 2)',
    outcomes(c4b)[0] === 'completed' && tally(outcomes(c4b).slice(1)).reserved === 1 && k4b.videos + k4b.live === 2, summary.case4b)

  // 5 · reserva vencida vs reserve
  const p5 = await newProperty(tA)
  await legacyVideo(tA, p5)
  const expiredId = randomUUID()
  const expiredReq = randomUUID()
  await main.query(
    `INSERT INTO public.property_video_uploads (id, tenant_id, property_id, request_id, storage_path, mime_type, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $2::uuid::text || '/' || $1::uuid::text || '.mp4', 'video/mp4', now() - interval '1 hour', now() - interval '2 hours')`,
    [expiredId, tA, p5, expiredReq])
  const gExp = await tx(main, 'service_role', () => getObject(main, tA, expiredId))
  check('5 · vencida: status sigue reserved (expired es derivado) y get la marca expired=true', gExp.status === 'reserved' && gExp.expired === true, gExp)
  const c5 = await race<Json>([
    { role: 'service_role', run: (c) => finalize(c, tA, expiredId, { id: randomUUID(), version: 'v', size: 1000 }) },
    { role: 'service_role', run: (c) => reserve(c, tA, p5) },
    { role: 'service_role', run: (c) => reserve(c, tA, p5) },
  ])
  const k5 = await counts(p5)
  summary.case5 = { outcomes: outcomes(c5), ...k5 }
  check('5 · 1 video + 1 vencida: finalize(real) ‖ 2 reserves → expired + 1 reserved + 1 limit_reached',
    outcomes(c5)[0] === 'expired' && tally(outcomes(c5).slice(1)).reserved === 1 && tally(outcomes(c5).slice(1)).limit_reached === 1 &&
    k5.videos === 1 && k5.live === 1, summary.case5)
  const reuseExpired = await tx(main, 'service_role', () => reserve(main, tA, p5, { request: expiredReq }))
  check('5 · request_id de la vencida → request_already_used', reuseExpired.outcome === 'request_already_used', reuseExpired)

  // 6 · cancel vs finalize
  const orderings: Record<string, number> = {}
  let consistent = true
  for (let i = 0; i < 8; i++) {
    const p6 = await newProperty(tA)
    const r6 = await tx(main, 'service_role', () => reserve(main, tA, p6))
    const o6 = await fakeObject(String(r6.storage_path), 2222)
    const ops: RaceOp<Json>[] = [
      { role: 'service_role', run: (c) => cancel(c, tA, String(r6.upload_id)) },
      { role: 'service_role', run: (c) => finalize(c, tA, String(r6.upload_id), { id: o6.id, version: o6.version, size: 2222 }, H) },
    ]
    const c6 = await race(i % 2 === 0 ? ops : [...ops].reverse())
    const [cancelOut, finalizeOut] = i % 2 === 0 ? outcomes(c6) : outcomes(c6).reverse()
    const status = (await uploadRow(String(r6.upload_id)))?.status
    const k6 = await counts(p6)
    const key = `${cancelOut}/${finalizeOut}`
    orderings[key] = (orderings[key] ?? 0) + 1
    const ok6 = (status === 'cancelled' && cancelOut === 'cancelled' && finalizeOut === 'cancelled' && k6.videos === 0) ||
                (status === 'completed' && cancelOut === 'already_completed' && finalizeOut === 'completed' && k6.videos === 1)
    if (!ok6) { consistent = false; nok('6 · cancel ‖ finalize inconsistente', JSON.stringify({ key, status, ...k6 })) }
  }
  summary.case6 = orderings
  check('6 · cancel ‖ finalize [harness] × 8: siempre (cancelled, 0 videos) o (completed, 1 video)', consistent, orderings)

  // 7 · inserts legacy / directos concurrentes
  const p7 = await newProperty(tA)
  const c7 = await race<Json>([0, 1, 2].map(() => ({ role: 'authenticated' as Role, claims: ownerClaims(tA), run: (c: pg.Client) =>
    c.query(legacyInsertSql, [tA, p7, null]).then(() => ({ outcome: 'inserted' }) as Json) })))
  const k7 = await counts(p7)
  summary.case7 = { outcomes: tally(outcomes(c7)), ...k7, messages: [...new Set(c7.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error.message)))] }
  check('7 · 3 INSERT legacy concurrentes (authenticated owner, RLS activo) → 2 insertados + 1 23514',
    tally(outcomes(c7)).inserted === 2 && tally(outcomes(c7))['ERR:23514'] === 1 && k7.videos === 2, summary.case7)
  const p7b = await newProperty(tA)
  await tx(main, 'service_role', () => reserve(main, tA, p7b))
  const c7b = await race<Json>([0, 1, 2].map(() => ({ role: 'postgres' as Role, run: (c: pg.Client) =>
    c.query(legacyInsertSql, [tA, p7b, null]).then(() => ({ outcome: 'inserted' }) as Json) })))
  const k7b = await counts(p7b)
  summary.case7b = { outcomes: tally(outcomes(c7b)), ...k7b }
  check('7b · 1 reserva viva + 3 INSERT directos (postgres, sin RLS) → 1 insertado; total nunca > 2',
    tally(outcomes(c7b)).inserted === 1 && k7b.videos + k7b.live === 2, summary.case7b)
  const p7c = await newProperty(tA)
  await tx(main, 'service_role', () => reserve(main, tA, p7c))
  await tx(main, 'service_role', () => reserve(main, tA, p7c))
  const hidden = await attempt(() => tx(main, 'authenticated', () => main.query(legacyInsertSql, [tA, p7c, null]), ownerClaims(tA)))
  check('7c · authenticated no ve las reservas, pero el trigger (DEFINER) las cuenta → 23514',
    !hidden.ok && hidden.error.code === '23514' && hidden.error.message === 'property_video_limit_reached', hidden)

  // 8 · property de otro tenant
  const pB = await newProperty(tB)
  const pA8 = await newProperty(tA)
  const x8 = {
    reserve: (await tx(main, 'service_role', () => reserve(main, tA, pB))).outcome,
    direct: await attempt(() => main.query(legacyInsertSql, [tA, pB, null])),
    owner: await attempt(() => tx(main, 'authenticated', () => main.query(legacyInsertSql, [tA, pB, null]), ownerClaims(tA))),
    uploadsFk: await attempt(() => main.query(
      `INSERT INTO public.property_video_uploads (id, tenant_id, property_id, request_id, storage_path, mime_type, expires_at)
       SELECT g, $1::uuid, $2::uuid, gen_random_uuid(), $1::uuid::text || '/' || g::text || '.mp4', 'video/mp4', now() + interval '1 hour' FROM gen_random_uuid() g`, [tA, pB])),
  }
  summary.case8 = { reserve: x8.reserve, direct: x8.direct.ok ? 'ok' : x8.direct.error.code, owner: x8.owner.ok ? 'ok' : x8.owner.error.code, uploadsFk: x8.uploadsFk.ok ? 'ok' : x8.uploadsFk.error.code }
  check('8 · property de otro tenant: reserve → property_not_found; INSERT directo / legacy / uploads → 23503',
    x8.reserve === 'property_not_found' && !x8.direct.ok && x8.direct.error.code === '23503' &&
    !x8.owner.ok && x8.owner.error.code === '23503' && !x8.uploadsFk.ok && x8.uploadsFk.error.code === '23503', summary.case8)

  // 9 · storage_path de otro tenant
  const insertPath = (path: string) => attempt(() => main.query(
    `INSERT INTO public.property_videos (tenant_id, property_id, storage_path, mime_type, file_size_bytes) VALUES ($1, $2, $3, 'video/mp4', 1)`, [tA, pA8, path]))
  const foreign = await insertPath(`${tB}/${randomUUID()}.mp4`)
  const nested = await insertPath(`${tA}/sub/${randomUUID()}.mp4`)
  const traversal = await insertPath(`${tA}/../${tB}/x.mp4`)
  const okPath = `${tA}/${randomUUID()}.mp4`
  const first = await insertPath(okPath)
  const dup = await insertPath(okPath)
  const ownerForeign = await attempt(() => tx(main, 'authenticated', () => main.query(
    `INSERT INTO public.property_videos (tenant_id, property_id, storage_path, mime_type, file_size_bytes) VALUES ($1, $2, $3, 'video/mp4', 1)`,
    [tA, pA8, `${tB}/${randomUUID()}.mp4`]), ownerClaims(tA)))
  const uploadsPath = await attempt(() => main.query(
    `INSERT INTO public.property_video_uploads (id, tenant_id, property_id, request_id, storage_path, mime_type, expires_at)
     VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), $3, 'video/mp4', now() + interval '1 hour')`, [tA, pA8, `${tA}/${randomUUID()}.mp4`]))
  const code = (s: Settled<unknown>) => (s.ok ? 'ok' : s.error.code)
  summary.case9 = { foreign: code(foreign), nested: code(nested), traversal: code(traversal), first: code(first), duplicate: code(dup), ownerForeign: code(ownerForeign), uploadsNotDerived: code(uploadsPath) }
  check('9 · path de otro tenant / subcarpeta / traversal → CHECK property_videos_storage_path_tenant_check (también como owner legacy)',
    [foreign, nested, traversal, ownerForeign].every((s) => !s.ok && s.error.constraint === 'property_videos_storage_path_tenant_check'), summary.case9)
  check('9 · mismo storage_path dos veces → UNIQUE property_videos_storage_path_key',
    first.ok && !dup.ok && dup.error.constraint === 'property_videos_storage_path_key', summary.case9)
  check('9 · uploads: path que no es <tenant>/<id>.<ext> → CHECK property_video_uploads_storage_path_check',
    !uploadsPath.ok && uploadsPath.error.constraint === 'property_video_uploads_storage_path_check', summary.case9)

  // 10 · identidad inmutable
  const { rows: [video] } = await main.query<{ id: string }>(`SELECT id FROM public.property_videos WHERE storage_path = $1`, [okPath])
  const pOther = await newProperty(tA)
  const mut = {
    tenant: await attempt(() => main.query(`UPDATE public.property_videos SET tenant_id = $2 WHERE id = $1`, [video!.id, tB])),
    property: await attempt(() => main.query(`UPDATE public.property_videos SET property_id = $2 WHERE id = $1`, [video!.id, pOther])),
    path: await attempt(() => main.query(`UPDATE public.property_videos SET storage_path = $2 WHERE id = $1`, [video!.id, `${tA}/${randomUUID()}.mp4`])),
    owner: await attempt(() => tx(main, 'authenticated', () => main.query(
      `UPDATE public.property_videos SET storage_path = $2 WHERE id = $1`, [video!.id, `${tA}/${randomUUID()}.mp4`]), ownerClaims(tA))),
    allowed: await attempt(() => main.query(`UPDATE public.property_videos SET title = 'renombrado', sort_order = 1 WHERE id = $1`, [video!.id])),
  }
  summary.case10 = Object.fromEntries(Object.entries(mut).map(([k, s]) => [k, s.ok ? 'ok' : `${s.error.code}:${s.error.message}`]))
  check('10 · UPDATE de tenant_id / property_id / storage_path → property_video_identity_immutable (también como owner)',
    [mut.tenant, mut.property, mut.path, mut.owner].every((s) => !s.ok && s.error.code === '23514' && s.error.message === 'property_video_identity_immutable'), summary.case10)
  check('10 · UPDATE de title / sort_order sigue permitido', mut.allowed.ok, summary.case10)
}

async function stress(tA: string) {
  section('N · ronda mixta (6 conexiones, todas las operaciones a la vez) × 6')
  let violations = 0
  const mix: Record<string, number> = {}
  for (let round = 0; round < 6; round++) {
    const p = await newProperty(tA)
    const r1 = await tx(main, 'service_role', () => reserve(main, tA, p))
    const r2 = await tx(main, 'service_role', () => reserve(main, tA, p))
    const o1 = await fakeObject(String(r1.storage_path), 3333)
    const ops: RaceOp<Json>[] = [
      { role: 'service_role', run: (c) => finalize(c, tA, String(r1.upload_id), { id: o1.id, version: o1.version, size: 3333 }, H) },
      { role: 'service_role', run: (c) => cancel(c, tA, String(r2.upload_id)) },
      { role: 'service_role', run: (c) => fail(c, tA, String(r2.upload_id), 'truncated_container') },
      { role: 'service_role', run: (c) => reserve(c, tA, p) },
      { role: 'service_role', run: (c) => reserve(c, tA, p) },
      { role: 'authenticated', claims: ownerClaims(tA), run: (c) => c.query(legacyInsertSql, [tA, p, null]).then(() => ({ outcome: 'inserted' }) as Json) },
    ]
    const shuffled = ops.map((op) => ({ op, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.op)
    const res = await race(shuffled, 150)
    for (const o of outcomes(res)) mix[o] = (mix[o] ?? 0) + 1
    const k = await counts(p)
    const { rows: [st] } = await main.query<{ completed: number; videos_from_uploads: number }>(
      `SELECT (SELECT count(*)::int FROM public.property_video_uploads WHERE property_id = $1 AND status = 'completed') AS completed,
              (SELECT count(*)::int FROM public.property_videos v JOIN public.property_video_uploads u ON u.storage_path = v.storage_path WHERE v.property_id = $1) AS videos_from_uploads`, [p])
    if (k.videos + k.live > 2 || st!.completed !== st!.videos_from_uploads) violations++
  }
  summary.stress = { outcomes: mix, invariant_violations: violations }
  check('ronda mixta: videos + reservas vivas ≤ 2 y completed ⇔ video, en las 6 rondas', violations === 0, summary.stress)
}

async function createdBySetNull(tA: string) {
  section('D · created_by ON DELETE SET NULL (usuario de auth sintético)')
  const p = await newProperty(tA)
  await legacyVideo(tA, p, syntheticUserId)
  const r = await tx(main, 'service_role', () => reserve(main, tA, p, { user: syntheticUserId }))
  await main.query(`DELETE FROM auth.users WHERE id = $1`, [syntheticUserId])
  const deletedUser = syntheticUserId
  syntheticUserId = null
  const { rows: [after] } = await main.query<{ video_created_by: string | null; upload_created_by: string | null; refs: number }>(
    `SELECT (SELECT created_by FROM public.property_videos WHERE property_id = $1 LIMIT 1) AS video_created_by,
            (SELECT created_by FROM public.property_video_uploads WHERE id = $2) AS upload_created_by,
            (SELECT count(*)::int FROM public.property_videos WHERE created_by = $3) AS refs`, [p, r.upload_id, deletedUser])
  check('borrar el usuario de auth no falla y deja created_by = NULL en video y reserva',
    after!.video_created_by === null && after!.upload_created_by === null && after!.refs === 0, after)
}

async function purge() {
  section('O · admin_purge_tenant incluye property_video_uploads')
  const { rows: [fn] } = await main.query<{ md5: string; has: boolean }>(
    `SELECT md5(pg_get_functiondef('public.admin_purge_tenant(uuid)'::regprocedure)) AS md5,
            pg_get_functiondef('public.admin_purge_tenant(uuid)'::regprocedure) LIKE '%DELETE FROM public.property_video_uploads WHERE tenant_id = p_tenant_id%' AS has`)
  summary.purge_md5 = fn!.md5
  check('el cuerpo de admin_purge_tenant borra property_video_uploads', fn!.has)
  const t = await newTenant('purge')
  const p = await newProperty(t)
  const cancelled = await tx(main, 'service_role', () => reserve(main, t, p))
  await tx(main, 'service_role', () => cancel(main, t, String(cancelled.upload_id)))
  const live = await tx(main, 'service_role', () => reserve(main, t, p))
  await legacyVideo(t, p)
  check('fixture del purge: 1 cancelada + 1 viva + 1 video', cancelled.outcome === 'reserved' && live.outcome === 'reserved', [cancelled, live])
  const result = await tx(main, 'service_role', () => scalar(main, 'SELECT public.admin_purge_tenant($1) AS r', [t]))
  const { rows: [left] } = await main.query<{ uploads: number; videos: number; tenants: number }>(
    `SELECT (SELECT count(*)::int FROM public.property_video_uploads WHERE tenant_id = $1) AS uploads,
            (SELECT count(*)::int FROM public.property_videos WHERE tenant_id = $1) AS videos,
            (SELECT count(*)::int FROM public.tenants WHERE id = $1) AS tenants`, [t])
  summary.purge = { property_videos: result.property_videos, property_video_uploads: result.property_video_uploads, left }
  check('purge (como service_role): reporta 1 video y 2 reservas; no queda nada del tenant',
    result.property_videos === 1 && result.property_video_uploads === 2 && left!.uploads === 0 && left!.videos === 0 && left!.tenants === 0, summary.purge)
  tenantIds.splice(tenantIds.indexOf(t), 1)

  // Purge concurrente con finalize / cancel / reserve / insert legacy, × 8.
  const rounds: string[][] = []
  let purgeProblems = 0
  for (let i = 0; i < 8; i++) {
    const t2 = await newTenant(`purgec${i}`)
    const p2 = await newProperty(t2)
    const r2 = await tx(main, 'service_role', () => reserve(main, t2, p2))
    const r3 = await tx(main, 'service_role', () => reserve(main, t2, p2))
    const o2 = await fakeObject(String(r2.storage_path), 4444)
    const ops: Array<[string, RaceOp<Json>]> = [
      ['purge', { role: 'service_role', run: (c) => scalar(c, 'SELECT public.admin_purge_tenant($1) AS r', [t2]).then(() => ({ outcome: 'purged' }) as Json) }],
      ['finalize', { role: 'service_role', run: (c) => finalize(c, t2, String(r2.upload_id), { id: o2.id, version: o2.version, size: 4444 }, H) }],
      ['cancel', { role: 'service_role', run: (c) => cancel(c, t2, String(r3.upload_id)) }],
      ['reserve', { role: 'service_role', run: (c) => reserve(c, t2, p2) }],
      ['legacy', { role: 'postgres', run: (c) => c.query(legacyInsertSql, [t2, p2, null]).then(() => ({ outcome: 'inserted' }) as Json) }],
    ]
    const rotated = [...ops.slice(i % ops.length), ...ops.slice(0, i % ops.length)]
    const res = await race(rotated.map(([, op]) => op))
    const named = rotated.map(([name], k) => `${name}:${outcomes(res)[k]}`)
    rounds.push(named)
    const purgeOk = res[rotated.findIndex(([name]) => name === 'purge')]!.ok
    const { rows: [left] } = await main.query<{ n: number }>(
      `SELECT (SELECT count(*)::int FROM public.property_video_uploads WHERE tenant_id = $1) +
              (SELECT count(*)::int FROM public.property_videos WHERE tenant_id = $1) +
              (SELECT count(*)::int FROM public.properties WHERE tenant_id = $1) +
              (SELECT count(*)::int FROM public.tenants WHERE id = $1) AS n`, [t2])
    if (!purgeOk || left!.n !== 0 || named.some((x) => x.endsWith('ERR:40P01'))) purgeProblems++
    if (left!.n === 0) tenantIds.splice(tenantIds.indexOf(t2), 1)
  }
  summary.purge_concurrent = { rounds, problems: purgeProblems }
  check('purge ‖ finalize ‖ cancel ‖ reserve ‖ insert legacy × 8: purge siempre completa, 0 residuos, 0 deadlocks',
    purgeProblems === 0, summary.purge_concurrent)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** La reserva desaparece (purge / cascada) mientras la RPC espera el lock de la propiedad. */
async function vanishedWhileWaiting(tA: string) {
  section('G/H · la reserva desaparece mientras la RPC espera el lock → not_found')
  const ops: Array<[string, (c: pg.Client, u: string) => Promise<Json>]> = [
    ['cancel', (c, u) => cancel(c, tA, u)],
    ['fail', (c, u) => fail(c, tA, u, 'empty_file')],
    ['finalize', (c, u) => finalize(c, tA, u, { id: randomUUID(), version: 'v', size: 1000 })],
  ]
  const got: Record<string, string> = {}
  for (const [name, op] of ops) {
    const p = await newProperty(tA)
    const r = await tx(main, 'service_role', () => reserve(main, tA, p))
    const [a, b] = [workers[0]!, workers[1]!]
    await a.query('BEGIN')
    await a.query('SELECT 1 FROM public.properties WHERE id = $1 FOR UPDATE', [p])
    await a.query('DELETE FROM public.property_video_uploads WHERE id = $1', [r.upload_id])
    await b.query('BEGIN')
    await b.query('SET LOCAL ROLE service_role')
    const pending = attempt(() => op(b, String(r.upload_id)))
    await sleep(300)
    await a.query('COMMIT')
    const res = await pending
    await b.query(res.ok ? 'COMMIT' : 'ROLLBACK')
    got[name] = res.ok ? String(res.value.outcome) : `ERR:${res.error.code}`
  }
  summary.vanished = got
  check('cancel / fail / finalize (reales) → not_found si la reserva se borró durante la espera',
    got.cancel === 'not_found' && got.fail === 'not_found' && got.finalize === 'not_found', got)
}

/**
 * Demostración determinística del deadlock que encontró la carrera del purge.
 * Corre FUERA de la ventana de "0 deadlocks": el orden viejo lo provoca a
 * propósito. A = purge (sentencias en el orden del cuerpo), B = cancel real.
 */
async function lockOrderDemo() {
  section('N · orden de locks del purge: demostración determinística (fuera de la ventana de 0 deadlocks)')
  const runOrder = async (propertyFirst: boolean) => {
    const t = await newTenant(propertyFirst ? 'ordnew' : 'ordold')
    const p = await newProperty(t)
    const r = await tx(main, 'service_role', () => reserve(main, t, p))
    const [a, b] = [workers[0]!, workers[1]!]
    await a.query('BEGIN')
    if (propertyFirst) await a.query('SELECT 1 FROM public.properties WHERE tenant_id = $1 ORDER BY id FOR UPDATE', [t])
    await a.query('DELETE FROM public.property_video_uploads WHERE tenant_id = $1', [t])
    await b.query('BEGIN')
    await b.query('SET LOCAL ROLE service_role')
    const bPending = attempt(() => cancel(b, t, String(r.upload_id)))
    await sleep(400)
    const aRes = await attempt(() => a.query('DELETE FROM public.properties WHERE tenant_id = $1', [t]))
    await a.query(aRes.ok ? 'COMMIT' : 'ROLLBACK')
    const bRes = await bPending
    await b.query(bRes.ok ? 'COMMIT' : 'ROLLBACK')
    return { purge: aRes.ok ? 'ok' : `ERR:${aRes.error.code}`, cancel: bRes.ok ? String(bRes.value.outcome) : `ERR:${bRes.error.code}` }
  }
  const before = await deadlockCounter()
  const oldOrder = await runOrder(false)
  await sleep(1500)
  const mid = await deadlockCounter()
  const newOrder = await runOrder(true)
  await sleep(1500)
  const after = await deadlockCounter()
  summary.lock_order_demo = { old: { ...oldOrder, deadlocks: mid - before }, new: { ...newOrder, deadlocks: after - mid } }
  check('orden viejo (reserva → propiedad): 1 deadlock (40P01) — el bug que encontró la carrera',
    mid - before === 1 && [oldOrder.purge, oldOrder.cancel].filter((x) => x === 'ERR:40P01').length === 1, summary.lock_order_demo)
  check('orden de la migración (propiedad → reserva): 0 deadlocks, purge ok, cancel → not_found',
    after - mid === 0 && newOrder.purge === 'ok' && newOrder.cancel === 'not_found', summary.lock_order_demo)
}

async function storageProbe() {
  section('I · probe de storage.objects (sólo lectura)')
  const { rows: [s] } = await main.query<Json>(
    `SELECT
       (SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'property-videos') AS objects_in_bucket,
       (SELECT data_type FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'objects' AND column_name = 'id') AS id_type,
       (SELECT column_default FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'objects' AND column_name = 'id') AS id_default,
       (SELECT data_type FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'objects' AND column_name = 'version') AS version_type,
       (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'storage' AND tablename = 'objects' AND indexname = 'idx_objects_current_version') AS current_version_index,
       has_table_privilege('postgres', 'storage.objects', 'SELECT') AS postgres_select,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'postgres') AS postgres_bypassrls,
       has_table_privilege('service_role', 'storage.objects', 'INSERT') AS service_role_insert`)
  summary.storage_probe = s
  check('storage.objects: id uuid con gen_random_uuid(), version text, índice del objeto vigente',
    s!.id_type === 'uuid' && /gen_random_uuid/.test(String(s!.id_default)) && s!.version_type === 'text' && s!.current_version_index === 1, s)
  check('el owner de las RPCs (postgres) puede leer storage.objects (SELECT + BYPASSRLS)', s!.postgres_select === true && s!.postgres_bypassrls === true, s)
  log(`  · objetos en el bucket property-videos del lab: ${String(s!.objects_in_bucket)} (identidad real por re-subida: PENDIENTE, requiere objeto Storage real)`)
}

async function cleanup() {
  section('Limpieza')
  for (const t of [...tenantIds]) {
    try { await main.query('SELECT public.admin_purge_tenant($1)', [t]) } catch (error) { nok(`purge de limpieza ${t}`, asPgError(error).message) }
  }
  if (syntheticUserId) await main.query('DELETE FROM auth.users WHERE id = $1', [syntheticUserId]).catch(() => undefined)
  if (harnessCreated) await main.query(`DROP SCHEMA ${H} CASCADE`)
  const { rows: [r] } = await main.query<{ tenants: number; uploads: number; users: number; harness: boolean }>(
    `SELECT (SELECT count(*)::int FROM public.tenants WHERE slug LIKE 'lab-2b1-%') AS tenants,
            (SELECT count(*)::int FROM public.property_video_uploads) AS uploads,
            (SELECT count(*)::int FROM auth.users WHERE email LIKE 'lab-2b1-%@example.invalid') AS users,
            EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '${H}') AS harness`)
  summary.residue = r
  check('sin residuos: 0 tenants lab-2b1, 0 reservas, 0 usuarios sintéticos, sin esquema harness',
    r!.tenants === 0 && r!.uploads === 0 && r!.users === 0 && !r!.harness, r)
}

async function deadlockCounter(): Promise<number> {
  await main.query('SELECT pg_stat_clear_snapshot()')
  const { rows: [r] } = await main.query<{ deadlocks: string }>(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)
  return Number(r!.deadlocks)
}

async function run() {
  log(HR)
  log('  Property Videos 2B1 — validación contra reservanex-lab')
  log(HR)
  main = await lab.connect({ applicationName: 'reservanex-lab-2b1-main' })
  for (let i = 0; i < WORKERS; i++) workers.push(await lab.connect({ applicationName: `reservanex-lab-2b1-w${i}` }))
  log(`  LAB GUARD — PASS · ${WORKERS + 1} conexiones reales separadas`)
  const pids = new Set<number>()
  for (const c of [main, ...workers]) pids.add((await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
  check(`${pids.size} backends Postgres distintos (uno por conexión)`, pids.size === WORKERS + 1)

  const deadlocksBefore = await deadlockCounter()
  let completed = false
  try {
    await createHarness()
    syntheticUserId = randomUUID()
    await main.query(`INSERT INTO auth.users (id, email, aud, role) VALUES ($1, $2, 'authenticated', 'authenticated')`,
      [syntheticUserId, `lab-2b1-${RUN}@example.invalid`])
    const tA = await newTenant('a')
    const tB = await newTenant('b')
    const pA = await newProperty(tA)

    await physicalSchema()
    await permissionBehavior(tA, pA)
    await reserveRpc(tA, tB)
    await cancelFailRpcs(tA, tB)
    await finalizeRpc(tA)
    await concurrency(tA, tB)
    await stress(tA)
    await createdBySetNull(tA)
    await purge()
    await vanishedWhileWaiting(tA)
    await storageProbe()
    completed = true
  } catch (error) {
    nok('excepción inesperada', asPgError(error).message)
  } finally {
    await sleep(1500)
    const deadlocksAfter = await deadlockCounter()
    summary.deadlocks = { pg_stat_database_delta: deadlocksAfter - deadlocksBefore, errors_40P01: deadlockErrors }
    section('N · deadlocks (toda la validación anterior)')
    check('0 deadlocks (pg_stat_database y errores 40P01)', deadlocksAfter - deadlocksBefore === 0 && deadlockErrors === 0, summary.deadlocks)
    if (completed) await lockOrderDemo().catch((error: unknown) => nok('demostración de orden de locks', asPgError(error).message))
    await cleanup().catch((error: unknown) => nok('limpieza', asPgError(error).message))
    await Promise.all([main, ...workers].map((c) => c.end().catch(() => undefined)))
  }

  log(`\n${HR}\n  ${passed} OK · ${failed} FALLOS\n${HR}`)
  log(`SUMMARY ${JSON.stringify(summary)}`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error: unknown) => {
  console.error(lab.redact(`validate-property-video-uploads falló: ${asPgError(error).message}`))
  process.exit(1)
})

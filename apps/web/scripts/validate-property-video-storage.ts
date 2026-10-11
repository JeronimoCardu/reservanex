/**
 * Property Videos 2B1.1 — Storage REAL del laboratorio contra las RPCs de 2B1.
 *
 *   pnpm --filter @orderflow/web validate:property-video-storage
 *
 * Sólo reservanex-lab. Pasa por los dos guards anti-producción (base y HTTP)
 * y TODA request HTTP sale por el fetch blindado de requireLabHttp, que
 * rechaza cualquier destino que no sea el origin del lab. La Secret key del
 * lab se usa sólo acá (server-side) y nunca se imprime.
 *
 * Qué prueba, con objetos reales subidos por la Storage API (nunca escribiendo
 * storage.objects a mano):
 *   C/D · identidad (id, version) de un objeto antes y después de sobrescribirlo,
 *         de un PUT y de borrarlo y volver a subirlo; y si la lectura posterior
 *         devuelve el contenido nuevo (API autenticada y signed URL).
 *   E/F · reserve (RPC) → signed upload al path reservado → identidad (RPC) →
 *         inspección por rangos HTTP con el inspector real → finalize REAL
 *         contra storage.objects; y finalize repetido (idempotente).
 *   G   · TOCTOU real: se inspecciona A, se reemplaza por B en el mismo path y
 *         finalize con la identidad de A → object_changed.
 *   H   · mismatches reales: tamaño, MIME, objeto inexistente, objeto borrado.
 *   I   · cleanup por Storage API + fixtures, SIEMPRE (finally).
 *
 * Los videos son MP4 sintéticos estructuralmente válidos (ftyp + moov/mvhd +
 * mdat, duración conocida) armados con src/testing/video-fixtures.ts: no hay
 * binarios en el repo ni ffmpeg en el entorno.
 */

import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import type pg from 'pg'
import { requireLabConnection, requireLabHttp } from './lab/lab-db'
import { concat, ftyp, mdat, moov, mvhdV0 } from '../src/testing/video-fixtures'
import type { RangeReader } from '../src/lib/property-videos/range-reader'
import { verifyStoredVideo } from '../src/lib/property-videos/validation'

const db = requireLabConnection()
const http = requireLabHttp()
const redact = (text: string) => http.redact(db.redact(text))
const RUN = Date.now().toString(36)
const BUCKET = 'property-videos'
const HR = '─'.repeat(78)

let passed = 0
let failed = 0
const summary: Record<string, unknown> = {}
function log(text: string) { console.log(redact(text)) }
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { log(`  ✓ ${label}`); passed++ }
  else { console.error(redact(`  ✗ ${label}${detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`}`)); failed++ }
}
function section(title: string) { log(`\n${title}`) }

type Json = Record<string, unknown>
type Identity = { id: string; version: string | null; size: number; mimetype: string }

const supabase = createClient<Database>(http.origin, http.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: http.fetch },
})
const storage = () => supabase.storage.from(BUCKET)
let main: pg.Client

// ── Videos sintéticos ────────────────────────────────────────────────────────

/** MP4 con moov al FINAL (fuerza una lectura por rango lejos del principio) o al principio. */
function video(seconds: number, mdatBytes: number, moovFirst: boolean): Uint8Array {
  const header = moov(mvhdV0(1000, seconds * 1000))
  return moovFirst ? concat(ftyp(), header, mdat(mdatBytes)) : concat(ftyp(), mdat(mdatBytes), header)
}
const VIDEO_A = video(17, 1_500_000, false)
const VIDEO_B = video(45, 1_200_000, true)
const VIDEO_C = video(29, 900_000, true)
const buf = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(buf(a), buf(b)) === 0

// ── Storage (siempre por la API) ─────────────────────────────────────────────

const uploadedPaths = new Set<string>()

async function upload(path: string, bytes: Uint8Array, opts: { upsert: boolean; contentType?: string }) {
  uploadedPaths.add(path)
  const { error } = await storage().upload(path, buf(bytes), { contentType: opts.contentType ?? 'video/mp4', upsert: opts.upsert })
  if (error) throw new Error(`upload: ${error.message}`)
}
async function signedUpload(path: string, bytes: Uint8Array, contentType = 'video/mp4') {
  uploadedPaths.add(path)
  const { data, error } = await storage().createSignedUploadUrl(path)
  if (error || !data) throw new Error(`createSignedUploadUrl: ${error?.message}`)
  const up = await storage().uploadToSignedUrl(path, data.token, buf(bytes), { contentType })
  if (up.error) throw new Error(`uploadToSignedUrl: ${up.error.message}`)
}
async function remove(paths: string[]) {
  const { data, error } = await storage().remove(paths)
  if (error) throw new Error(`remove: ${error.message}`)
  for (const path of paths) uploadedPaths.delete(path)
  return data?.length ?? 0
}

/** Lector por rangos contra el endpoint autenticado de Storage (como lo haría finalize server-side). */
function storageReader(path: string, size: number): RangeReader & { reads: number; statuses: number[] } {
  const url = `${http.origin}/storage/v1/object/authenticated/${BUCKET}/${path}`
  const reader = {
    size,
    reads: 0,
    statuses: [] as number[],
    async readRange(start: number, end: number): Promise<Uint8Array> {
      reader.reads++
      const res = await http.fetch(url, {
        headers: { apikey: http.secretKey, Authorization: `Bearer ${http.secretKey}`, Range: `bytes=${start}-${end - 1}` },
      })
      reader.statuses.push(res.status)
      if (res.status !== 206) throw new Error(`lectura por rango: HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
  }
  return reader
}
async function readHead(url: string, auth: boolean, bytes = 4096): Promise<Uint8Array> {
  const headers: Record<string, string> = { Range: `bytes=0-${bytes - 1}` }
  if (auth) Object.assign(headers, { apikey: http.secretKey, Authorization: `Bearer ${http.secretKey}` })
  const res = await http.fetch(url, { headers })
  if (res.status !== 206 && res.status !== 200) throw new Error(`lectura: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer()).subarray(0, bytes)
}
async function signedUrl(path: string): Promise<string> {
  const { data, error } = await storage().createSignedUrl(path, 120)
  if (error || !data) throw new Error(`createSignedUrl: ${error?.message}`)
  return data.signedUrl
}

// ── storage.objects por SQL (sólo lectura) ───────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
async function objectRows(path: string) {
  const { rows } = await main.query<{
    id: string; version: string | null; archived: boolean; delete_marker: boolean; size: string | null; mimetype: string | null
    metadata_keys: string[] | null; etag: boolean; cache_control: string | null; id_type: string
  }>(
    `SELECT o.id::text AS id, o.version, o.archived_at IS NOT NULL AS archived, o.is_delete_marker AS delete_marker,
            o.metadata ->> 'size' AS size, o.metadata ->> 'mimetype' AS mimetype,
            ARRAY(SELECT jsonb_object_keys(o.metadata) ORDER BY 1) AS metadata_keys,
            (o.metadata ? 'eTag') AS etag, o.metadata ->> 'cacheControl' AS cache_control,
            pg_typeof(o.id)::text AS id_type
     FROM storage.objects o WHERE o.bucket_id = $1 AND o.name = $2 ORDER BY o.created_at`, [BUCKET, path])
  return rows
}
async function currentObject(path: string) {
  const rows = await objectRows(path)
  const current = rows.filter((r) => !r.archived && !r.delete_marker)
  return { rows: rows.length, current: current.length, row: current[0] ?? null }
}

// ── RPCs (PostgREST con la Secret key → rol service_role) ────────────────────

async function rpc(fn: 'reserve_property_video_upload', args: Database['public']['Functions']['reserve_property_video_upload']['Args']): Promise<Json>
async function rpc(fn: 'get_property_video_upload_object', args: Database['public']['Functions']['get_property_video_upload_object']['Args']): Promise<Json>
async function rpc(fn: 'finalize_property_video_upload', args: Database['public']['Functions']['finalize_property_video_upload']['Args']): Promise<Json>
async function rpc(fn: 'cancel_property_video_upload', args: Database['public']['Functions']['cancel_property_video_upload']['Args']): Promise<Json>
async function rpc(fn: string, args: Record<string, unknown>): Promise<Json> {
  const { data, error } = await (supabase.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>)(fn, args)
  if (error) throw new Error(`rpc ${fn}: ${error.message}`)
  return data as Json
}

// ── Fixtures sintéticos (pg, como postgres) ──────────────────────────────────

let tenantId: string | null = null
let userId: string | null = null

async function newProperty(): Promise<string> {
  const id = randomUUID()
  await main.query(`INSERT INTO public.properties (id, tenant_id, title) VALUES ($1, $2, $3)`, [id, tenantId, `[LAB 2B1.1] ${RUN}`])
  return id
}
async function reserve(propertyId: string, mime = 'video/mp4') {
  const r = await rpc('reserve_property_video_upload', {
    p_tenant_id: tenantId!, p_property_id: propertyId, p_user_id: userId!, p_request_id: randomUUID(),
    p_mime_type: mime, p_expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
  })
  if (r.outcome !== 'reserved') throw new Error(`reserve: ${String(r.outcome)}`)
  return { uploadId: String(r.upload_id), path: String(r.storage_path) }
}
async function identity(uploadId: string): Promise<Identity | null> {
  const g = await rpc('get_property_video_upload_object', { p_tenant_id: tenantId!, p_upload_id: uploadId })
  return (g.object as Identity | null) ?? null
}
async function finalize(uploadId: string, id: Identity, sizeBytes: number, durationSeconds: number) {
  return rpc('finalize_property_video_upload', {
    p_tenant_id: tenantId!, p_upload_id: uploadId, p_object_id: id.id, p_object_version: id.version as string,
    p_size_bytes: sizeBytes, p_duration_seconds: durationSeconds,
  })
}
async function uploadStatus(uploadId: string) {
  const { rows } = await main.query<{ status: string; failure_reason: string | null }>(
    `SELECT status, failure_reason FROM public.property_video_uploads WHERE id = $1`, [uploadId])
  return rows[0]
}
async function videos(propertyId: string) {
  const { rows } = await main.query<Json>(`SELECT * FROM public.property_videos WHERE property_id = $1`, [propertyId])
  return rows
}
/** Inspección real por rangos HTTP; devuelve la duración entera (los fixtures usan segundos enteros). */
async function inspect(path: string, size: number, declaredMimeType = 'video/mp4') {
  const reader = storageReader(path, size)
  const result = await verifyStoredVideo({ reader, declaredMimeType })
  return { result, reads: reader.reads, statuses: reader.statuses }
}

// ── Secciones ────────────────────────────────────────────────────────────────

async function ttlCheck() {
  section('B · CHECK de TTL en la base del lab')
  const { rows } = await main.query<{ rel: string; conname: string; def: string }>(
    `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid IN ('public.property_video_uploads'::regclass, 'public.property_videos'::regclass) AND contype = 'c'`)
  const expiry = rows.find((r) => r.conname === 'property_video_uploads_expiry_check')
  const clocky = rows.filter((r) => /now\(\)|current_timestamp|clock_timestamp|statement_timestamp|transaction_timestamp|localtimestamp/i.test(r.def))
  summary.ttl_check = { expiry: expiry?.def, checks_con_reloj: clocky.map((r) => r.conname) }
  check('expiry_check usa sólo valores de la fila: expires_at > created_at AND expires_at <= created_at + 3 h',
    expiry?.def === "CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '03:00:00'::interval))))", expiry?.def)
  check('ningún CHECK de property_video_uploads / property_videos depende del reloj', clocky.length === 0, clocky)
}

async function identityUnderOverwrite() {
  section('C/D · identidad (id, version) de un objeto real: subida, overwrite, PUT, borrado + re-subida')
  const path = `${tenantId}/lab-2b1-1-identity-${RUN}.mp4`
  const snap = async (step: string) => {
    const o = await currentObject(path)
    return { step, rows_for_name: o.rows, current: o.current, id: o.row?.id ?? null, version: o.row?.version ?? null, size: o.row ? Number(o.row.size) : null, mimetype: o.row?.mimetype ?? null, row: o.row }
  }
  await upload(path, VIDEO_A, { upsert: false })
  const a = await snap('A: upload')
  const authUrl = `${http.origin}/storage/v1/object/authenticated/${BUCKET}/${path}`
  const s1 = await signedUrl(path)
  const headA = VIDEO_A.subarray(0, 4096)
  const beforeAuth = sameBytes(await readHead(authUrl, true), headA)
  const beforeSigned = sameBytes(await readHead(s1, false), headA)

  await upload(path, VIDEO_B, { upsert: true })
  const b = await snap('B: upload upsert=true (overwrite)')
  const headB = VIDEO_B.subarray(0, 4096)
  const fresh = {
    auth: sameBytes(await readHead(authUrl, true), headB),
    same_signed_url: sameBytes(await readHead(s1, false), headB),
    new_signed_url: sameBytes(await readHead(await signedUrl(path), false), headB),
  }

  const put = await storage().update(path, buf(VIDEO_C), { contentType: 'video/mp4' })
  if (put.error) throw new Error(`update: ${put.error.message}`)
  const c = await snap('C: update (PUT)')

  await remove([path])
  const gone = await snap('borrado')
  await upload(path, VIDEO_A, { upsert: false })
  const d = await snap('D: re-subida (mismo contenido que A)')

  const steps = [a, b, c, gone, d].map(({ row: _row, ...rest }) => rest)
  summary.identity = { steps, fresh_after_overwrite: fresh, read_before_overwrite: { auth: beforeAuth, signed: beforeSigned } }
  for (const s of steps) log(`  · ${s.step}: filas=${s.rows_for_name} vigentes=${s.current} id=${s.id ? 'uuid' : 'null'} version=${s.version === null ? 'null' : 'presente'} size=${s.size}`)

  check('A: el objeto existe en storage.objects; id es uuid y version NO es null',
    a.current === 1 && a.row?.id_type === 'uuid' && UUID.test(a.id ?? '') && a.version !== null, a.row)
  check('A: metadata real: size y mimetype del upload, eTag presente',
    a.size === VIDEO_A.length && a.mimetype === 'video/mp4' && a.row?.etag === true, a.row)
  const transitions = {
    overwrite: { id_changed: a.id !== b.id, version_changed: a.version !== b.version },
    put: { id_changed: b.id !== c.id, version_changed: b.version !== c.version },
    delete_reupload: { id_changed: c.id !== d.id, version_changed: c.version !== d.version },
  }
  summary.identity_transitions = transitions
  log(`  · overwrite: id ${transitions.overwrite.id_changed ? 'CAMBIA' : 'igual'}, version ${transitions.overwrite.version_changed ? 'CAMBIA' : 'igual'}`)
  log(`  · PUT: id ${transitions.put.id_changed ? 'CAMBIA' : 'igual'}, version ${transitions.put.version_changed ? 'CAMBIA' : 'igual'}`)
  log(`  · borrado + re-subida: id ${transitions.delete_reupload.id_changed ? 'CAMBIA' : 'igual'}, version ${transitions.delete_reupload.version_changed ? 'CAMBIA' : 'igual'}`)
  check('cada escritura cambia al menos uno de (id, version): la identidad compuesta distingue A de su reemplazo',
    Object.values(transitions).every((t) => t.id_changed || t.version_changed), transitions)
  check('la re-subida con EL MISMO contenido y tamaño también cambia la identidad (el tamaño solo no alcanzaría)',
    d.size === a.size && (a.id !== d.id || a.version !== d.version), { a: { id: a.id, version: a.version }, d: { id: d.id, version: d.version } })
  check('tras el overwrite queda 1 sola fila vigente para el path (sin versiones archivadas que confundan)', b.current === 1 && c.current === 1 && d.current === 1, steps)
  check('lectura después del overwrite (API autenticada) devuelve el contenido NUEVO', fresh.auth, fresh)
  log(`  · lectura después del overwrite por signed URL: misma URL → ${fresh.same_signed_url ? 'nuevo' : 'VIEJO (cache)'}, URL nueva → ${fresh.new_signed_url ? 'nuevo' : 'VIEJO (cache)'}`)
}

async function finalizeReal() {
  section('E/F · reserve → signed upload → identidad → inspección por rangos → finalize REAL')
  const property = await newProperty()
  const { uploadId, path } = await reserve(property)
  check('reserve por PostgREST (service_role) → path <tenant>/<upload_id>.mp4', path === `${tenantId}/${uploadId}.mp4`)
  await signedUpload(path, VIDEO_A)
  const id = await identity(uploadId)
  const sql = await currentObject(path)
  check('get_property_video_upload_object (real) devuelve la identidad que tiene storage.objects',
    id !== null && id.id === sql.row?.id && id.version === sql.row?.version && id.size === VIDEO_A.length && id.mimetype === 'video/mp4', { id, sqlId: sql.row?.id })
  const insp = await inspect(path, id!.size)
  summary.inspection = { ok: insp.result.ok, duration: insp.result.ok ? insp.result.durationSeconds : null, reads: insp.reads, statuses: insp.statuses }
  check('inspección real por rangos HTTP (moov al final): MP4, 17 s, ≥ 2 lecturas 206',
    insp.result.ok && insp.result.durationSeconds === 17 && insp.reads >= 2 && insp.statuses.every((s) => s === 206), summary.inspection)
  const duration = insp.result.ok ? Math.round(insp.result.durationSeconds) : 0

  const before = (await videos(property)).length
  const f1 = await finalize(uploadId, id!, id!.size, duration)
  const rows = await videos(property)
  const v = rows[0]
  check('finalize REAL contra storage.objects → completed, already=false', f1.outcome === 'completed' && f1.already === false, f1)
  check('reserva reserved → completed', (await uploadStatus(uploadId))?.status === 'completed')
  check('property_videos: exactamente 1 fila nueva', before === 0 && rows.length === 1, rows.length)
  check('fila: storage_path, tenant, property, mime, size y duración del objeto real, created_by del fixture',
    v?.id === f1.video_id && v?.storage_path === path && v?.tenant_id === tenantId && v?.property_id === property &&
    v?.mime_type === 'video/mp4' && String(v?.file_size_bytes) === String(VIDEO_A.length) && v?.duration_seconds === 17 && v?.created_by === userId, v)

  const f2 = await finalize(uploadId, id!, id!.size, duration)
  check('segundo finalize → completed, already=true, mismo video_id, ninguna fila adicional',
    f2.outcome === 'completed' && f2.already === true && f2.video_id === f1.video_id && (await videos(property)).length === 1, f2)
}

async function toctouReal() {
  section('G · TOCTOU real: inspeccionar A → reemplazar por B en el mismo path → finalize con la identidad de A')
  const property = await newProperty()
  const { uploadId, path } = await reserve(property)
  await signedUpload(path, VIDEO_A)
  const idA = await identity(uploadId)
  const inspA = await inspect(path, idA!.size)
  const durationA = inspA.result.ok ? inspA.result.durationSeconds : 0
  await upload(path, VIDEO_B, { upsert: true })
  const idB = await identity(uploadId)
  const changed = await finalize(uploadId, idA!, idA!.size, durationA)
  summary.toctou = { outcome: changed.outcome, id_changed: idA?.id !== idB?.id, version_changed: idA?.version !== idB?.version }
  check('finalize con la identidad de A (objeto ya reemplazado por B) → object_changed', changed.outcome === 'object_changed', changed)
  check('la reserva NO quedó completed (sigue reserved) y 0 property_videos nuevos',
    (await uploadStatus(uploadId))?.status === 'reserved' && (await videos(property)).length === 0)

  // Camino de reintento: la acción vuelve a inspeccionar y registra lo que REALMENTE está.
  const inspB = await inspect(path, idB!.size)
  const retry = await finalize(uploadId, idB!, idB!.size, inspB.result.ok ? inspB.result.durationSeconds : 0)
  const rows = await videos(property)
  check('reintento: re-inspección de B (45 s) + finalize con la identidad de B → completed con los datos de B',
    retry.outcome === 'completed' && rows.length === 1 && rows[0]?.duration_seconds === 45 && String(rows[0]?.file_size_bytes) === String(VIDEO_B.length),
    { retry, rows: rows.length })

  // Variante: borrado y re-subida del MISMO contenido (mismo tamaño) entre inspección y finalize.
  const p2 = await newProperty()
  const r2 = await reserve(p2)
  await signedUpload(r2.path, VIDEO_A)
  const id1 = await identity(r2.uploadId)
  await remove([r2.path])
  await upload(r2.path, VIDEO_A, { upsert: false })
  const id2 = await identity(r2.uploadId)
  const same = await finalize(r2.uploadId, id1!, id1!.size, 17)
  summary.toctou_reupload_same_bytes = { outcome: same.outcome, same_size: id1?.size === id2?.size, id_changed: id1?.id !== id2?.id, version_changed: id1?.version !== id2?.version }
  check('borrado + re-subida del mismo contenido (mismo tamaño) → object_changed, sin video',
    same.outcome === 'object_changed' && (await uploadStatus(r2.uploadId))?.status === 'reserved' && (await videos(p2)).length === 0, summary.toctou_reupload_same_bytes)
}

async function mismatches() {
  section('H · mismatches reales (ninguno inserta property_videos)')
  // Tamaño
  const p1 = await newProperty()
  const r1 = await reserve(p1)
  await signedUpload(r1.path, VIDEO_A)
  const id1 = await identity(r1.uploadId)
  const size = await finalize(r1.uploadId, id1!, id1!.size - 1, 17)
  check('tamaño esperado ≠ tamaño real → failed object_mismatch',
    size.outcome === 'failed' && size.reason === 'object_mismatch' && (await uploadStatus(r1.uploadId))?.status === 'failed' && (await videos(p1)).length === 0, size)

  // MIME: reservado como MP4, el objeto quedó guardado como video/webm.
  const p2 = await newProperty()
  const r2 = await reserve(p2)
  await signedUpload(r2.path, VIDEO_A, 'video/webm')
  const id2 = await identity(r2.uploadId)
  const mime = await finalize(r2.uploadId, id2!, id2!.size, 17)
  check('MIME del objeto (video/webm) ≠ MIME reservado (video/mp4) → failed object_mismatch',
    id2?.mimetype === 'video/webm' && mime.outcome === 'failed' && mime.reason === 'object_mismatch' && (await videos(p2)).length === 0, { mime, stored: id2?.mimetype })

  // Inexistente: nunca se subió nada.
  const p3 = await newProperty()
  const r3 = await reserve(p3)
  const id3 = await identity(r3.uploadId)
  const missing = await finalize(r3.uploadId, { id: randomUUID(), version: randomUUID(), size: 1000, mimetype: 'video/mp4' }, 1000, 17)
  check('objeto inexistente → get devuelve object null; finalize → object_missing; la reserva sigue reserved',
    id3 === null && missing.outcome === 'object_missing' && (await uploadStatus(r3.uploadId))?.status === 'reserved' && (await videos(p3)).length === 0, missing)
  const cancelled = await rpc('cancel_property_video_upload', { p_tenant_id: tenantId!, p_upload_id: r3.uploadId })
  check('esa reserva se puede cancelar después', cancelled.outcome === 'cancelled', cancelled)

  // Borrado después de inspeccionar.
  const p4 = await newProperty()
  const r4 = await reserve(p4)
  await signedUpload(r4.path, VIDEO_A)
  const id4 = await identity(r4.uploadId)
  await remove([r4.path])
  const deleted = await finalize(r4.uploadId, id4!, id4!.size, 17)
  check('objeto borrado entre inspección y finalize → object_missing, sin video',
    deleted.outcome === 'object_missing' && (await videos(p4)).length === 0, deleted)
}

async function cleanup(initialObjects: number) {
  section('I · cleanup (Storage API + fixtures)')
  const paths = [...uploadedPaths]
  let removed = 0
  if (paths.length > 0) {
    try { removed = await remove(paths) } catch (error) { check('remove por Storage API', false, error instanceof Error ? error.message : String(error)) }
  }
  let listed = -1
  if (tenantId) {
    const { data, error } = await storage().list(tenantId, { limit: 1000 })
    listed = error ? -1 : (data ?? []).length
  }
  const { rows: [st] } = await main.query<{ total: number; synthetic: number }>(
    `SELECT (SELECT count(*)::int FROM storage.objects WHERE bucket_id = $1) AS total,
            (SELECT count(*)::int FROM storage.objects WHERE bucket_id = $1 AND name LIKE $2) AS synthetic`,
    [BUCKET, `${tenantId ?? 'nada'}/%`])
  if (tenantId) await main.query('SELECT public.admin_purge_tenant($1)', [tenantId])
  if (userId) await main.query('DELETE FROM auth.users WHERE id = $1', [userId])
  const { rows: [left] } = await main.query<{ tenants: number; uploads: number; users: number }>(
    `SELECT (SELECT count(*)::int FROM public.tenants WHERE slug LIKE 'lab-2b11-%') AS tenants,
            (SELECT count(*)::int FROM public.property_video_uploads) AS uploads,
            (SELECT count(*)::int FROM auth.users WHERE email LIKE 'lab-2b11-%@example.invalid') AS users`)
  summary.cleanup = { paths_subidos: paths.length, borrados_por_api: removed, listado_api: listed, objetos_bucket: st!.total, objetos_bucket_inicial: initialObjects, sinteticos_restantes: st!.synthetic, ...left }
  check('todos los objetos temporales borrados por Storage API; el listado de la carpeta queda vacío',
    removed === paths.length && listed === 0 && st!.synthetic === 0, summary.cleanup)
  check('el bucket vuelve al estado inicial del lab', st!.total === initialObjects, summary.cleanup)
  check('0 fixtures DB (tenant, reservas, usuario)', left!.tenants === 0 && left!.uploads === 0 && left!.users === 0, left)
}

async function run() {
  log(HR)
  log('  Property Videos 2B1.1 — Storage REAL en reservanex-lab')
  log(HR)
  log(`  LAB GUARD — PASS · LAB HTTP GUARD — PASS (key ${http.keyKind})`)
  main = await db.connect({ applicationName: 'reservanex-lab-2b11' })
  const { rows: [init] } = await main.query<{ n: number }>(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = $1`, [BUCKET])
  const initialObjects = init!.n
  summary.objetos_bucket_inicial = initialObjects

  try {
    await ttlCheck()
    userId = randomUUID()
    await main.query(`INSERT INTO auth.users (id, email, aud, role) VALUES ($1, $2, 'authenticated', 'authenticated')`,
      [userId, `lab-2b11-${RUN}@example.invalid`])
    tenantId = randomUUID()
    await main.query(`INSERT INTO public.tenants (id, name, slug, status, max_properties) VALUES ($1, $2, $3, 'active', NULL)`,
      [tenantId, `[LAB 2B1.1] ${RUN}`, `lab-2b11-${RUN}`])

    await identityUnderOverwrite()
    await finalizeReal()
    await toctouReal()
    await mismatches()
  } catch (error) {
    check('excepción inesperada', false, error instanceof Error ? error.message : String(error))
  } finally {
    await cleanup(initialObjects).catch((error: unknown) => check('cleanup', false, error instanceof Error ? error.message : String(error)))
    await main.end().catch(() => undefined)
  }

  const byMethod = http.requests.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.method]: (acc[r.method] ?? 0) + 1 }), {})
  const statuses = http.requests.reduce<Record<string, number>>((acc, r) => ({ ...acc, [String(r.status)]: (acc[String(r.status)] ?? 0) + 1 }), {})
  summary.http = { total: http.requests.length, por_metodo: byMethod, por_status: statuses, todas_al_origin_del_lab: true }
  section('N · requests HTTP')
  log(`  · ${http.requests.length} requests, todas validadas contra el origin del lab antes de salir: ${JSON.stringify(byMethod)} · status ${JSON.stringify(statuses)}`)

  log(`\n${HR}\n  ${passed} OK · ${failed} FALLOS\n${HR}`)
  log(`SUMMARY ${JSON.stringify(summary)}`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error: unknown) => {
  console.error(redact(`validate-property-video-storage falló: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
})

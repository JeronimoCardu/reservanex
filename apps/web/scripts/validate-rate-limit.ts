/**
 * Rate limiting Fase 1B — validación FÍSICA de la migración
 * 20261006000001_rate_limit_buckets contra un Postgres LOCAL.
 *
 * Qué hace, en orden:
 *
 *   1. se asegura de que existan los roles anon / authenticated / service_role
 *      (en un Supabase local ya existen; en un Postgres pelado los crea NOLOGIN)
 *   2. aplica la migración DOS veces: tiene que ser idempotente
 *   3. si pg_cron está habilitado, exige exactamente UN job rate-limit-cleanup
 *   4. corre supabase/33-proof-rate-limit.sql — semántica de ventana,
 *      retry-after, input inválido, privilegios, RLS y limpieza (checks 1–14)
 *   5. CONCURRENCIA REAL (check 15): M procesos de la CLI, cada uno con SU
 *      conexión y SU transacción, esperan una barrera de tiempo común dentro de
 *      la base y llaman a rate_limit_hit a la vez. Con limit = N tienen que
 *      quedar exactamente N allowed. Si los procesos no llegaron juntos a la
 *      barrera, la prueba FALLA — no se acepta una corrida secuencial.
 *   6. borra los buckets que creó y el schema de prueba
 *
 * USO
 *
 *   RATE_LIMIT_VALIDATE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     pnpm --filter @orderflow/web validate:rate-limit
 *
 *   (54322 es el puerto de la base de `supabase start`; sirve cualquier
 *   Postgres local ≥ 14.)
 *
 * NO carga .env.local, NO usa --linked y se niega a correr contra cualquier
 * host que no sea loopback (ver rate-limit-local-target.ts). Ejecuta SQL con
 * la CLI de Supabase que ya está en el monorepo (`supabase db query --db-url`):
 * no hace falta ningún driver de Postgres.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { checkLocalDatabaseUrl } from './rate-limit-local-target'

const RAIZ      = path.resolve(__dirname, '..', '..', '..')
const MIGRACION = path.join(RAIZ, 'supabase', 'migrations', '20261006000001_rate_limit_buckets.sql')
const PRUEBA    = path.join(RAIZ, 'supabase', '33-proof-rate-limit.sql')

// Cantidad de checks que reporta 33-proof-rate-limit.sql. Si alguien borra un
// check de la prueba, esto lo detecta.
const CHECKS_ESPERADOS = 16

// Margen para que TODOS los procesos estén conectados y esperando antes de que
// se libere la barrera, y tolerancia de llegada a la barrera.
const BARRERA_MS        = 15_000
const SPREAD_MAXIMO_MS  = 1_000

const HR = '─'.repeat(78)
let fallas = 0
function ok(msg: string)                  { console.log(`  ✓ ${msg}`) }
function nok(msg: string, extra?: string) { fallas++; console.error(`  ✗ ${msg}${extra ? `\n      ${extra}` : ''}`) }

// ── Destino ──────────────────────────────────────────────────────────────────

const destino = checkLocalDatabaseUrl(process.env.RATE_LIMIT_VALIDATE_DB_URL)
if (!destino.ok) {
  console.error(`[validate-rate-limit] ${destino.reason}`)
  process.exit(1)
}
const DB_URL = process.env.RATE_LIMIT_VALIDATE_DB_URL!.trim()

// ── CLI de Supabase ──────────────────────────────────────────────────────────
//
// Se resuelve el binario nativo igual que lo hace node_modules/supabase
// (dist/supabase.js): así cada llamada concurrente es UN proceso, sin un Node
// intermedio.

function resolverBinario(): string {
  const override = process.env.SUPABASE_CLI_BINARY_OVERRIDE
  if (override) return override

  const wrapper = fs.realpathSync(path.join(RAIZ, 'node_modules', 'supabase', 'dist', 'supabase.js'))
  const req     = createRequire(wrapper)
  const base    = process.platform === 'win32' ? 'windows' : process.platform
  const ext     = process.platform === 'win32' ? '.exe' : ''

  for (const sufijo of [`${base}-${process.arch}`, `${base}-${process.arch}-musl`]) {
    try {
      const dir = path.dirname(req.resolve(`@supabase/cli-${sufijo}/package.json`))
      return path.join(dir, 'bin', `supabase${ext}`)
    } catch {
      // siguiente candidato
    }
  }
  throw new Error(`no encontré el binario de la CLI de Supabase para ${process.platform}-${process.arch}`)
}

const BIN = resolverBinario()

interface Corrida { code: number; output: string }

// La URL (con su contraseña) jamás se imprime: se tapa en toda salida.
function sanear(texto: string): string {
  return texto.split(DB_URL).join('<db-url>')
}

function cli(args: string[], timeoutMs = 180_000): Promise<Corrida> {
  return new Promise((resolve) => {
    execFile(BIN, args, { cwd: RAIZ, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, output: sanear(`${stdout}\n${stderr}`) })
    })
  })
}

const sql     = (query: string) => cli(['db', 'query', '--db-url', DB_URL, query])
const archivo = (file: string)  => cli(['db', 'query', '--db-url', DB_URL, '-f', file])

/** Ejecuta un bloque que termina en RAISE EXCEPTION '<marcador> ...' y devuelve el mensaje. */
async function marcador(query: string, prefijo: string): Promise<string | null> {
  const r = await sql(query)
  const m = r.output.match(new RegExp(`${prefijo}[^\\n"]*`))
  return m ? m[0] : null
}

function clave(): string {
  return `rl1.ip.${randomBytes(32).toString('base64url')}`
}

// ── Pasos ────────────────────────────────────────────────────────────────────

async function asegurarRoles() {
  const r = await sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon NOLOGIN;          END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role NOLOGIN;  END IF;
    END $$;`)
  if (r.code === 0) ok('roles anon / authenticated / service_role presentes')
  else nok('no se pudieron asegurar los roles', r.output.trim())
}

async function aplicarMigracion() {
  for (const vez of [1, 2]) {
    const r = await archivo(MIGRACION)
    if (r.code === 0) ok(`migración aplicada (vez ${vez} de 2)`)
    else return nok(`la migración falló en la aplicación ${vez}`, r.output.trim())
  }
}

async function verificarCron() {
  const m = await marcador(`
    DO $$
    DECLARE n INTEGER;
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname = ''rate-limit-cleanup''' INTO n;
        RAISE EXCEPTION 'CRON jobs=%', n;
      END IF;
      RAISE EXCEPTION 'CRON sin_pg_cron';
    END $$;`, 'CRON ')
  if (m && /^CRON jobs=1/.test(m)) ok('pg_cron: exactamente un job rate-limit-cleanup tras dos aplicaciones')
  else if (m && /^CRON sin_pg_cron/.test(m)) ok('pg_cron no está habilitado en esta base: el job se omite (esperado)')
  else nok('estado inesperado del job de limpieza', String(m))
}

async function correrPrueba() {
  const r = await archivo(PRUEBA)
  const m = r.output.match(/RESULTADO OK checks=(\d+)/)
  if (m && Number(m[1]) === CHECKS_ESPERADOS) {
    ok(`33-proof-rate-limit.sql: ${m[1]} checks OK (1–14, bloqueados, privilegios, RLS, limpieza)`)
  } else {
    const fallo = r.output.match(/FALLO [^\n"]*/)
    nok('33-proof-rate-limit.sql no terminó en RESULTADO OK', fallo ? fallo[0] : r.output.trim().slice(0, 2000))
  }
}

// Una sentencia por llamada: no se asume que `db query` acepte varias juntas.
async function prepararConcurrencia() {
  const pasos = [
    'CREATE SCHEMA IF NOT EXISTS rate_limit_proof;',
    `CREATE TABLE IF NOT EXISTS rate_limit_proof.results (
      run     TEXT        NOT NULL,
      call_no INTEGER     NOT NULL,
      allowed BOOLEAN,
      retry   INTEGER,
      err     TEXT,
      t_start TIMESTAMPTZ NOT NULL,
      t_end   TIMESTAMPTZ NOT NULL,
      pid     INTEGER     NOT NULL
    );`,
    // Una llamada: espera la barrera, llama a la RPC, registra el resultado y,
    // si p_hold > 0, mantiene la transacción (y sus locks) abierta ese tiempo.
    `CREATE OR REPLACE FUNCTION rate_limit_proof.hit_at(
      p_run TEXT, p_call INTEGER, p_t0 TIMESTAMPTZ, p_buckets JSONB, p_hold NUMERIC
    ) RETURNS VOID LANGUAGE plpgsql AS $fn$
    DECLARE
      r       JSONB;
      v_start TIMESTAMPTZ;
    BEGIN
      PERFORM pg_sleep(greatest(0, extract(epoch FROM (p_t0 - clock_timestamp()))));
      v_start := clock_timestamp();
      BEGIN
        r := public.rate_limit_hit(p_buckets);
        INSERT INTO rate_limit_proof.results
        VALUES (p_run, p_call, (r ->> 'allowed')::BOOLEAN, (r ->> 'retry_after_seconds')::INTEGER,
                NULL, v_start, clock_timestamp(), pg_backend_pid());
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO rate_limit_proof.results
        VALUES (p_run, p_call, NULL, NULL, SQLSTATE, v_start, clock_timestamp(), pg_backend_pid());
      END;
      IF p_hold > 0 THEN PERFORM pg_sleep(p_hold); END IF;
    END
    $fn$;`,
  ]
  for (const paso of pasos) {
    const r = await sql(paso)
    if (r.code !== 0) {
      nok('no se pudo preparar el schema de prueba de concurrencia', r.output.trim())
      return false
    }
  }
  return true
}

interface Escenario {
  nombre:    string
  llamadas:  number
  hold:      number
  buckets:   { key: string; limit: number }[]
  allowed:   number
  mezclar:   boolean   // cada llamada manda los buckets en un orden distinto
}

// Barrera: nunca a menos de 2 min de la medianoche UTC, para que las ventanas
// de 24 h de la prueba no se partan en dos.
function barrera(): Date {
  let t0 = Date.now() + BARRERA_MS
  const hastaMedianoche = 86_400_000 - (t0 % 86_400_000)
  if (hastaMedianoche < 120_000) t0 += hastaMedianoche + 1_000
  return new Date(t0)
}

function mezclar<T>(xs: T[]): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

async function escenario(e: Escenario, claves: string[]) {
  const run = randomBytes(8).toString('hex')
  const t0  = barrera().toISOString()
  for (const b of e.buckets) claves.push(b.key)

  const llamadas = Array.from({ length: e.llamadas }, (_, i) => {
    const orden   = e.mezclar ? mezclar(e.buckets) : e.buckets
    const buckets = JSON.stringify(orden.map((b) => ({ bucket_key: b.key, window_seconds: 86_400, limit: b.limit })))
    return sql(`SELECT rate_limit_proof.hit_at('${run}', ${i}, '${t0}'::timestamptz, '${buckets}'::jsonb, ${e.hold});`)
  })

  const salidas = await Promise.all(llamadas)
  const caidas  = salidas.filter((s) => s.code !== 0)
  if (caidas.length > 0) {
    return nok(`${e.nombre}: ${caidas.length} de ${e.llamadas} procesos fallaron`, caidas[0]!.output.trim().slice(0, 1000))
  }

  const keys = e.buckets.map((b) => `'${b.key}'`).join(', ')
  const resumen = await marcador(`
    DO $$
    DECLARE
      a INTEGER; b INTEGER; err INTEGER; n INTEGER;
      spread NUMERIC; overlap NUMERIC; hits TEXT;
    BEGIN
      SELECT count(*) FILTER (WHERE allowed),
             count(*) FILTER (WHERE allowed = false),
             count(*) FILTER (WHERE err IS NOT NULL),
             count(*),
             round(extract(epoch FROM (max(t_start) - min(t_start))) * 1000),
             round(extract(epoch FROM (min(t_end) + make_interval(secs => ${e.hold}) - max(t_start))) * 1000)
      INTO a, b, err, n, spread, overlap
      FROM rate_limit_proof.results WHERE run = '${run}';

      SELECT string_agg(hit_count::TEXT, ',' ORDER BY bucket_key COLLATE "C") INTO hits
      FROM public.rate_limit_buckets WHERE bucket_key IN (${keys}) AND window_seconds = 86400;

      RAISE EXCEPTION 'RESUMEN allowed=% blocked=% errors=% n=% spread_ms=% overlap_ms=% hits=%',
        a, b, err, n, spread, overlap, hits;
    END $$;`, 'RESUMEN ')

  const m = resumen?.match(/allowed=(\d+) blocked=(\d+) errors=(\d+) n=(\d+) spread_ms=(-?\d+) overlap_ms=(-?\d+) hits=([\d,]+)/)
  if (!m) return nok(`${e.nombre}: no pude leer el resumen`, String(resumen))

  const [allowed = 0, blocked = 0, errors = 0, n = 0, spread = 0, overlap = 0] = m.slice(1, 7).map(Number)
  const hits = m[7] ?? ''
  const detalle = `allowed=${allowed} blocked=${blocked} errors=${errors} n=${n} llegada a la barrera en ${spread} ms, hits=${hits}`

  // Sin concurrencia real la prueba no vale: no se acepta como OK.
  if (spread > SPREAD_MAXIMO_MS) {
    return nok(`${e.nombre}: los procesos NO llegaron juntos a la barrera (${spread} ms > ${SPREAD_MAXIMO_MS} ms); la prueba no demuestra concurrencia`, detalle)
  }
  if (e.hold > 0 && overlap <= 0) {
    return nok(`${e.nombre}: las transacciones no estuvieron abiertas a la vez (overlap ${overlap} ms)`, detalle)
  }

  const hitsEsperados = e.buckets.map(() => String(e.llamadas)).join(',')
  if (n === e.llamadas && errors === 0 && allowed === e.allowed && blocked === e.llamadas - e.allowed && hits === hitsEsperados) {
    ok(`${e.nombre}: ${detalle}${e.hold > 0 ? `, todas abiertas a la vez durante ${overlap} ms` : ''}`)
  } else {
    nok(`${e.nombre}: se esperaban exactamente ${e.allowed} allowed, 0 errores y hits=${hitsEsperados}`, detalle)
  }
}

async function limpiar(claves: string[]) {
  const lista = claves.map((k) => `'${k}'`).join(', ')
  const pasos = [
    ...(claves.length > 0 ? [`DELETE FROM public.rate_limit_buckets WHERE bucket_key IN (${lista});`] : []),
    'DROP SCHEMA IF EXISTS rate_limit_proof CASCADE;',
  ]
  for (const paso of pasos) {
    const r = await sql(paso)
    if (r.code !== 0) return nok('la limpieza falló', r.output.trim())
  }
  ok('limpieza: buckets de prueba y schema rate_limit_proof borrados')
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(HR)
  console.log('  Rate limiting Fase 1B — validación física de rate_limit_hit')
  console.log(`  destino: ${destino.ok ? destino.label : ''} (local)`)
  console.log(HR)

  await asegurarRoles()
  await aplicarMigracion()
  if (fallas > 0) return

  await verificarCron()
  await correrPrueba()

  const claves: string[] = []
  try {
    if (!(await prepararConcurrencia())) return

    console.log(`\n  Concurrencia real (barrera a +${BARRERA_MS / 1000} s, procesos separados):`)

    await escenario({
      nombre: '15a. 30 llamadas simultáneas, limit 5, autocommit', llamadas: 30, hold: 0,
      buckets: [{ key: clave(), limit: 5 }], allowed: 5, mezclar: false,
    }, claves)

    await escenario({
      nombre: '15b. 30 llamadas simultáneas, limit 5, transacciones abiertas 0,4 s', llamadas: 30, hold: 0.4,
      buckets: [{ key: clave(), limit: 5 }], allowed: 5, mezclar: false,
    }, claves)

    // Tres buckets en orden distinto en cada llamada, con las transacciones
    // abiertas: sin el orden determinístico de locks esto produce deadlocks
    // (40P01). Como todas lockean primero el mismo bucket, quedan en fila y la
    // k-ésima ve hit_count = k en los tres: allowed = el menor límite.
    await escenario({
      nombre: '15c. 20 llamadas multi-bucket en orden mezclado, sin deadlocks', llamadas: 20, hold: 0.2,
      buckets: [{ key: clave(), limit: 4 }, { key: clave(), limit: 7 }, { key: clave(), limit: 50 }],
      allowed: 4, mezclar: true,
    }, claves)
  } finally {
    await limpiar(claves)
  }
}

main()
  .catch((err) => {
    fallas++
    console.error(sanear(err instanceof Error ? err.message : String(err)))
  })
  .finally(() => {
    console.log(`\n${HR}\n  ${fallas === 0 ? 'OK — rate limiting validado físicamente' : `${fallas} falla(s)`}\n${HR}`)
    process.exit(fallas > 0 ? 1 : 0)
  })

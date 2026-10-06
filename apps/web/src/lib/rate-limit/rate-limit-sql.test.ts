import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { RATE_LIMIT_KEY_PATTERN } from './keys'
import {
  RATE_LIMIT_MAX_BUCKETS_PER_CALL,
  RATE_LIMIT_MAX_LIMIT,
  RATE_LIMIT_MAX_WINDOW_SECONDS,
} from './limiter'
import {
  FORM_INTENT_GROUPS,
  PROPOSED_CONTACT_PER_IP_LIMITS,
  PROPOSED_FORM_GROUP_LIMITS,
  PROPOSED_FORMS_PER_IP_LIMITS,
} from './policy'

// Paridad entre el adapter y la migración de rate_limit_buckets. No reemplaza
// la validación física (supabase/33-proof-rate-limit.sql y
// scripts/validate-rate-limit.ts, que corren contra un Postgres real): fija
// que lo que el código TS supone de la base sea lo que la migración declara, y
// que las barreras de seguridad sigan escritas.

const DIR  = import.meta.dirname
const RAIZ = path.resolve(DIR, '..', '..', '..', '..', '..')
const MIGRACION = 'supabase/migrations/20261006000001_rate_limit_buckets.sql'
const SQL = fs.readFileSync(path.join(RAIZ, MIGRACION), 'utf8')

// Sólo el código, sin comentarios de línea: lo que importa es lo que ejecuta.
const CODIGO = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

function constante(nombre: string): number {
  const m = CODIGO.match(new RegExp(`${nombre}\\s+CONSTANT\\s+INTEGER\\s*:=\\s*(\\d+)`))
  if (!m) throw new Error(`no encontré ${nombre} en la migración`)
  return Number(m[1])
}

describe('migración rate_limit_buckets — paridad con el adapter', () => {
  it('el formato de clave es el mismo en TS, en el CHECK y en la RPC', () => {
    const literal = `'${RATE_LIMIT_KEY_PATTERN.source}'`
    expect(CODIGO).toContain(`CHECK (bucket_key ~ ${literal})`)
    expect(CODIGO).toContain(`c_key_format  CONSTANT TEXT    := ${literal}`)
  })

  it('los topes de la RPC son los del adapter', () => {
    expect(constante('c_max_buckets')).toBe(RATE_LIMIT_MAX_BUCKETS_PER_CALL)
    expect(constante('c_max_window')).toBe(RATE_LIMIT_MAX_WINDOW_SECONDS)
    expect(constante('c_max_limit')).toBe(RATE_LIMIT_MAX_LIMIT)
    expect(CODIGO).toContain(`CHECK (window_seconds BETWEEN 1 AND ${RATE_LIMIT_MAX_WINDOW_SECONDS})`)
  })

  it('toda la política propuesta entra en los rangos que acepta la RPC', () => {
    const todas = [
      ...FORM_INTENT_GROUPS.flatMap((g) => PROPOSED_FORM_GROUP_LIMITS[g]),
      ...PROPOSED_FORMS_PER_IP_LIMITS,
      ...PROPOSED_CONTACT_PER_IP_LIMITS,
    ]
    for (const l of todas) {
      expect(l.windowSeconds).toBeLessThanOrEqual(RATE_LIMIT_MAX_WINDOW_SECONDS)
      expect(l.max).toBeLessThanOrEqual(RATE_LIMIT_MAX_LIMIT)
    }
  })
})

describe('migración rate_limit_buckets — estructura y seguridad', () => {
  it('tabla NORMAL (no UNLOGGED) con PK (bucket_key, window_seconds, window_start)', () => {
    expect(CODIGO).not.toMatch(/UNLOGGED/i)
    expect(CODIGO).toMatch(/PRIMARY KEY \(bucket_key, window_seconds, window_start\)/)
  })

  it('RLS habilitado, sin policies, y sin privilegios de tabla para ningún rol cliente', () => {
    expect(CODIGO).toContain('ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;')
    expect(CODIGO).not.toMatch(/CREATE POLICY/i)
    for (const rol of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
      expect(CODIGO).toContain(`REVOKE ALL ON TABLE public.rate_limit_buckets FROM ${rol};`)
    }
    expect(CODIGO).not.toMatch(/GRANT [^;]* ON TABLE public\.rate_limit_buckets/i)
  })

  it('rate_limit_hit: SECURITY DEFINER, search_path vacío, EXECUTE sólo para service_role', () => {
    expect(CODIGO).toMatch(
      /CREATE OR REPLACE FUNCTION public\.rate_limit_hit\(p_buckets JSONB\)\s+RETURNS JSONB\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/,
    )
    for (const rol of ['PUBLIC', 'anon', 'authenticated']) {
      expect(CODIGO).toContain(`REVOKE ALL ON FUNCTION public.rate_limit_hit(JSONB) FROM ${rol};`)
    }
    const grants = [...CODIGO.matchAll(/GRANT [^;]+;/g)].map((m) => m[0])
    expect(grants).toEqual(['GRANT EXECUTE ON FUNCTION public.rate_limit_hit(JSONB) TO service_role;'])
  })

  it('rate_limit_cleanup: SECURITY INVOKER y sin EXECUTE para ningún rol cliente', () => {
    expect(CODIGO).toMatch(/FUNCTION public\.rate_limit_cleanup\([\s\S]*?SECURITY INVOKER\s+SET search_path = ''/)
    for (const rol of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
      expect(CODIGO).toContain(`REVOKE ALL ON FUNCTION public.rate_limit_cleanup(INTEGER, INTEGER) FROM ${rol};`)
    }
  })

  it('incremento atómico con ON CONFLICT y locks en orden determinístico', () => {
    expect(CODIGO).toMatch(/ON CONFLICT \(bucket_key, window_seconds, window_start\)\s+DO UPDATE SET hit_count\s+= b\.hit_count \+ 1/)
    expect(CODIGO).toMatch(/ORDER BY \(t\.e ->> 'bucket_key'\) COLLATE "C", \(\(t\.e ->> 'window_seconds'\)::NUMERIC\)/)
    // Ninguna lectura previa del contador: sin SELECT ... FROM la tabla en la RPC.
    const rpc = CODIGO.slice(CODIGO.indexOf('FUNCTION public.rate_limit_hit'), CODIGO.indexOf('FUNCTION public.rate_limit_cleanup'))
    expect(rpc).not.toMatch(/FROM public\.rate_limit_buckets/)
  })

  it('ventana fija calculada con UN reloj de la base, no con timestamps de afuera', () => {
    expect(CODIGO).toContain('v_now         TIMESTAMPTZ := clock_timestamp();')
    expect(CODIGO).toContain('floor(v_now_epoch / v_bucket.window_seconds)::BIGINT * v_bucket.window_seconds')
    expect((CODIGO.match(/clock_timestamp\(\)/g) ?? []).length).toBe(2) // una por función
  })

  it('el job de pg_cron es condicional e idempotente por nombre', () => {
    expect(CODIGO).toMatch(/IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_extension WHERE extname = 'pg_cron'\)/)
    const unschedule = CODIGO.indexOf("WHERE jobname = 'rate-limit-cleanup'")
    const schedule = CODIGO.indexOf("'rate-limit-cleanup',")
    expect(unschedule).toBeGreaterThan(0)
    expect(schedule).toBeGreaterThan(unschedule)
  })
})

-- =============================================================================
-- Migration: 20261006000001_rate_limit_buckets
-- =============================================================================
--
-- Rate limiting — Fase 1B: primitiva Postgres para limitar los POST públicos
-- (/api/public/forms y /api/contact). Esta migración NO conecta nada: las
-- rutas siguen sin limitar hasta que el adapter
-- (apps/web/src/lib/rate-limit/limiter.ts) se integre en una fase posterior.
--
-- Tres piezas:
--
--   1. rate_limit_buckets — un contador por (clave opaca, ventana, inicio de
--      ventana). La clave es HMAC-SHA256 calculado en la app: acá nunca llega
--      una IP ni un slug crudos, sólo 'rl1.<scope>.<43 chars base64url>'.
--
--   2. rate_limit_hit(p_buckets) — la ÚNICA puerta de escritura. Evalúa todos
--      los buckets de un request en una sola llamada atómica. SECURITY DEFINER,
--      ejecutable únicamente por service_role.
--
--   3. rate_limit_cleanup() — borra buckets cuya ventana terminó hace más de
--      una gracia. pg_cron la corre si la extensión está habilitada.
--
-- SEMÁNTICA (fixed window)
--
--   · inicio de ventana = floor(epoch(now) / window_seconds) * window_seconds,
--     con "now" leído UNA vez del reloj de la base al entrar a la función. La
--     app no manda timestamps.
--   · cada llamada incrementa TODOS sus buckets, también cuando termina
--     bloqueada: el contador mide intentos, no éxitos, y eso es lo que permite
--     ver el abuso. Como la ventana es fija, incrementar no la extiende: el
--     bloqueo termina cuando termina la ventana, intente quien intente.
--   · allowed = ningún bucket supera su límite después de incrementar.
--   · retry_after_seconds = el MAYOR tiempo restante entre las ventanas
--     excedidas, entero >= 1 (0 cuando allowed).
--
-- CONCURRENCIA
--
--   INSERT ... ON CONFLICT DO UPDATE toma el lock de fila del bucket y lo
--   mantiene hasta el commit. Dos llamadas sobre el mismo bucket se
--   serializan: la segunda espera, relee la versión ya commiteada y la
--   incrementa. Cada llamada recibe un hit_count distinto (1, 2, 3, ...), así
--   que con limit = N exactamente N quedan allowed, sin importar cuántas
--   lleguen juntas. No hay SELECT-then-UPDATE ni lectura previa.
--
--   Con varios buckets por llamada, las filas se lockean SIEMPRE en el mismo
--   orden — (bucket_key COLLATE "C", window_seconds) — así que dos llamadas no
--   pueden esperarse en ciclo: no hay deadlock posible entre llamadas a esta
--   función. Requiere READ COMMITTED (el default de PostgREST); en
--   REPEATABLE READ / SERIALIZABLE una actualización concurrente termina en
--   error 40001, que el adapter trata como fallo del backend.
--
-- Convenciones del repo seguidas: RLS en la misma migración que el CREATE
-- TABLE; REVOKE explícito a PUBLIC, anon y authenticated + GRANT sólo a
-- service_role (patrón de 20260908000004); taxonomías como TEXT + CHECK; jobs
-- de pg_cron idempotentes por nombre (patrón de 20260627000000).
--
-- La tabla no tiene tenant_id (la clave es opaca), así que admin_purge_tenant()
-- no necesita conocerla: sus filas vencen solas.

BEGIN;

-- ── 1. Tabla ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key     TEXT        NOT NULL,
  window_seconds INTEGER     NOT NULL,
  window_start   TIMESTAMPTZ NOT NULL,
  hit_count      BIGINT      NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,

  -- La ventana es parte de la identidad del bucket: la de 10 min y la de 24 h
  -- de una misma clave son filas distintas y nunca colisionan.
  CONSTRAINT rate_limit_buckets_pkey
    PRIMARY KEY (bucket_key, window_seconds, window_start),

  -- Mismo formato que produce buildRateLimitKey (apps/web/src/lib/rate-limit/
  -- keys.ts). Si alguien intentara guardar una IP o un slug acá, no entra.
  CONSTRAINT rate_limit_buckets_key_format_check
    CHECK (bucket_key ~ '^rl1\.(ip|ip_tenant|ip_endpoint|ip_tenant_group)\.[A-Za-z0-9_-]{43}$'),

  CONSTRAINT rate_limit_buckets_window_seconds_check
    CHECK (window_seconds BETWEEN 1 AND 86400),

  CONSTRAINT rate_limit_buckets_hit_count_check
    CHECK (hit_count >= 1)
);

-- La limpieza filtra por inicio de ventana.
CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_start_idx
  ON public.rate_limit_buckets (window_start);

COMMENT ON TABLE public.rate_limit_buckets IS
  'Rate limiting Fase 1B — contadores fixed-window por clave opaca (HMAC). '
  'Se escribe SOLO vía rate_limit_hit() y se limpia vía rate_limit_cleanup(). '
  'Sin acceso para anon, authenticated ni service_role.';

COMMENT ON COLUMN public.rate_limit_buckets.bucket_key IS
  'rl1.<scope>.<HMAC-SHA256 base64url>. Nunca contiene IP, slug ni payload.';

COMMENT ON COLUMN public.rate_limit_buckets.hit_count IS
  'Intentos dentro de la ventana, INCLUIDOS los bloqueados.';

-- ── 2. Acceso a la tabla ─────────────────────────────────────────────────────
--
-- RLS habilitado y SIN policies: ningún rol cliente ve ni escribe filas. Además
-- se revocan los privilegios de tabla — no se depende sólo de RLS. Ni siquiera
-- service_role (que saltea RLS) tiene acceso directo: todo pasa por la RPC.

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM anon;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM authenticated;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM service_role;

-- ── 3. rate_limit_hit ────────────────────────────────────────────────────────
--
-- p_buckets: array JSON de 1 a 8 objetos con EXACTAMENTE estas claves:
--   { "bucket_key": text, "window_seconds": int 1..86400, "limit": int 1..10000 }
-- Sin duplicados de (bucket_key, window_seconds). Cualquier otra cosa es un
-- error controlado 22023 (invalid_parameter_value) y no incrementa nada.
--
-- Devuelve: { "allowed": boolean, "retry_after_seconds": integer }

CREATE OR REPLACE FUNCTION public.rate_limit_hit(p_buckets JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_buckets CONSTANT INTEGER := 8;
  c_max_window  CONSTANT INTEGER := 86400;
  c_max_limit   CONSTANT INTEGER := 10000;
  c_key_format  CONSTANT TEXT    := '^rl1\.(ip|ip_tenant|ip_endpoint|ip_tenant_group)\.[A-Za-z0-9_-]{43}$';

  -- Un único "now" por llamada, del reloj de la base.
  v_now         TIMESTAMPTZ := clock_timestamp();
  v_now_epoch   NUMERIC;

  v_count       INTEGER;
  v_distinct    INTEGER;
  v_elem        JSONB;
  v_window      NUMERIC;
  v_limit       NUMERIC;
  v_bucket      RECORD;
  v_start_epoch BIGINT;
  v_hits        BIGINT;
  v_remaining   INTEGER;
  v_allowed     BOOLEAN := true;
  v_retry_after INTEGER := 0;
BEGIN
  v_now_epoch := extract(epoch FROM v_now);

  -- ── Validación: nada se escribe hasta que TODO el input es válido ─────────

  IF p_buckets IS NULL OR jsonb_typeof(p_buckets) <> 'array' THEN
    RAISE EXCEPTION 'rate_limit_hit: p_buckets tiene que ser un array'
      USING ERRCODE = '22023';
  END IF;

  v_count := jsonb_array_length(p_buckets);
  IF v_count < 1 OR v_count > c_max_buckets THEN
    RAISE EXCEPTION 'rate_limit_hit: se esperan entre 1 y % buckets, llegaron %', c_max_buckets, v_count
      USING ERRCODE = '22023';
  END IF;

  FOR v_elem IN SELECT t.e FROM jsonb_array_elements(p_buckets) AS t(e) LOOP
    IF jsonb_typeof(v_elem) <> 'object' THEN
      RAISE EXCEPTION 'rate_limit_hit: cada bucket tiene que ser un objeto'
        USING ERRCODE = '22023';
    END IF;

    IF NOT (v_elem ?& ARRAY['bucket_key', 'window_seconds', 'limit'])
       OR (SELECT count(*) FROM jsonb_object_keys(v_elem)) <> 3 THEN
      RAISE EXCEPTION 'rate_limit_hit: cada bucket lleva exactamente bucket_key, window_seconds y limit'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_elem -> 'bucket_key') <> 'string'
       OR NOT ((v_elem ->> 'bucket_key') ~ c_key_format) THEN
      RAISE EXCEPTION 'rate_limit_hit: bucket_key con formato inesperado'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_elem -> 'window_seconds') <> 'number'
       OR jsonb_typeof(v_elem -> 'limit') <> 'number' THEN
      RAISE EXCEPTION 'rate_limit_hit: window_seconds y limit tienen que ser números'
        USING ERRCODE = '22023';
    END IF;

    v_window := (v_elem ->> 'window_seconds')::NUMERIC;
    v_limit  := (v_elem ->> 'limit')::NUMERIC;

    IF v_window <> trunc(v_window) OR v_window < 1 OR v_window > c_max_window THEN
      RAISE EXCEPTION 'rate_limit_hit: window_seconds tiene que ser un entero entre 1 y %', c_max_window
        USING ERRCODE = '22023';
    END IF;

    IF v_limit <> trunc(v_limit) OR v_limit < 1 OR v_limit > c_max_limit THEN
      RAISE EXCEPTION 'rate_limit_hit: limit tiene que ser un entero entre 1 y %', c_max_limit
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_distinct
  FROM (
    SELECT DISTINCT t.e ->> 'bucket_key'                 AS bucket_key,
                    (t.e ->> 'window_seconds')::NUMERIC AS window_seconds
    FROM jsonb_array_elements(p_buckets) AS t(e)
  ) AS d;

  IF v_distinct <> v_count THEN
    RAISE EXCEPTION 'rate_limit_hit: bucket repetido (misma bucket_key y window_seconds)'
      USING ERRCODE = '22023';
  END IF;

  -- ── Incremento atómico, en orden determinístico ───────────────────────────
  --
  -- El ORDER BY fija el orden en que se toman los locks de fila. Todas las
  -- llamadas usan el mismo orden, así que no pueden formar un ciclo de espera.

  FOR v_bucket IN
    SELECT t.e ->> 'bucket_key'                          AS bucket_key,
           ((t.e ->> 'window_seconds')::NUMERIC)::INTEGER AS window_seconds,
           ((t.e ->> 'limit')::NUMERIC)::INTEGER          AS bucket_limit
    FROM jsonb_array_elements(p_buckets) AS t(e)
    ORDER BY (t.e ->> 'bucket_key') COLLATE "C", ((t.e ->> 'window_seconds')::NUMERIC)
  LOOP
    v_start_epoch := floor(v_now_epoch / v_bucket.window_seconds)::BIGINT * v_bucket.window_seconds;

    INSERT INTO public.rate_limit_buckets AS b
      (bucket_key, window_seconds, window_start, hit_count, updated_at)
    VALUES
      (v_bucket.bucket_key, v_bucket.window_seconds, to_timestamp(v_start_epoch), 1, v_now)
    ON CONFLICT (bucket_key, window_seconds, window_start)
    DO UPDATE SET hit_count  = b.hit_count + 1,
                  updated_at = EXCLUDED.updated_at
    RETURNING hit_count INTO v_hits;

    IF v_hits > v_bucket.bucket_limit THEN
      v_allowed := false;
      -- Lo que falta para que termine ESTA ventana; nunca menos de 1.
      v_remaining   := ceil((v_start_epoch + v_bucket.window_seconds) - v_now_epoch)::INTEGER;
      v_retry_after := greatest(v_retry_after, v_remaining, 1);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'allowed',             v_allowed,
    'retry_after_seconds', CASE WHEN v_allowed THEN 0 ELSE v_retry_after END
  );
END;
$$;

COMMENT ON FUNCTION public.rate_limit_hit(JSONB) IS
  'Rate limiting Fase 1B — incrementa atómicamente 1..8 buckets fixed-window y '
  'devuelve {allowed, retry_after_seconds}. Sólo service_role.';

-- PUBLIC tiene EXECUTE por defecto en Postgres y Supabase además se lo da a
-- anon y authenticated por default privileges: se revoca explícitamente a los
-- tres y se concede sólo a service_role.
REVOKE ALL ON FUNCTION public.rate_limit_hit(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rate_limit_hit(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.rate_limit_hit(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(JSONB) TO service_role;

-- ── 4. rate_limit_cleanup ────────────────────────────────────────────────────
--
-- Borra SÓLO buckets cuya ventana terminó hace al menos p_grace_seconds. Un
-- bucket activo (now < fin de ventana) nunca cumple la condición, sea cual sea
-- la gracia. Borra como mucho p_max_rows por corrida para acotar el trabajo de
-- cada ejecución; lo que quede lo levanta la siguiente.
--
-- SECURITY INVOKER a propósito: sólo puede borrar quien ya tiene DELETE sobre
-- la tabla (el owner, que es quien corre el job de pg_cron). Nadie más lo
-- tiene, así que no hay nada que conceder.

CREATE OR REPLACE FUNCTION public.rate_limit_cleanup(
  p_grace_seconds INTEGER DEFAULT 3600,
  p_max_rows      INTEGER DEFAULT 50000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_now     TIMESTAMPTZ := clock_timestamp();
  v_deleted INTEGER;
BEGIN
  IF p_grace_seconds IS NULL OR p_grace_seconds < 0 OR p_grace_seconds > 604800 THEN
    RAISE EXCEPTION 'rate_limit_cleanup: p_grace_seconds tiene que estar entre 0 y 604800'
      USING ERRCODE = '22023';
  END IF;

  IF p_max_rows IS NULL OR p_max_rows < 1 OR p_max_rows > 1000000 THEN
    RAISE EXCEPTION 'rate_limit_cleanup: p_max_rows tiene que estar entre 1 y 1000000'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.rate_limit_buckets AS b
  WHERE (b.bucket_key, b.window_seconds, b.window_start) IN (
    SELECT x.bucket_key, x.window_seconds, x.window_start
    FROM public.rate_limit_buckets AS x
    -- Prefiltro indexable: la ventana más corta es de 1 s.
    WHERE x.window_start <= v_now - make_interval(secs => p_grace_seconds + 1)
      -- Condición exacta: la ventana terminó hace al menos la gracia.
      AND x.window_start + make_interval(secs => x.window_seconds + p_grace_seconds) <= v_now
    LIMIT p_max_rows
  );

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.rate_limit_cleanup(INTEGER, INTEGER) IS
  'Rate limiting Fase 1B — borra buckets vencidos hace más de p_grace_seconds '
  '(default 1 h). Nunca toca una ventana activa.';

REVOKE ALL ON FUNCTION public.rate_limit_cleanup(INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rate_limit_cleanup(INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.rate_limit_cleanup(INTEGER, INTEGER) FROM authenticated;
REVOKE ALL ON FUNCTION public.rate_limit_cleanup(INTEGER, INTEGER) FROM service_role;

-- ── 5. Job de limpieza ───────────────────────────────────────────────────────
--
-- Sólo si pg_cron está habilitado (en el proyecto lo está: ver
-- 20260627000000_register_cron_jobs.sql). En un entorno sin la extensión la
-- migración igual aplica y la limpieza queda manual.
--
-- Idempotente por nombre: se desprograma cualquier job previo con este nombre
-- antes de programarlo, así que reaplicar la migración no crea duplicados.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'rate-limit-cleanup';

    PERFORM cron.schedule(
      'rate-limit-cleanup',
      '*/30 * * * *',
      'SELECT public.rate_limit_cleanup();'
    );
  END IF;
END;
$$;

COMMIT;

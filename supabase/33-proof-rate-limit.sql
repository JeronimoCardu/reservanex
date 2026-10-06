-- ════════════════════════════════════════════════════════════════════════════
-- Rate limiting Fase 1B — prueba de rate_limit_hit / rate_limit_cleanup
-- ════════════════════════════════════════════════════════════════════════════
--
-- Cubre TODO lo que se puede probar desde una sola sesión: semántica de
-- ventana, retry-after, validación de input, privilegios, RLS y limpieza. La
-- concurrencia real (varias sesiones a la vez) NO se puede probar acá: la cubre
-- apps/web/scripts/validate-rate-limit.ts, que además corre este archivo.
--
-- SOLO CONTRA UNA BASE LOCAL. La migración 20261006000001 tiene que estar
-- aplicada. Corre como el owner de la tabla (postgres) para poder sembrar
-- buckets vencidos.
--
-- CÓMO CORRERLO
--   pnpm --filter @orderflow/web validate:rate-limit          (recomendado)
--   supabase db query --local -f supabase/33-proof-rate-limit.sql
--
-- Termina SIEMPRE con una excepción, así que revierte todo lo que escribió:
--   éxito → P0001 "RESULTADO OK checks=<n>"
--   fallo → P0001 "FALLO <check>: <detalle>"
--
-- Duerme ~4 s: la prueba de "ventana nueva" usa una ventana de 2 s y espera a
-- que pase de verdad, con el reloj de la base. Si arranca a menos de 30 s de un
-- borde de 10 min, espera además a que ese borde pase (hasta 30 s más).
-- ════════════════════════════════════════════════════════════════════════════

DO $proof$
DECLARE
  k_limit  TEXT;  -- 1..3 / bloqueo / conteo de bloqueados
  k_roll   TEXT;  -- ventana nueva (2 s)
  k_dual   TEXT;  -- 10 min y 24 h con la misma clave
  k_fresh  TEXT;  -- clave independiente
  k_multi  TEXT;  -- segundo bucket de la llamada multi-bucket
  k_short  TEXT;  -- retry-after: bucket de 10 min
  k_long   TEXT;  -- retry-after: bucket de 24 h
  k_inval  TEXT;  -- clave válida usada dentro de inputs inválidos
  k_role   TEXT;  -- privilegios
  k_old    TEXT;  -- limpieza: vencido hace mucho
  k_recent TEXT;  -- limpieza: vencido dentro de la gracia

  r        JSONB;
  i        INTEGER;
  n        BIGINT;
  ws       TIMESTAMPTZ;
  rows_k   INTEGER;
  expected INTEGER;
  denied   BOOLEAN;
  bad      JSONB;
  rol      TEXT;
  t_clean  TIMESTAMPTZ;
  checks   INTEGER := 0;
BEGIN
  -- Toda la prueba tiene que caer dentro de UNA ventana de 10 min (y por lo
  -- tanto de 24 h): si faltan menos de 30 s para el próximo borde, se espera a
  -- que pase. Sin esto, una corrida que cruza el borde vería "vencer" buckets
  -- que la prueba trata como activos.
  IF 600 - mod(extract(epoch FROM clock_timestamp()), 600) < 30 THEN
    PERFORM pg_sleep(600 - mod(extract(epoch FROM clock_timestamp()), 600) + 0.1);
  END IF;

  -- Claves con el formato real (rl1.<scope>.<43 chars>), únicas por corrida.
  k_limit  := 'rl1.ip.'              || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_roll   := 'rl1.ip.'              || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_dual   := 'rl1.ip_endpoint.'     || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_fresh  := 'rl1.ip.'              || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_multi  := 'rl1.ip_tenant_group.' || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_short  := 'rl1.ip_tenant.'       || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_long   := 'rl1.ip_tenant.'       || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_inval  := 'rl1.ip.'              || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_role   := 'rl1.ip.'              || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_old    := 'rl1.ip.'              || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);
  k_recent := 'rl1.ip.'              || md5(random()::text || clock_timestamp()::text) || left(md5(random()::text), 11);

  -- ── 1. requests 1..limit → allowed ──────────────────────────────────────
  FOR i IN 1..3 LOOP
    r := public.rate_limit_hit(jsonb_build_array(
      jsonb_build_object('bucket_key', k_limit, 'window_seconds', 600, 'limit', 3)));
    IF (r ->> 'allowed')::BOOLEAN IS NOT TRUE OR (r ->> 'retry_after_seconds')::INTEGER <> 0 THEN
      RAISE EXCEPTION 'FALLO 1: el intento % de 3 no quedó allowed: %', i, r;
    END IF;
  END LOOP;
  checks := checks + 1;

  -- ── 2. request limit+1 → blocked ────────────────────────────────────────
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_limit, 'window_seconds', 600, 'limit', 3)));
  IF (r ->> 'allowed')::BOOLEAN IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLO 2: el intento 4 de 3 no quedó bloqueado: %', r;
  END IF;
  checks := checks + 1;

  -- ── 3. retry_after_seconds entero en [1, ventana] ───────────────────────
  IF (r ->> 'retry_after_seconds')::INTEGER NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'FALLO 3: retry_after fuera de [1, 600]: %', r;
  END IF;
  checks := checks + 1;

  -- ── E. los bloqueados también cuentan y NO mueven la ventana ────────────
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_limit, 'window_seconds', 600, 'limit', 3)));
  SELECT count(*), max(hit_count), max(window_start) INTO rows_k, n, ws
  FROM public.rate_limit_buckets WHERE bucket_key = k_limit;
  IF rows_k <> 1 OR n <> 5 THEN
    RAISE EXCEPTION 'FALLO E: se esperaba 1 fila con hit_count=5, hay % fila(s) con %', rows_k, n;
  END IF;
  IF mod(extract(epoch FROM ws), 600) <> 0 THEN
    RAISE EXCEPTION 'FALLO E: window_start no está alineado a 600 s: %', ws;
  END IF;
  checks := checks + 1;

  -- ── 4. ventana nueva vuelve a permitir (ventana real de 2 s) ────────────
  -- Primero se espera al comienzo de una ventana, para que los dos primeros
  -- intentos caigan seguro en la misma.
  PERFORM pg_sleep(2 - mod(extract(epoch FROM clock_timestamp()), 2) + 0.05);
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_roll, 'window_seconds', 2, 'limit', 1)));
  IF (r ->> 'allowed')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLO 4: el primer intento en la ventana de 2 s no quedó allowed: %', r;
  END IF;
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_roll, 'window_seconds', 2, 'limit', 1)));
  IF (r ->> 'allowed')::BOOLEAN IS NOT FALSE OR (r ->> 'retry_after_seconds')::INTEGER NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'FALLO 4: el segundo intento no quedó bloqueado con retry 1..2: %', r;
  END IF;
  PERFORM pg_sleep(2 - mod(extract(epoch FROM clock_timestamp()), 2) + 0.05);
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_roll, 'window_seconds', 2, 'limit', 1)));
  IF (r ->> 'allowed')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLO 4: la ventana nueva no volvió a permitir: %', r;
  END IF;
  SELECT count(*) INTO rows_k FROM public.rate_limit_buckets WHERE bucket_key = k_roll;
  IF rows_k <> 2 THEN
    RAISE EXCEPTION 'FALLO 4: se esperaban 2 filas (una por ventana), hay %', rows_k;
  END IF;
  checks := checks + 1;

  -- ── 5. 10 min y 24 h de la misma clave son independientes ───────────────
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_dual, 'window_seconds', 600, 'limit', 1)));
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_dual, 'window_seconds', 600, 'limit', 1)));
  IF (r ->> 'allowed')::BOOLEAN IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLO 5: la ventana de 10 min no se agotó: %', r;
  END IF;
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_dual, 'window_seconds', 86400, 'limit', 1)));
  IF (r ->> 'allowed')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLO 5: la ventana de 24 h heredó el conteo de la de 10 min: %', r;
  END IF;
  SELECT count(*) INTO rows_k FROM public.rate_limit_buckets WHERE bucket_key = k_dual;
  IF rows_k <> 2 THEN
    RAISE EXCEPTION 'FALLO 5: se esperaban 2 filas (600 y 86400), hay %', rows_k;
  END IF;
  checks := checks + 1;

  -- ── 6. claves distintas son independientes ──────────────────────────────
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_fresh, 'window_seconds', 600, 'limit', 3)));
  IF (r ->> 'allowed')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLO 6: una clave nueva quedó bloqueada por otra agotada: %', r;
  END IF;
  checks := checks + 1;

  -- ── 7. multi-bucket: basta uno excedido para allowed=false ──────────────
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_multi, 'window_seconds', 600, 'limit', 100),
    jsonb_build_object('bucket_key', k_limit, 'window_seconds', 600, 'limit', 3)));
  IF (r ->> 'allowed')::BOOLEAN IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLO 7: con un bucket agotado la llamada quedó allowed: %', r;
  END IF;
  -- Y el bucket que NO estaba agotado igual contó el intento.
  SELECT hit_count INTO n FROM public.rate_limit_buckets WHERE bucket_key = k_multi;
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FALLO 7: el bucket no excedido no contó el intento (hit_count=%)', n;
  END IF;
  checks := checks + 1;

  -- ── 8. retry_after es el MAYOR entre los buckets excedidos ──────────────
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_short, 'window_seconds', 600,   'limit', 1),
    jsonb_build_object('bucket_key', k_long,  'window_seconds', 86400, 'limit', 1)));
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_short, 'window_seconds', 600,   'limit', 1),
    jsonb_build_object('bucket_key', k_long,  'window_seconds', 86400, 'limit', 1)));
  expected := greatest(
    ceil(floor(extract(epoch FROM clock_timestamp()) / 600)   * 600   + 600   - extract(epoch FROM clock_timestamp())),
    ceil(floor(extract(epoch FROM clock_timestamp()) / 86400) * 86400 + 86400 - extract(epoch FROM clock_timestamp()))
  )::INTEGER;
  IF (r ->> 'allowed')::BOOLEAN IS NOT FALSE
     OR abs((r ->> 'retry_after_seconds')::INTEGER - expected) > 2 THEN
    RAISE EXCEPTION 'FALLO 8: retry_after % no es el mayor esperado (~%)', r, expected;
  END IF;
  checks := checks + 1;

  -- ── 9. input inválido → 22023 y no escribe nada ─────────────────────────
  BEGIN
    PERFORM public.rate_limit_hit(NULL);
    RAISE EXCEPTION 'FALLO 9: aceptó p_buckets NULL';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  FOR bad IN
    SELECT v FROM unnest(ARRAY[
      '{}'::JSONB,
      '"rl1"'::JSONB,
      '[]'::JSONB,
      '[1]'::JSONB,
      '[null]'::JSONB,
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600, 'limit', 3, 'ip', '203.0.113.7')),
      jsonb_build_array(jsonb_build_object('bucket_key', '203.0.113.7', 'window_seconds', 600, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', 'pizzeria-demo', 'window_seconds', 600, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', 'rl1.ip.short', 'window_seconds', 600, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', 'rl1.other.' || repeat('a', 43), 'window_seconds', 600, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', 'rl1.ip.' || repeat('a', 42) || '=', 'window_seconds', 600, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', 42, 'window_seconds', 600, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 0, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', -600, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 86401, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600.5, 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', '600', 'limit', 3)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600, 'limit', 0)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600, 'limit', 10001)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600, 'limit', 2.5)),
      jsonb_build_array(jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600, 'limit', NULL)),
      jsonb_build_array(
        jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600, 'limit', 3),
        jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600, 'limit', 3)),
      jsonb_build_array(
        jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600,   'limit', 3),
        jsonb_build_object('bucket_key', k_inval, 'window_seconds', 600.0, 'limit', 9)),
      (SELECT jsonb_agg(jsonb_build_object('bucket_key', 'rl1.ip.' || lpad(g::text, 43, '0'), 'window_seconds', 600, 'limit', 3))
       FROM generate_series(1, 9) AS g)
    ]) AS v
  LOOP
    BEGIN
      PERFORM public.rate_limit_hit(bad);
      RAISE EXCEPTION 'FALLO 9: aceptó un input inválido: %', bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;

  SELECT count(*) INTO rows_k FROM public.rate_limit_buckets
  WHERE bucket_key = k_inval OR bucket_key LIKE 'rl1.ip.000%';
  IF rows_k <> 0 THEN
    RAISE EXCEPTION 'FALLO 9: un input inválido escribió % fila(s)', rows_k;
  END IF;
  checks := checks + 1;

  -- ── 10. anon NO puede ejecutar la RPC ni tocar la tabla ─────────────────
  SET ROLE anon;
  denied := false;
  BEGIN
    PERFORM public.rate_limit_hit(jsonb_build_array(
      jsonb_build_object('bucket_key', k_role, 'window_seconds', 600, 'limit', 3)));
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RESET ROLE;
  IF NOT denied THEN RAISE EXCEPTION 'FALLO 10: anon pudo ejecutar rate_limit_hit'; END IF;

  SET ROLE anon;
  denied := false;
  BEGIN
    PERFORM 1 FROM public.rate_limit_buckets LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RESET ROLE;
  IF NOT denied THEN RAISE EXCEPTION 'FALLO 10: anon pudo leer rate_limit_buckets'; END IF;
  checks := checks + 1;

  -- ── 11. authenticated NO puede ejecutar la RPC ni tocar la tabla ────────
  SET ROLE authenticated;
  denied := false;
  BEGIN
    PERFORM public.rate_limit_hit(jsonb_build_array(
      jsonb_build_object('bucket_key', k_role, 'window_seconds', 600, 'limit', 3)));
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RESET ROLE;
  IF NOT denied THEN RAISE EXCEPTION 'FALLO 11: authenticated pudo ejecutar rate_limit_hit'; END IF;

  SET ROLE authenticated;
  denied := false;
  BEGIN
    INSERT INTO public.rate_limit_buckets (bucket_key, window_seconds, window_start, hit_count, updated_at)
    VALUES (k_role, 600, to_timestamp(0), 1, now());
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RESET ROLE;
  IF NOT denied THEN RAISE EXCEPTION 'FALLO 11: authenticated pudo insertar en rate_limit_buckets'; END IF;
  checks := checks + 1;

  -- ── 12. service_role SÍ ejecuta la RPC, pero NO toca la tabla directo ───
  SET ROLE service_role;
  r := public.rate_limit_hit(jsonb_build_array(
    jsonb_build_object('bucket_key', k_role, 'window_seconds', 600, 'limit', 3)));
  RESET ROLE;
  IF (r ->> 'allowed')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLO 12: service_role no pudo usar la RPC: %', r;
  END IF;

  SET ROLE service_role;
  denied := false;
  BEGIN
    PERFORM 1 FROM public.rate_limit_buckets LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RESET ROLE;
  IF NOT denied THEN RAISE EXCEPTION 'FALLO 12: service_role pudo leer la tabla sin pasar por la RPC'; END IF;
  checks := checks + 1;

  -- ── 12b. nadie más que el owner ejecuta la limpieza ─────────────────────
  FOREACH rol IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    EXECUTE format('SET ROLE %I', rol);
    denied := false;
    BEGIN
      PERFORM public.rate_limit_cleanup();
    EXCEPTION WHEN insufficient_privilege THEN denied := true;
    END;
    RESET ROLE;
    IF NOT denied THEN RAISE EXCEPTION 'FALLO 12b: % pudo ejecutar rate_limit_cleanup', rol; END IF;
  END LOOP;
  checks := checks + 1;

  -- ── 12c. catálogo: privilegios por defecto, RLS y definición ────────────
  IF has_function_privilege('anon',          'public.rate_limit_hit(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rate_limit_hit(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.rate_limit_hit(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLO 12c: EXECUTE de rate_limit_hit no es exactamente service_role';
  END IF;

  -- proacl NULL significa "privilegios por defecto", que incluyen EXECUTE para
  -- PUBLIC: aclexplode(NULL) no devolvería nada y el chequeo pasaría mal.
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid IN ('public.rate_limit_hit(jsonb)'::regprocedure,
                  'public.rate_limit_cleanup(integer, integer)'::regprocedure)
      AND proacl IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.oid IN ('public.rate_limit_hit(jsonb)'::regprocedure,
                    'public.rate_limit_cleanup(integer, integer)'::regprocedure)
      AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'FALLO 12c: PUBLIC conserva EXECUTE sobre una función de rate limiting';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc, unnest(proconfig) AS c
    WHERE oid = 'public.rate_limit_hit(jsonb)'::regprocedure
      AND prosecdef
      AND c IN ('search_path=""', 'search_path=')
  ) THEN
    RAISE EXCEPTION 'FALLO 12c: rate_limit_hit no es SECURITY DEFINER con search_path vacío';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rate_limit_buckets'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rate_limit_buckets')
     OR (SELECT relpersistence FROM pg_class WHERE oid = 'public.rate_limit_buckets'::regclass) <> 'p' THEN
    RAISE EXCEPTION 'FALLO 12c: la tabla tiene que ser normal, con RLS y sin policies';
  END IF;

  IF has_table_privilege('anon',          'public.rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role',  'public.rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'FALLO 12c: algún rol cliente conserva privilegios sobre rate_limit_buckets';
  END IF;
  checks := checks + 1;

  -- ── 13 / 14. limpieza ───────────────────────────────────────────────────
  -- k_old: ventana que terminó hace ~2 días. k_recent: terminó hace ≥10 min
  -- pero dentro de la gracia de 1 h.
  INSERT INTO public.rate_limit_buckets (bucket_key, window_seconds, window_start, hit_count, updated_at)
  VALUES
    (k_old,    600, to_timestamp(floor((extract(epoch FROM clock_timestamp()) - 172800) / 600) * 600), 7, clock_timestamp()),
    (k_recent, 600, to_timestamp(floor((extract(epoch FROM clock_timestamp()) - 1200)   / 600) * 600), 2, clock_timestamp());

  PERFORM public.rate_limit_cleanup(3600);

  IF EXISTS (SELECT 1 FROM public.rate_limit_buckets WHERE bucket_key = k_old) THEN
    RAISE EXCEPTION 'FALLO 14: la limpieza no borró un bucket vencido hace 2 días';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rate_limit_buckets WHERE bucket_key = k_recent) THEN
    RAISE EXCEPTION 'FALLO 13: la limpieza borró un bucket vencido dentro de la gracia';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rate_limit_buckets WHERE bucket_key = k_limit) THEN
    RAISE EXCEPTION 'FALLO 13: la limpieza borró un bucket activo';
  END IF;

  -- Con gracia 0 se va lo vencido, pero lo ACTIVO sigue sin tocarse. t_clean
  -- se toma ANTES: todo lo que ya estaba vencido en ese instante también lo
  -- está para la limpieza, que lee su propio reloj después.
  t_clean := clock_timestamp();
  PERFORM public.rate_limit_cleanup(0);

  IF EXISTS (SELECT 1 FROM public.rate_limit_buckets WHERE bucket_key = k_recent) THEN
    RAISE EXCEPTION 'FALLO 14: con gracia 0 no se borró un bucket vencido';
  END IF;
  SELECT count(*) INTO rows_k FROM public.rate_limit_buckets
  WHERE bucket_key IN (k_limit, k_dual, k_fresh, k_multi, k_short, k_long, k_role);
  IF rows_k <> 8 THEN
    RAISE EXCEPTION 'FALLO 13: la limpieza con gracia 0 tocó buckets activos (quedan % de 8)', rows_k;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rate_limit_buckets
    WHERE bucket_key = k_roll AND window_start + make_interval(secs => window_seconds) <= t_clean
  ) THEN
    RAISE EXCEPTION 'FALLO 14: quedó una ventana de 2 s que ya había terminado';
  END IF;

  BEGIN
    PERFORM public.rate_limit_cleanup(-1);
    RAISE EXCEPTION 'FALLO 14: aceptó una gracia negativa';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  checks := checks + 1;

  RAISE EXCEPTION 'RESULTADO OK checks=%', checks;
END
$proof$;

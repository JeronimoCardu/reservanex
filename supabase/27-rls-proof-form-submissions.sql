-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3A — prueba de RLS de public.form_submissions
-- ════════════════════════════════════════════════════════════════════════════
--
-- POR QUÉ EXISTE ESTE ARCHIVO
--
-- Las policies tenant-scoped del producto dependen de auth_tenant_id(), que lee
-- el claim app_metadata.tenant_id. Ese claim lo pone custom_access_token_hook,
-- que se registra en el Dashboard (Authentication → Hooks), NO en una migración.
-- Mientras el hook no esté registrado en el proyecto, NINGÚN login real produce
-- un JWT con tenant_id, y por lo tanto las policies no se pueden ejercitar
-- iniciando sesión de verdad (es lo que reporta `pnpm --filter @orderflow/web
-- validate:forms` como PRECONDICIÓN NO CUMPLIDA).
--
-- Este script prueba las policies IGUAL, sin depender del hook: simula el claim
-- con set_config('request.jwt.claims', ...) — que es exactamente de donde
-- auth.jwt() lo lee — y corre como el rol `authenticated`, que es a quien
-- apuntan las policies. No reemplaza registrar el hook: prueba que la POLICY
-- está bien escrita, no que el login la alimente.
--
-- CÓMO CORRERLO
--
--   supabase db query --linked -f supabase/27-rls-proof-form-submissions.sql
--
-- Termina SIEMPRE con un error P0001 que empieza con "RESULTADO ...". Eso es
-- intencional: el RAISE EXCEPTION revierte el fixture, así que el script no
-- deja NADA en la base. El error ES el resultado.
--
-- RESULTADO ESPERADO (verificado contra tjqfysbcmpqlwmzdvynr):
--
--   claim=11111111-1111-4111-8111-111111111111
--   ve_total=1      → sin WHERE, solo ve lo suyo (no las 2 filas)
--   ve_propias=1    → ve su propia submission
--   ve_ajenas=0     → NO ve la del otro tenant
--   upd_propia=1    → puede actualizar el estado de la suya
--   upd_ajena=0     → NO puede tocar la del otro tenant
--   delete=0        → NADIE borra por RLS (no hay policy de DELETE)
--
-- Cualquier otro número es una fuga entre tenants.
-- ════════════════════════════════════════════════════════════════════════════

DO $proof$
DECLARE
  a_id   UUID := '11111111-1111-4111-8111-111111111111';
  b_id   UUID := '22222222-2222-4222-8222-222222222222';
  v_claim UUID; v_total INT; v_own INT; v_foreign INT;
  v_upd_own INT; v_upd_foreign INT; v_del INT;
BEGIN
  INSERT INTO public.tenants (id, name, slug, status, vertical)
  VALUES (a_id, '[RLSPROOF] A', 'rlsproof-a', 'active', 'real_estate'),
         (b_id, '[RLSPROOF] B', 'rlsproof-b', 'active', 'food_service');

  INSERT INTO public.form_submissions
    (tenant_id, reference, intent, status, source, payload, idempotency_key, expires_at)
  VALUES
    (a_id, 'SUB-AAAAAA', 'property_inquiry', 'submitted', 'public_site',
     '{"name":"A"}'::jsonb, gen_random_uuid(), NOW() + INTERVAL '1 day'),
    (b_id, 'SUB-BBBBBB', 'general_inquiry',  'submitted', 'public_site',
     '{"name":"B"}'::jsonb, gen_random_uuid(), NOW() + INTERVAL '1 day');

  -- A partir de acá somos un usuario autenticado del tenant A.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111"}}', true);

  SELECT public.auth_tenant_id() INTO v_claim;
  SELECT count(*) INTO v_total   FROM public.form_submissions;
  SELECT count(*) INTO v_own     FROM public.form_submissions WHERE tenant_id = a_id;
  SELECT count(*) INTO v_foreign FROM public.form_submissions WHERE tenant_id = b_id;

  WITH u AS (UPDATE public.form_submissions SET status='confirmed'
             WHERE reference='SUB-AAAAAA' RETURNING 1)
  SELECT count(*) INTO v_upd_own FROM u;

  WITH u AS (UPDATE public.form_submissions SET status='confirmed'
             WHERE reference='SUB-BBBBBB' RETURNING 1)
  SELECT count(*) INTO v_upd_foreign FROM u;

  WITH d AS (DELETE FROM public.form_submissions
             WHERE reference='SUB-AAAAAA' RETURNING 1)
  SELECT count(*) INTO v_del FROM d;

  RESET ROLE;
  RAISE EXCEPTION 'RESULTADO claim=% ve_total=% ve_propias=% ve_ajenas=% upd_propia=% upd_ajena=% delete=%',
    v_claim, v_total, v_own, v_foreign, v_upd_own, v_upd_foreign, v_del;
END
$proof$;

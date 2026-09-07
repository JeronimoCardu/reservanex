-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3A.1 — prueba de RLS tenant + impersonación (form_submissions, contacts)
-- ════════════════════════════════════════════════════════════════════════════
--
-- QUÉ PRUEBA
--
--   A. un usuario de tenant ve SUS submissions
--   B. un usuario de tenant NO ve las de otro tenant
--   C. un super admin impersonando al tenant A ve las submissions de A
--   D. un super admin impersonando al tenant A NO ve las de B
--   E. un super admin SIN sesión de impersonación activa no ve nada por sa_imp_
--   F. la impersonación NO puede INSERT ni DELETE (desviación deliberada del
--      FOR ALL de documents/reservations — ver la migración 20260907000001)
--   G. lo mismo sobre `contacts`, una tabla tenant-scoped preexistente con el
--      patrón sa_imp_all_, para confirmar que no es algo propio de form_submissions
--
-- POR QUÉ NO USA UN LOGIN REAL
--
-- Los claims NO se escriben a mano acá: se obtienen llamando a la función real
-- public.custom_access_token_hook() y se inyectan tal cual en
-- request.jwt.claims, que es exactamente de donde auth.jwt() los lee. O sea que
-- esto prueba el hook Y las policies juntos, sin depender de que el hook esté
-- registrado en el Dashboard. Lo único que NO cubre es que GoTrue efectivamente
-- invoque el hook al emitir el JWT — eso requiere el registro y se verifica con
-- `pnpm --filter @orderflow/web validate:auth-hook` una vez registrado.
--
-- La impersonación sí usa el mecanismo REAL: auth_impersonating_tenant_id() lee
-- la tabla impersonation_sessions en la DB, y este script crea una sesión de
-- verdad.
--
-- ESTADO DE LA VERIFICACIÓN (Fase 3A.1)
--
-- ✅ VERIFICADO acá, con el mecanismo real de impersonación (una fila viva en
--    impersonation_sessions) y con los claims que produce el hook real:
--    los casos A–G de arriba.
--
-- ✅ VERIFICADO aparte, con LOGIN REAL de un usuario tenant contra el proyecto
--    (pnpm --filter @orderflow/web validate:auth-hook): el hook ya está
--    registrado en el Dashboard y GoTrue lo invoca al emitir el JWT.
--
-- ⏳ PENDIENTE: el E2E de impersonación con una CUENTA REAL de super admin.
--    Al momento de escribir esto NO existe ningún super admin creado en el
--    proyecto, así que la ruta completa (login real de platform_user →
--    abrir sesión de impersonación desde la app → leer datos del tenant) no
--    se pudo ejercitar. Lo que sí está probado es que las policies aceptan
--    exactamente los claims que el hook produce para un platform_user
--    (hook_sa_ok=t) y que la condición de impersonación funciona contra la
--    tabla real. Falta únicamente el eslabón de la cuenta.
--
--    Cuando se cree el primer super admin: repetir C/D/E con login real,
--    del mismo modo que validate-auth-hook.ts hace con el usuario tenant.
--
-- CÓMO CORRERLO
--
--   supabase db query --linked -f supabase/28-rls-proof-impersonation.sql
--
-- Termina SIEMPRE con un error P0001 que empieza con "RESULTADO". Es
-- intencional: el RAISE EXCEPTION revierte todo el fixture. El error ES el
-- resultado. No deja NADA en la base.
--
-- RESULTADO ESPERADO (verificado contra tjqfysbcmpqlwmzdvynr):
--
--   hook_tenant_ok=t      el hook produjo user_type/tenant_id/role correctos
--   hook_sa_ok=t          idem para el platform user (super_admin)
--   A_propias=1  B_ajenas=0
--   E_sa_sin_imp=0
--   C_imp_propias=1  D_imp_ajenas=0
--   F_imp_insert=0  F_imp_delete=0
--   G_contacts_imp_propias=1  G_contacts_imp_ajenas=0
-- ════════════════════════════════════════════════════════════════════════════

DO $proof$
DECLARE
  a_id      UUID := 'aaaaaaaa-0000-4000-8000-000000000001';
  b_id      UUID := 'bbbbbbbb-0000-4000-8000-000000000002';
  u_tenant  UUID := 'cccccccc-0000-4000-8000-000000000003';
  u_admin   UUID := 'dddddddd-0000-4000-8000-000000000004';
  imp_id    UUID := 'eeeeeeee-0000-4000-8000-000000000005';

  claims_tenant JSONB;
  claims_admin  JSONB;

  hook_tenant_ok BOOLEAN; hook_sa_ok BOOLEAN;
  r_a INT; r_b INT; r_e INT; r_c INT; r_d INT;
  r_f_ins INT; r_f_del INT; r_g_own INT; r_g_for INT;
BEGIN
  -- ── fixture ──────────────────────────────────────────────────────────────
  INSERT INTO public.tenants (id, name, slug, status, vertical) VALUES
    (a_id, '[IMPPROOF] A', 'impproof-a', 'active', 'real_estate'),
    (b_id, '[IMPPROOF] B', 'impproof-b', 'active', 'food_service');

  INSERT INTO auth.users (id) VALUES (u_tenant), (u_admin);

  INSERT INTO public.tenant_users (id, tenant_id, name, email, role, active)
  VALUES (u_tenant, a_id, 'Owner A', 'owner-a@impproof.test', 'owner', true);

  INSERT INTO public.platform_users (id, name, email, role, active)
  VALUES (u_admin, 'Super Admin', 'sa@impproof.test', 'super_admin', true);

  INSERT INTO public.form_submissions
    (tenant_id, reference, intent, status, source, payload, idempotency_key, expires_at)
  VALUES
    (a_id, 'SUB-AAAAAA', 'property_inquiry', 'submitted', 'public_site',
     '{"name":"de A"}'::jsonb, gen_random_uuid(), NOW() + INTERVAL '1 day'),
    (b_id, 'SUB-BBBBBB', 'general_inquiry',  'submitted', 'public_site',
     '{"name":"de B"}'::jsonb, gen_random_uuid(), NOW() + INTERVAL '1 day');

  INSERT INTO public.contacts (tenant_id, phone, name) VALUES
    (a_id, '5490000000001', 'Contacto A'),
    (b_id, '5490000000002', 'Contacto B');

  -- ── claims REALES, producidos por el hook ────────────────────────────────
  claims_tenant := public.custom_access_token_hook(jsonb_build_object(
    'user_id', u_tenant::text,
    'claims',  jsonb_build_object('sub', u_tenant::text, 'app_metadata', '{}'::jsonb)
  )) -> 'claims';

  claims_admin := public.custom_access_token_hook(jsonb_build_object(
    'user_id', u_admin::text,
    'claims',  jsonb_build_object('sub', u_admin::text, 'app_metadata', '{}'::jsonb)
  )) -> 'claims';

  hook_tenant_ok :=
       (claims_tenant -> 'app_metadata' ->> 'user_type') = 'tenant_user'
   AND (claims_tenant -> 'app_metadata' ->> 'tenant_id') = a_id::text
   AND (claims_tenant -> 'app_metadata' ->> 'role')      = 'owner';

  hook_sa_ok :=
       (claims_admin -> 'app_metadata' ->> 'user_type') = 'platform_user'
   AND (claims_admin -> 'app_metadata' ->> 'role')      = 'super_admin';

  -- ── A / B: usuario de tenant ─────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', claims_tenant::text, true);

  SELECT count(*) INTO r_a FROM public.form_submissions WHERE tenant_id = a_id;
  SELECT count(*) INTO r_b FROM public.form_submissions WHERE tenant_id = b_id;

  -- ── E: super admin SIN impersonación ─────────────────────────────────────
  PERFORM set_config('request.jwt.claims', claims_admin::text, true);
  SELECT count(*) INTO r_e FROM public.form_submissions;

  -- ── sesión de impersonación REAL sobre el tenant A ───────────────────────
  RESET ROLE;
  INSERT INTO public.impersonation_sessions
    (id, platform_user_id, target_tenant_id, reason, started_at, ended_at)
  VALUES (imp_id, u_admin, a_id, 'RLS proof', NOW(), NULL);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', claims_admin::text, true);

  -- ── C / D: super admin impersonando a A ──────────────────────────────────
  SELECT count(*) INTO r_c FROM public.form_submissions WHERE tenant_id = a_id;
  SELECT count(*) INTO r_d FROM public.form_submissions WHERE tenant_id = b_id;

  -- ── F: la impersonación NO inserta ni borra ──────────────────────────────
  BEGIN
    WITH i AS (
      INSERT INTO public.form_submissions
        (tenant_id, reference, intent, status, source, payload, idempotency_key, expires_at)
      VALUES (a_id, 'SUB-XXXXXX', 'property_inquiry', 'submitted', 'public_site',
              '{}'::jsonb, gen_random_uuid(), NOW() + INTERVAL '1 day')
      RETURNING 1)
    SELECT count(*) INTO r_f_ins FROM i;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    r_f_ins := 0;   -- RLS lo bloqueó, que es lo que queremos
  END;

  WITH d AS (DELETE FROM public.form_submissions WHERE tenant_id = a_id RETURNING 1)
  SELECT count(*) INTO r_f_del FROM d;

  -- ── G: misma prueba sobre contacts (patrón sa_imp_all_ preexistente) ─────
  SELECT count(*) INTO r_g_own FROM public.contacts WHERE tenant_id = a_id;
  SELECT count(*) INTO r_g_for FROM public.contacts WHERE tenant_id = b_id;

  RESET ROLE;
  RAISE EXCEPTION 'RESULTADO hook_tenant_ok=% hook_sa_ok=% A_propias=% B_ajenas=% E_sa_sin_imp=% C_imp_propias=% D_imp_ajenas=% F_imp_insert=% F_imp_delete=% G_contacts_imp_propias=% G_contacts_imp_ajenas=%',
    hook_tenant_ok, hook_sa_ok, r_a, r_b, r_e, r_c, r_d, r_f_ins, r_f_del, r_g_own, r_g_for;
END
$proof$;

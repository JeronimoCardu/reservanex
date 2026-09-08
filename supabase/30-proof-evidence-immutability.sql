-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3C — inmutabilidad de la evidencia: impersonación y service role
-- ════════════════════════════════════════════════════════════════════════════
--
-- Complementa a apps/web/scripts/validate-evidence-integrity.ts, que cubre el
-- caso del owner con LOGIN REAL. Acá se cubren los dos casos que ese script no
-- puede ejercitar:
--
--   D. un SUPER ADMIN IMPERSONANDO no obtiene poderes extra sobre la evidencia
--      (no existe todavía una cuenta super admin real en el proyecto, así que
--      se simulan los claims que produce el hook — misma técnica que
--      28-rls-proof-impersonation.sql, y la sesión de impersonación es real).
--
--   S. el SERVICE ROLE tampoco puede reescribirla. Esto es a propósito: el
--      trigger aplica a todos los roles, así que ni un bug del worker puede
--      alterar lo que el cliente pidió. El service role sí conserva lo que
--      necesita: crear la operación por la RPC y mover el status.
--
-- CÓMO CORRERLO
--   supabase db query --linked -f supabase/30-proof-evidence-immutability.sql
--
-- Termina SIEMPRE con un error P0001 "RESULTADO": revierte todo el fixture.
--
-- RESULTADO ESPERADO (verificado contra tjqfysbcmpqlwmzdvynr):
--   imp_ve=1 imp_payload_bloqueado=t imp_intent_bloqueado=t imp_decision_bloqueada=t
--   sr_payload_bloqueado=t sr_submission_payload_bloqueado=t sr_status_ok=t
-- ════════════════════════════════════════════════════════════════════════════

DO $proof$
DECLARE
  t_id    UUID := 'dddd0000-0000-4000-8000-0000000000e1';
  u_admin UUID := 'dddd0000-0000-4000-8000-0000000000e2';
  c_id    UUID;
  s_id    UUID;
  o_id    UUID;
  claims_admin JSONB;

  imp_ve INT;
  imp_payload_bloqueado BOOLEAN := false;
  imp_intent_bloqueado  BOOLEAN := false;
  imp_decision_bloqueada BOOLEAN := false;
  sr_payload_bloqueado  BOOLEAN := false;
  sr_sub_payload_bloqueado BOOLEAN := false;
  sr_status_ok          BOOLEAN := false;
BEGIN
  -- ── fixture ──────────────────────────────────────────────────────────────
  INSERT INTO public.tenants (id, name, slug, status, vertical)
  VALUES (t_id, '[EVPROOF] tenant', 'evproof-tenant', 'active', 'real_estate');

  INSERT INTO auth.users (id) VALUES (u_admin);
  INSERT INTO public.platform_users (id, name, email, role, active)
  VALUES (u_admin, 'SA', 'sa@evproof.test', 'super_admin', true);

  INSERT INTO public.contacts (tenant_id, phone, name)
  VALUES (t_id, '5490000009901', 'Cliente') RETURNING id INTO c_id;

  INSERT INTO public.form_submissions
    (tenant_id, reference, intent, status, source, payload, idempotency_key,
     expires_at, contact_id)
  VALUES
    (t_id, 'SUB-EV2222', 'temporary_rental', 'submitted', 'public_site',
     '{"name":"Ana","check_in":"2026-10-15","check_out":"2026-10-20","adults":2}'::jsonb,
     gen_random_uuid(), NOW() + INTERVAL '1 day', c_id)
  RETURNING id INTO s_id;

  -- La operación nace por la RPC real.
  SELECT (public.confirm_submission_and_create_operation(s_id, t_id, c_id, NULL) ->> 'operation_id')::UUID
  INTO o_id;

  -- ── S. SERVICE ROLE: tampoco puede reescribir evidencia ──────────────────
  BEGIN
    UPDATE public.operation_requests SET payload_snapshot = '{"hackeado":true}'::jsonb WHERE id = o_id;
  EXCEPTION WHEN check_violation THEN sr_payload_bloqueado := true;
  END;

  BEGIN
    UPDATE public.form_submissions SET payload = '{"hackeado":true}'::jsonb WHERE id = s_id;
  EXCEPTION WHEN check_violation THEN sr_sub_payload_bloqueado := true;
  END;

  -- Pero sí conserva lo operativo: mover el status de la submission.
  BEGIN
    UPDATE public.form_submissions SET status = 'cancelled' WHERE id = s_id;
    sr_status_ok := true;
    UPDATE public.form_submissions SET status = 'confirmed' WHERE id = s_id;
  EXCEPTION WHEN others THEN sr_status_ok := false;
  END;

  -- ── D. SUPER ADMIN IMPERSONANDO ──────────────────────────────────────────
  claims_admin := public.custom_access_token_hook(jsonb_build_object(
    'user_id', u_admin::text,
    'claims',  jsonb_build_object('sub', u_admin::text, 'app_metadata', '{}'::jsonb)
  )) -> 'claims';

  INSERT INTO public.impersonation_sessions
    (platform_user_id, target_tenant_id, reason, started_at, ended_at)
  VALUES (u_admin, t_id, 'evidence proof', NOW(), NULL);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', claims_admin::text, true);

  -- Ve la operación (si no, los bloqueos de abajo serían falsos verdes).
  SELECT count(*) INTO imp_ve FROM public.operation_requests WHERE id = o_id;

  BEGIN
    UPDATE public.operation_requests SET payload_snapshot = '{"hackeado":true}'::jsonb WHERE id = o_id;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN imp_payload_bloqueado := true;
  END;

  BEGIN
    UPDATE public.operation_requests SET intent = 'general_inquiry' WHERE id = o_id;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN imp_intent_bloqueado := true;
  END;

  -- Y la DECISIÓN tampoco (migración 20260908000006). Antes esto sí se podía:
  -- decided_by/decided_at son hechos sobre quién decidió y cuándo, y poder
  -- escribirlos directo es poder fabricarlos. La aprobación humana tendrá su
  -- propia RPC en una fase posterior.
  BEGIN
    UPDATE public.operation_requests
    SET status = 'rejected', decided_at = NOW(), decided_by = NULL, decision_notes = 'soporte'
    WHERE id = o_id;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN imp_decision_bloqueada := true;
  END;

  RESET ROLE;

  RAISE EXCEPTION 'RESULTADO imp_ve=% imp_payload_bloqueado=% imp_intent_bloqueado=% imp_decision_bloqueada=% sr_payload_bloqueado=% sr_submission_payload_bloqueado=% sr_status_ok=%',
    imp_ve, imp_payload_bloqueado, imp_intent_bloqueado, imp_decision_bloqueada,
    sr_payload_bloqueado, sr_sub_payload_bloqueado, sr_status_ok;
END
$proof$;

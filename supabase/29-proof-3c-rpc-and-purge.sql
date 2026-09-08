-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3C — pruebas de la RPC y del purge, sin dejar nada en la base
-- ════════════════════════════════════════════════════════════════════════════
--
-- QUÉ PRUEBA
--
--   A. anon NO puede ejecutar confirm_submission_and_create_operation
--      (es SECURITY DEFINER: si pudiera, saltearía RLS).
--   B. authenticated tampoco.
--   C. admin_purge_tenant sigue funcionando después de haber sido regenerada,
--      y ahora reporta operation_requests.
--
-- CÓMO CORRERLO
--   supabase db query --linked -f supabase/29-proof-3c-rpc-and-purge.sql
--
-- Termina SIEMPRE con un error P0001 que empieza con "RESULTADO": el
-- RAISE EXCEPTION revierte el fixture. El error ES el resultado.
--
-- RESULTADO ESPERADO (verificado contra tjqfysbcmpqlwmzdvynr):
--   anon_bloqueado=t  authenticated_bloqueado=t
--   purge_ops=1 purge_subs=1 purge_contacts=1
-- ════════════════════════════════════════════════════════════════════════════

DO $proof$
DECLARE
  t_id     UUID := 'cccc0000-0000-4000-8000-00000000c3c1';
  c_id     UUID;
  s_id     UUID;
  anon_blocked BOOLEAN := false;
  auth_blocked BOOLEAN := false;
  purge    JSONB;
BEGIN
  -- ── A/B: permisos de ejecución ───────────────────────────────────────────
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.confirm_submission_and_create_operation(
      gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL);
    RESET ROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    anon_blocked := true;
    RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.confirm_submission_and_create_operation(
      gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL);
    RESET ROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    auth_blocked := true;
    RESET ROLE;
  END;

  -- ── C: purge con una operación viva ──────────────────────────────────────
  INSERT INTO public.tenants (id, name, slug, status, vertical)
  VALUES (t_id, '[3CPROOF] purge', 'proof-3c-purge', 'active', 'real_estate');

  INSERT INTO public.contacts (tenant_id, phone, name)
  VALUES (t_id, '5490000003131', 'Contacto 3C') RETURNING id INTO c_id;

  INSERT INTO public.form_submissions
    (tenant_id, reference, intent, status, source, payload, idempotency_key,
     expires_at, contact_id, confirmed_at)
  VALUES
    (t_id, 'SUB-C3C3C3', 'temporary_rental', 'confirmed', 'public_site',
     '{"name":"X","check_in":"2026-10-15","check_out":"2026-10-20","adults":2}'::jsonb,
     gen_random_uuid(), NOW() + INTERVAL '1 day', c_id, NOW())
  RETURNING id INTO s_id;

  INSERT INTO public.operation_requests
    (tenant_id, contact_id, source_submission_id, kind, intent, status,
     payload_snapshot, customer_confirmed_at)
  VALUES
    (t_id, c_id, s_id, 'reservation_request', 'temporary_rental', 'pending',
     '{"name":"X"}'::jsonb, NOW());

  SELECT public.admin_purge_tenant(t_id) INTO purge;

  RAISE EXCEPTION 'RESULTADO anon_bloqueado=% authenticated_bloqueado=% purge_ops=% purge_subs=% purge_contacts=%',
    anon_blocked, auth_blocked,
    purge->>'operation_requests', purge->>'form_submissions', purge->>'contacts';
END
$proof$;

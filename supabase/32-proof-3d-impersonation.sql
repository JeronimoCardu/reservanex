-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3D — un super admin impersonando NO decide solicitudes
-- ════════════════════════════════════════════════════════════════════════════
--
-- Complementa a apps/web/scripts/validate-decisions.ts, que cubre owner y
-- recepcionista con login real. Acá se cubre el caso que ese script no puede
-- ejercitar: todavía no existe una cuenta super admin real en el proyecto, así
-- que se simulan los claims que produce el hook (misma técnica que las pruebas
-- 28 y 30) y la sesión de impersonación se crea de verdad.
--
-- ── LA DECISIÓN ADOPTADA (§6) ───────────────────────────────────────────────
--
-- Un super admin impersonando puede LEER, no puede DECIDIR.
--
-- No es una preferencia: es el patrón ya establecido del producto. Diez
-- archivos de apps/web/src/actions (contacts, conversations, documents,
-- messages, monthly-rentals, notes, receipts, receipt-whatsapp,
-- reservation-payments, reservations) abren sus mutaciones con
--
--     if (ctx.accessMode === 'setup_operator') return { success: false, ... }
--
-- La impersonación en ReservaNex es soporte y lectura. Aprobar el pedido de un
-- cliente en nombre del tenant es una decisión de negocio del tenant, y
-- decided_by tiene que ser una persona de ese tenant — no alguien de la
-- plataforma actuando como si lo fuera.
--
-- La diferencia con las server actions es DÓNDE se aplica: acá el bloqueo está
-- en la BASE. Aunque alguien llamara la RPC salteándose la action, el chequeo
-- de auth_user_type() la rechaza igual.
--
-- CÓMO CORRERLO
--   supabase db query --linked -f supabase/32-proof-3d-impersonation.sql
--
-- Termina SIEMPRE con un error P0001 "RESULTADO": revierte todo el fixture.
--
-- RESULTADO ESPERADO (verificado contra tjqfysbcmpqlwmzdvynr):
--   imp_lee=1 imp_decide_bloqueado=t sigue_pending=t
--   imp_update_directo_bloqueado=t
-- ════════════════════════════════════════════════════════════════════════════

DO $proof$
DECLARE
  t_id    UUID := 'ffff0000-0000-4000-8000-00000000003d';
  u_admin UUID := 'ffff0000-0000-4000-8000-00000000004d';
  c_id    UUID;
  s_id    UUID;
  o_id    UUID;
  claims_admin JSONB;

  imp_lee INT;
  imp_decide_bloqueado         BOOLEAN := false;
  imp_update_directo_bloqueado BOOLEAN := false;
  sigue_pending                BOOLEAN := false;
  v_outcome TEXT;
  v_status  TEXT;
BEGIN
  -- ── fixture ──────────────────────────────────────────────────────────────
  INSERT INTO public.tenants (id, name, slug, status, vertical)
  VALUES (t_id, '[3DPROOF] tenant', 'proof-3d-imp', 'active', 'real_estate');

  INSERT INTO auth.users (id) VALUES (u_admin);
  INSERT INTO public.platform_users (id, name, email, role, active)
  VALUES (u_admin, 'SA', 'sa@proof3d.test', 'super_admin', true);

  INSERT INTO public.contacts (tenant_id, phone, name)
  VALUES (t_id, '5490000003d01', 'Cliente') RETURNING id INTO c_id;

  INSERT INTO public.form_submissions
    (tenant_id, reference, intent, status, source, payload, idempotency_key,
     expires_at, contact_id)
  VALUES
    (t_id, 'SUB-3D3D3D', 'temporary_rental', 'submitted', 'public_site',
     '{"name":"Ana","check_in":"2026-10-15","check_out":"2026-10-20","adults":2}'::jsonb,
     gen_random_uuid(), NOW() + INTERVAL '1 day', c_id)
  RETURNING id INTO s_id;

  SELECT (public.confirm_submission_and_create_operation(s_id, t_id, c_id, NULL) ->> 'operation_id')::UUID
  INTO o_id;

  -- ── claims REALES del hook + sesión de impersonación real ────────────────
  claims_admin := public.custom_access_token_hook(jsonb_build_object(
    'user_id', u_admin::text,
    'claims',  jsonb_build_object('sub', u_admin::text, 'app_metadata', '{}'::jsonb)
  )) -> 'claims';

  INSERT INTO public.impersonation_sessions
    (platform_user_id, target_tenant_id, reason, started_at, ended_at)
  VALUES (u_admin, t_id, 'proof 3D', NOW(), NULL);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', claims_admin::text, true);

  -- LEE: la impersonación sigue sirviendo para soporte.
  SELECT count(*) INTO imp_lee FROM public.operation_requests WHERE id = o_id;

  -- DECIDE: no.
  SELECT public.decide_operation_request(o_id, 'confirmed', 'desde soporte') ->> 'outcome'
  INTO v_outcome;
  imp_decide_bloqueado := (v_outcome = 'platform_user_not_allowed');

  -- Y el UPDATE directo tampoco (queda cerrado desde la Fase 3C).
  BEGIN
    UPDATE public.operation_requests
    SET status = 'confirmed', decided_at = NOW(), decided_by = u_admin
    WHERE id = o_id;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    imp_update_directo_bloqueado := true;
  END;

  RESET ROLE;

  SELECT status INTO v_status FROM public.operation_requests WHERE id = o_id;
  sigue_pending := (v_status = 'pending');

  RAISE EXCEPTION 'RESULTADO imp_lee=% imp_decide_bloqueado=% (outcome=%) imp_update_directo_bloqueado=% sigue_pending=% (status=%)',
    imp_lee, imp_decide_bloqueado, v_outcome, imp_update_directo_bloqueado, sigue_pending, v_status;
END
$proof$;

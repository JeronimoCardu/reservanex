-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3C — confirmación atómica: submission → confirmed + operación pending
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── POR QUÉ UNA RPC (§15) ───────────────────────────────────────────────────
--
-- Antes de esta fase, el worker hacía dos escrituras separadas: marcar la
-- submission confirmed y (nuevo en 3C) crear la operación. Entre las dos hay
-- una ventana real: si el proceso muere, la red se corta o el segundo INSERT
-- falla, queda una submission "confirmada pero perdida" — el cliente ya
-- escuchó "confirmé tus datos" y no existe nada que la empresa pueda atender.
-- Eso es exactamente el estado que §22 prohíbe.
--
-- El cuerpo de una función plpgsql corre dentro de una transacción, así que
-- las dos escrituras son atómicas por construcción: o pasan las dos o no pasa
-- ninguna.
--
-- ── PATRÓN REUTILIZADO ──────────────────────────────────────────────────────
--
-- Se auditaron las RPC existentes antes de escribir esta:
--
--   · claim_ai_auto_reply_slot(p_conversation_id, p_tenant_id) — la que ya
--     llama el worker: SECURITY DEFINER, search_path fijo, tenant_id EXPLÍCITO
--     como parámetro (el worker usa el service role, así que auth_tenant_id()
--     sería NULL), grants solo a service_role. Ese es el molde que sigue esta.
--   · record_monthly_rental_payment(...) — RPC transaccional de negocio:
--     SELECT ... FOR UPDATE para lockear la fila, validaciones antes de
--     escribir, RETURNS jsonb. De ahí sale la estructura interna.
--
-- Diferencia deliberada con record_monthly_rental_payment: aquella usa
-- RAISE EXCEPTION para TODO. Acá los desenlaces de NEGOCIO esperables
-- (vencida, de otro contacto, cancelada, ya confirmada) se devuelven como un
-- código en 'outcome', no como excepción, porque el worker tiene que mapear
-- cada uno a un mensaje distinto para el cliente y parsear texto de error
-- sería frágil. Las condiciones realmente excepcionales sí levantan, y al
-- hacerlo revierten todo.
--
-- ── IDEMPOTENCIA (§4, §23) ──────────────────────────────────────────────────
--
-- Tres capas, de afuera hacia adentro:
--   1. FOR UPDATE sobre la submission serializa dos "Sí" simultáneos;
--   2. el guard status='submitted' hace que el segundo no re-confirme;
--   3. source_submission_id UNIQUE en la DB es la última palabra: aunque
--      fallaran las dos anteriores, la segunda inserción no puede existir.
--      Se captura unique_violation y se devuelve la operación existente.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.confirm_submission_and_create_operation(
  p_submission_id   UUID,
  p_tenant_id       UUID,
  p_contact_id      UUID,
  p_conversation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sub       record;
  v_kind      TEXT;
  v_op_id     UUID;
  v_existing  UUID;
  v_title     TEXT;
  v_date      DATE;
  v_end_date  DATE;
  v_time      TIME;
  v_payload   JSONB;
BEGIN
  -- Lock de la submission. Dos confirmaciones simultáneas se serializan acá:
  -- la segunda espera y encuentra status='confirmed', no 'submitted'.
  SELECT * INTO v_sub
  FROM public.form_submissions
  WHERE id = p_submission_id AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- El contacto tiene que ser el mismo que la tomó (§25 N).
  IF v_sub.contact_id IS NOT NULL AND v_sub.contact_id <> p_contact_id THEN
    RETURN jsonb_build_object('outcome', 'wrong_contact');
  END IF;

  -- Ya confirmada: devolver idempotentemente la operación existente (§15).
  IF v_sub.status = 'confirmed' THEN
    SELECT id INTO v_existing
    FROM public.operation_requests
    WHERE source_submission_id = p_submission_id;

    RETURN jsonb_build_object(
      'outcome',      'already_confirmed',
      'operation_id', v_existing,
      'confirmed_at', v_sub.confirmed_at
    );
  END IF;

  IF v_sub.status = 'cancelled' THEN
    RETURN jsonb_build_object('outcome', 'cancelled');
  END IF;

  IF v_sub.status = 'expired' OR v_sub.expires_at <= NOW() THEN
    -- Transición lazy, dentro de la misma transacción.
    UPDATE public.form_submissions SET status = 'expired'
    WHERE id = p_submission_id AND status IN ('draft','submitted');
    RETURN jsonb_build_object('outcome', 'expired');
  END IF;

  IF v_sub.status <> 'submitted' THEN
    RETURN jsonb_build_object('outcome', 'not_confirmable', 'status', v_sub.status);
  END IF;

  -- ── Mapeo intent → tipo de operación (§2, §C) ────────────────────────────
  v_kind := CASE v_sub.intent
    WHEN 'temporary_rental'       THEN 'reservation_request'
    WHEN 'property_visit'         THEN 'visit_request'
    WHEN 'table_reservation'      THEN 'table_request'
    WHEN 'food_order'             THEN 'order_request'
    WHEN 'property_inquiry'       THEN 'inquiry'
    WHEN 'monthly_rental_inquiry' THEN 'inquiry'
    WHEN 'general_inquiry'        THEN 'inquiry'
  END;

  IF v_kind IS NULL THEN
    -- Un intent que la DB acepta pero este mapeo no conoce. Se levanta a
    -- propósito: revierte todo y NO deja la submission confirmada sin
    -- operación (§22). Es preferible que el cliente reintente.
    RAISE EXCEPTION 'Intent sin mapeo a operación: %', v_sub.intent;
  END IF;

  v_payload := COALESCE(v_sub.payload, '{}'::jsonb);

  -- ── Campos operativos, solo los inequívocos ──────────────────────────────
  -- Nada se deriva ni se suma: se copian tal cual estaban en el payload ya
  -- validado por Zod. Un valor con formato inesperado deja el campo en NULL en
  -- vez de romper — el dato real sigue íntegro en payload_snapshot.
  BEGIN
    v_date := CASE v_sub.intent
      WHEN 'temporary_rental'       THEN (v_payload->>'check_in')::DATE
      WHEN 'property_visit'         THEN (v_payload->>'preferred_date')::DATE
      WHEN 'table_reservation'      THEN (v_payload->>'date')::DATE
      WHEN 'monthly_rental_inquiry' THEN (v_payload->>'move_in_date')::DATE
      ELSE NULL
    END;
  EXCEPTION WHEN others THEN v_date := NULL;
  END;

  BEGIN
    v_end_date := CASE v_sub.intent
      WHEN 'temporary_rental' THEN (v_payload->>'check_out')::DATE
      ELSE NULL
    END;
  EXCEPTION WHEN others THEN v_end_date := NULL;
  END;

  BEGIN
    v_time := CASE v_sub.intent
      WHEN 'table_reservation' THEN (v_payload->>'time')::TIME
      ELSE NULL
    END;
  EXCEPTION WHEN others THEN v_time := NULL;
  END;

  -- Snapshot del título de la publicación (§7/§14).
  IF v_sub.entity_type = 'property' AND v_sub.entity_id IS NOT NULL THEN
    SELECT title INTO v_title FROM public.properties WHERE id = v_sub.entity_id;
  END IF;

  -- ── Escritura 1: confirmar la submission ─────────────────────────────────
  UPDATE public.form_submissions
  SET status       = 'confirmed',
      confirmed_at = NOW(),
      contact_id   = COALESCE(contact_id, p_contact_id)
  WHERE id = p_submission_id AND status = 'submitted';

  IF NOT FOUND THEN
    -- Otra transacción ganó entremedio pese al lock. Fail-safe: no seguimos.
    RETURN jsonb_build_object('outcome', 'already_confirmed');
  END IF;

  -- ── Escritura 2: crear la operación PENDING ──────────────────────────────
  BEGIN
    INSERT INTO public.operation_requests (
      tenant_id, contact_id, conversation_id, source_submission_id,
      kind, intent, status,
      entity_type, entity_id, publication_ref, entity_title_snapshot,
      requested_date, requested_end_date, requested_time,
      payload_snapshot, customer_confirmed_at
    ) VALUES (
      p_tenant_id, p_contact_id, p_conversation_id, p_submission_id,
      v_kind, v_sub.intent, 'pending',
      v_sub.entity_type, v_sub.entity_id, v_sub.publication_ref, v_title,
      v_date, v_end_date, v_time,
      v_payload, NOW()
    )
    RETURNING id INTO v_op_id;
  EXCEPTION WHEN unique_violation THEN
    -- Última línea de defensa (§4): ya existía una operación para esta
    -- submission. Se devuelve esa, no se crea otra.
    SELECT id INTO v_op_id
    FROM public.operation_requests
    WHERE source_submission_id = p_submission_id;

    RETURN jsonb_build_object(
      'outcome', 'already_confirmed', 'operation_id', v_op_id
    );
  END;

  RETURN jsonb_build_object(
    'outcome',        'confirmed',
    'operation_id',   v_op_id,
    'operation_kind', v_kind,
    'intent',         v_sub.intent
  );
END;
$function$;

-- Solo el worker (service role). Ni anon ni authenticated: un usuario del CRM
-- no debe poder confirmar una submission en nombre del cliente.
REVOKE ALL ON FUNCTION public.confirm_submission_and_create_operation(UUID, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_submission_and_create_operation(UUID, UUID, UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.confirm_submission_and_create_operation(UUID, UUID, UUID, UUID) IS
  'Fase 3C: en UNA transacción marca la submission confirmed y crea su '
  'operation_request pending. Idempotente por source_submission_id UNIQUE. '
  'Devuelve outcome: confirmed | already_confirmed | not_found | wrong_contact '
  '| expired | cancelled | not_confirmable.';

-- ── admin_purge_tenant: incluir la tabla nueva ──────────────────────────────
-- Se regenera desde la definición viva insertando el DELETE al principio
-- (operation_requests referencia form_submissions, contacts y conversations,
-- las tres borradas más abajo, así que tiene que ir antes que todas).
DO $purge$
DECLARE
  v_def TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'admin_purge_tenant'
      AND p.prosrc LIKE '%operation_requests%'
  ) THEN
    RAISE NOTICE 'admin_purge_tenant ya contempla operation_requests';
    RETURN;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'admin_purge_tenant';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'No se encontró admin_purge_tenant';
  END IF;

  IF position('DELETE FROM public.reservation_events WHERE tenant_id = p_tenant_id;' IN v_def) = 0 THEN
    RAISE EXCEPTION 'El ancla esperada no está en admin_purge_tenant — abortando para no corromperla';
  END IF;

  v_def := replace(
    v_def,
    'DELETE FROM public.reservation_events WHERE tenant_id = p_tenant_id;',
    'DELETE FROM public.operation_requests WHERE tenant_id = p_tenant_id;'  || chr(10) ||
    '  GET DIAGNOSTICS v_n = ROW_COUNT;'                                    || chr(10) ||
    '  v_result := v_result || jsonb_build_object(''operation_requests'', v_n);' || chr(10) ||
    chr(10) ||
    '  DELETE FROM public.reservation_events WHERE tenant_id = p_tenant_id;'
  );

  EXECUTE v_def;
  RAISE NOTICE 'admin_purge_tenant regenerada incluyendo operation_requests';
END
$purge$;

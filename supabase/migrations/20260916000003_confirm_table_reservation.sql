-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C2 — confirmar reservas de mesa y su ciclo de vida
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── ARQUITECTURA DE RPC (misma que 3E-B2) ───────────────────────────────────
--
-- Confirmar ES decidir la solicitud: misma transacción, misma autorización,
-- mismo lock, mismo "sigue pending". Por eso vive dentro de
-- decide_operation_request con parámetros opcionales, y no en una RPC aparte
-- que tendría que reimplementar los seis pasos de autorización.
--
-- El riesgo de que otro kind reciba parámetros que no le corresponden se cierra
-- con guardas explícitas: fecha/hora solo para visit_request o table_request al
-- confirmar, y party_size SOLO para table_request. Cualquier otra combinación
-- devuelve invalid_parameters sin tocar nada.
--
-- El ciclo de vida (editar / completar / cancelar / no-show) sí son RPC
-- propias: operan sobre table_reservations, no sobre la solicitud.
--
-- ── AUTORIZACIÓN COMPARTIDA ─────────────────────────────────────────────────
--
-- Las cuatro RPC de ciclo de vida necesitan la misma respuesta a "¿quién sos y
-- podés gestionar reservas de mesa?". En 3E-B2 eso se resolvió con
-- visit_manager_context(), una función específica de visitas. Acá se generaliza:
-- tenant_actor_context(p_permission) hace lo mismo para CUALQUIER permiso.
--
-- visit_manager_context() se deja como está a propósito: funciona, está
-- cubierta por validate:visits y tocarla sería arriesgar una regresión de B2
-- sin ganar nada. Queda como el predecesor especializado de esta; si alguna vez
-- se unifican, es un refactor con sus propias pruebas.
--
-- ── QUÉ NO HACE ESTA FASE ───────────────────────────────────────────────────
--
-- Nada de food_order: sin catálogo, precios ni carrito no hay pedido que
-- materializar. order_request queda como el ÚLTIMO legacy de autorización, y
-- está anotado como tal en el mapa.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Contexto de actor, genérico por permiso ─────────────────────────────────
--
-- No se concede a nadie: solo se invoca desde funciones SECURITY DEFINER del
-- mismo dueño.
CREATE OR REPLACE FUNCTION public.tenant_actor_context(p_permission TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor   UUID;
  v_member  record;
  v_allowed BOOLEAN;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'unauthenticated');
  END IF;

  IF public.auth_user_type() = 'platform_user' THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'platform_user_not_allowed');
  END IF;

  SELECT tu.tenant_id, tu.role::TEXT AS role,
         tu.can_confirm_reservations, tu.can_manage_inquiries,
         tu.can_manage_visits, tu.can_manage_table_reservations
  INTO v_member
  FROM public.tenant_users tu
  WHERE tu.id = v_actor AND tu.active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'not_a_tenant_member');
  END IF;

  v_allowed := v_member.role = 'owner'
    OR (p_permission = 'can_manage_table_reservations' AND v_member.can_manage_table_reservations)
    OR (p_permission = 'can_manage_visits'             AND v_member.can_manage_visits)
    OR (p_permission = 'can_manage_inquiries'          AND v_member.can_manage_inquiries)
    OR (p_permission = 'can_confirm_reservations'      AND v_member.can_confirm_reservations);

  IF NOT v_allowed THEN
    RETURN jsonb_build_object(
      'ok', false, 'outcome', 'forbidden', 'required_permission', p_permission);
  END IF;

  RETURN jsonb_build_object('ok', true, 'actor', v_actor, 'tenant_id', v_member.tenant_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_actor_context(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_actor_context(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.tenant_actor_context(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.tenant_actor_context(TEXT) FROM service_role;

-- Otra vez: CREATE OR REPLACE con una firma distinta NO reemplaza, crea una
-- sobrecarga. Se dropea la firma de 3E-B2 antes de crear la nueva, para que no
-- queden dos funciones y las llamadas caigan en la vieja.
DROP FUNCTION IF EXISTS public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME);

CREATE OR REPLACE FUNCTION public.decide_operation_request(
  p_operation_id   UUID,
  p_action         TEXT,
  p_notes          TEXT DEFAULT NULL,
  p_scheduled_date DATE DEFAULT NULL,
  p_scheduled_time TIME DEFAULT NULL,
  -- Fase 3E-C2 — solo para reservas de mesa: la cantidad de personas ACORDADA,
  -- que puede diferir de la solicitada.
  p_party_size     INT  DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor    UUID;
  v_member   record;
  v_op       record;
  v_notes    TEXT;
  v_needs    TEXT;
  v_allowed  BOOLEAN;
  v_prop     record;
  v_elig     JSONB;
  v_avail    JSONB;
  v_quote    JSONB;
  v_moment   JSONB;
  v_when     TIMESTAMPTZ;
  v_start    DATE;
  v_end      DATE;
  v_guests   INT;
  v_hold     INT;
  v_res_id   UUID;
  v_visit_id UUID;
  v_table_id UUID;
  v_party    INT;
  v_existing UUID;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;

  IF public.auth_user_type() = 'platform_user' THEN
    RETURN jsonb_build_object('outcome', 'platform_user_not_allowed');
  END IF;

  SELECT tu.tenant_id, tu.role::TEXT AS role,
         tu.can_confirm_reservations, tu.can_manage_inquiries, tu.can_manage_visits,
         tu.can_manage_table_reservations
  INTO v_member
  FROM public.tenant_users tu
  WHERE tu.id = v_actor AND tu.active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_a_tenant_member');
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('confirmed', 'rejected') THEN
    RETURN jsonb_build_object('outcome', 'invalid_action');
  END IF;

  v_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');
  IF v_notes IS NOT NULL THEN
    IF length(v_notes) > 500 THEN
      RETURN jsonb_build_object('outcome', 'notes_too_long', 'max_length', 500);
    END IF;
    IF v_notes ~ '<[^>]+>' THEN
      RETURN jsonb_build_object('outcome', 'notes_invalid');
    END IF;
  END IF;

  SELECT o.* INTO v_op
  FROM public.operation_requests o
  WHERE o.id = p_operation_id AND o.tenant_id = v_member.tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- ── Autorización según el KIND real de la solicitud (§19) ───────────────
  -- §9 — mapa final. order_request es el ÚLTIMO legacy: los pedidos quedan
  -- bloqueados hasta que exista catálogo, pricing y carrito, así que darles un
  -- permiso propio ahora sería elegirlo antes de saber qué gobierna.
  v_needs := CASE v_op.kind
    WHEN 'inquiry'       THEN 'can_manage_inquiries'
    WHEN 'visit_request' THEN 'can_manage_visits'
    WHEN 'table_request' THEN 'can_manage_table_reservations'
    ELSE 'can_confirm_reservations'   -- reservation_request + order_request (legacy)
  END;

  v_allowed := v_member.role = 'owner'
           OR (v_needs = 'can_manage_inquiries'          AND v_member.can_manage_inquiries)
           OR (v_needs = 'can_manage_visits'             AND v_member.can_manage_visits)
           OR (v_needs = 'can_manage_table_reservations' AND v_member.can_manage_table_reservations)
           OR (v_needs = 'can_confirm_reservations'      AND v_member.can_confirm_reservations);

  IF NOT v_allowed THEN
    RETURN jsonb_build_object(
      'outcome', 'forbidden', 'kind', v_op.kind, 'required_permission', v_needs);
  END IF;

  -- ── Guarda de parámetros (§7) ───────────────────────────────────────────
  -- Los parámetros de visita SOLO se aceptan al confirmar una visit_request.
  -- Mandarlos en cualquier otro caso es un error del caller, no algo a ignorar
  -- en silencio: si alguien intenta agendar al rechazar, o pasarle una hora a
  -- una reserva, se corta acá sin tocar nada.
  IF (p_scheduled_date IS NOT NULL OR p_scheduled_time IS NOT NULL)
     AND NOT (v_op.kind IN ('visit_request', 'table_request') AND p_action = 'confirmed')
  THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_parameters',
      'detail',  'la fecha y hora solo aplican al agendar una visita o confirmar una reserva de mesa');
  END IF;

  IF p_party_size IS NOT NULL
     AND NOT (v_op.kind = 'table_request' AND p_action = 'confirmed')
  THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_parameters',
      'detail',  'la cantidad de personas solo aplica al confirmar una reserva de mesa');
  END IF;

  IF v_op.status <> 'pending' THEN
    SELECT id INTO v_existing
    FROM public.reservations WHERE source_operation_request_id = p_operation_id;

    SELECT id INTO v_visit_id
    FROM public.property_visits WHERE source_operation_request_id = p_operation_id;

    SELECT id INTO v_table_id
    FROM public.table_reservations WHERE source_operation_request_id = p_operation_id;

    RETURN jsonb_build_object(
      'outcome',        'already_decided',
      'table_reservation_id', v_table_id,
      'status',         v_op.status,
      'decided_at',     v_op.decided_at,
      'decided_by',     v_op.decided_by,
      'decision_notes', v_op.decision_notes,
      'reservation_id', v_existing,
      'visit_id',       v_visit_id
    );
  END IF;

  -- ══ Materialización A — temporary_rental aprobada → reserva ═════════════
  IF p_action = 'confirmed'
     AND v_op.kind   = 'reservation_request'
     AND v_op.intent = 'temporary_rental'
  THEN
    IF v_op.entity_type IS DISTINCT FROM 'property' OR v_op.entity_id IS NULL THEN
      RETURN jsonb_build_object('outcome', 'missing_reservation_context', 'reason', 'no_property');
    END IF;

    SELECT p.id, p.currency, p.pricing_mode, p.deleted_at
    INTO v_prop
    FROM public.properties p
    WHERE p.id = v_op.entity_id AND p.tenant_id = v_member.tenant_id
    FOR UPDATE;

    IF NOT FOUND OR v_prop.deleted_at IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'missing_reservation_context', 'reason', 'property_not_found');
    END IF;

    v_start := v_op.requested_date;
    v_end   := v_op.requested_end_date;

    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
      RETURN jsonb_build_object('outcome', 'invalid_dates');
    END IF;

    IF v_start < (NOW() AT TIME ZONE 'UTC')::DATE THEN
      RETURN jsonb_build_object(
        'outcome', 'past_start_date', 'requested_date', v_start,
        'today', (NOW() AT TIME ZONE 'UTC')::DATE);
    END IF;

    v_guests := COALESCE((v_op.payload_snapshot->>'adults')::INT, 0)
              + COALESCE((v_op.payload_snapshot->>'children')::INT, 0)
              + COALESCE((v_op.payload_snapshot->>'infants')::INT, 0);
    IF v_guests < 1 THEN v_guests := 1; END IF;

    v_elig := public.check_temporary_rental_eligibility(
      v_member.tenant_id, v_prop.id, v_start, v_end, v_guests);

    IF (v_elig->>'eligible')::BOOLEAN IS NOT TRUE THEN
      RETURN jsonb_build_object('outcome', 'ineligible') || (v_elig - 'eligible');
    END IF;

    v_avail := public.temporary_rental_dates_available(
      v_member.tenant_id, v_prop.id, v_start, v_end);

    IF (v_avail->>'available')::BOOLEAN IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'outcome',         'availability_conflict',
        'conflict_source', v_avail->>'conflict_source',
        'conflict_id',     v_avail->>'conflict_id'
      );
    END IF;

    SELECT COALESCE(s.pending_reservation_hold_minutes, 1440) INTO v_hold
    FROM public.ai_settings s WHERE s.tenant_id = v_member.tenant_id;
    v_hold := COALESCE(v_hold, 1440);

    v_quote := public.quote_temporary_rental(v_member.tenant_id, v_prop.id, v_start, v_end);

    IF (v_quote->>'ok')::BOOLEAN IS NOT TRUE THEN
      RETURN jsonb_build_object('outcome', 'pricing_failed', 'reason', v_quote->>'reason');
    END IF;

    BEGIN
      INSERT INTO public.reservations (
        tenant_id, contact_id, property_id, conversation_id,
        start_date, end_date, guests,
        status, source, source_operation_request_id,
        expires_at, currency, price_currency, pricing_mode_snapshot,
        nights_count, nightly_price_snapshot, subtotal_amount,
        fees_amount, total_amount, deposit_required_amount, pricing_breakdown,
        customer_notes
      ) VALUES (
        v_member.tenant_id, v_op.contact_id, v_prop.id, v_op.conversation_id,
        v_start, v_end, v_guests,
        'pre_reserved', 'form', p_operation_id,
        NOW() + (v_hold || ' minutes')::INTERVAL,
        v_quote->>'currency', v_quote->>'currency', v_quote->>'pricing_mode',
        (v_quote->>'nights')::INT,
        (v_quote->>'nightly_price')::NUMERIC,
        (v_quote->>'subtotal')::NUMERIC,
        COALESCE((v_quote->>'fees')::NUMERIC, 0),
        (v_quote->>'total')::NUMERIC,
        (v_quote->>'deposit')::NUMERIC,
        COALESCE(v_quote->'breakdown', '{}'::JSONB),
        NULLIF(btrim(COALESCE(v_op.payload_snapshot->>'notes', '')), '')
      )
      RETURNING id INTO v_res_id;
    EXCEPTION WHEN exclusion_violation THEN
      RETURN jsonb_build_object(
        'outcome',         'availability_conflict',
        'conflict_source', 'race',
        'detail',          'otro proceso ocupó las fechas mientras se aprobaba'
      );
    END;

    INSERT INTO public.reservation_events (tenant_id, reservation_id, actor_id, event_type, metadata)
    VALUES (
      v_member.tenant_id, v_res_id, v_actor, 'form_approved',
      jsonb_build_object(
        'source', 'form', 'operation_request_id', p_operation_id,
        'intent', v_op.intent, 'decided_by', v_actor,
        'pricing_mode', v_quote->>'pricing_mode',
        'total_amount', v_quote->'total',
        'price_currency', v_quote->>'currency'
      )
    );
  END IF;

  -- ══ Materialización B — visit_request aprobada → visita agendada ════════
  IF p_action = 'confirmed' AND v_op.kind = 'visit_request' THEN

    -- §9 — contexto de propiedad inequívoco. Nunca se inventa un property_id
    -- ni se "arregla" la solicitud automáticamente.
    IF v_op.entity_type IS DISTINCT FROM 'property' OR v_op.entity_id IS NULL THEN
      RETURN jsonb_build_object('outcome', 'missing_visit_context', 'reason', 'no_property');
    END IF;

    -- §10 — el mínimo y nada más: existe, es del tenant, no está eliminada.
    SELECT p.id, p.deleted_at
    INTO v_prop
    FROM public.properties p
    WHERE p.id = v_op.entity_id AND p.tenant_id = v_member.tenant_id;

    IF NOT FOUND OR v_prop.deleted_at IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'missing_visit_context', 'reason', 'property_not_found');
    END IF;

    IF p_scheduled_date IS NULL OR p_scheduled_time IS NULL THEN
      RETURN jsonb_build_object(
        'outcome', 'visit_schedule_required',
        'detail',  'agendar una visita exige fecha y hora concretas');
    END IF;

    v_moment := public.resolve_tenant_local_instant(
      v_member.tenant_id, p_scheduled_date, p_scheduled_time);

    IF (v_moment->>'ok')::BOOLEAN IS NOT TRUE THEN
      RETURN jsonb_build_object('outcome', 'invalid_schedule') || (v_moment - 'ok');
    END IF;

    v_when := (v_moment->>'instant')::TIMESTAMPTZ;

    -- §8 — una visita nueva no se agenda en el pasado. Distinto de la carga
    -- retroactiva de reservations: acá se está acordando algo que va a pasar.
    IF v_when <= NOW() THEN
      RETURN jsonb_build_object(
        'outcome',       'scheduled_time_in_past',
        'scheduled_for', v_when,
        'now',           NOW(),
        'timezone',      v_moment->>'timezone');
    END IF;

    INSERT INTO public.property_visits (
      tenant_id, contact_id, property_id, source_operation_request_id,
      scheduled_for, timezone_snapshot, status, scheduled_by
    ) VALUES (
      v_member.tenant_id, v_op.contact_id, v_prop.id, p_operation_id,
      v_when, v_moment->>'timezone', 'scheduled', v_actor
    )
    RETURNING id INTO v_visit_id;
  END IF;

  -- ══ Materialización C — table_request confirmada → reserva de mesa ══════
  IF p_action = 'confirmed' AND v_op.kind = 'table_request' THEN

    -- Una reserva de mesa NO necesita entity: un restaurante no tiene
    -- properties. Lo que sí necesita es cuándo y para cuántos.
    IF p_scheduled_date IS NULL OR p_scheduled_time IS NULL THEN
      RETURN jsonb_build_object(
        'outcome', 'table_schedule_required',
        'detail',  'confirmar una reserva exige fecha y hora acordadas');
    END IF;

    -- §6 — el party_size ACORDADO. Si no se manda, se toma el solicitado: el
    -- caso más común es confirmar tal cual lo que pidió el cliente.
    v_party := COALESCE(p_party_size, (v_op.payload_snapshot->>'people')::INT);

    IF v_party IS NULL OR v_party < 1 OR v_party > 50 THEN
      RETURN jsonb_build_object(
        'outcome',    'invalid_party_size',
        'party_size', v_party,
        'detail',     'la cantidad de personas tiene que estar entre 1 y 50');
    END IF;

    -- §3 — mismo helper canónico que usan las visitas. No hay una segunda
    -- implementación de conversión de zona horaria.
    v_moment := public.resolve_tenant_local_instant(
      v_member.tenant_id, p_scheduled_date, p_scheduled_time);

    IF (v_moment->>'ok')::BOOLEAN IS NOT TRUE THEN
      RETURN jsonb_build_object('outcome', 'invalid_schedule') || (v_moment - 'ok');
    END IF;

    v_when := (v_moment->>'instant')::TIMESTAMPTZ;

    -- §7 — la ÚNICA regla temporal de V1. No se valida horario comercial
    -- porque tenants.business_hours es texto libre que nadie parsea.
    IF v_when <= NOW() THEN
      RETURN jsonb_build_object(
        'outcome',       'scheduled_time_in_past',
        'scheduled_for', v_when,
        'now',           NOW(),
        'timezone',      v_moment->>'timezone');
    END IF;

    INSERT INTO public.table_reservations (
      tenant_id, contact_id, source_operation_request_id,
      scheduled_for, timezone_snapshot, party_size, status, confirmed_by
    ) VALUES (
      v_member.tenant_id, v_op.contact_id, p_operation_id,
      v_when, v_moment->>'timezone', v_party, 'confirmed', v_actor
    )
    RETURNING id INTO v_table_id;
  END IF;

  UPDATE public.operation_requests
  SET status         = p_action,
      decided_at     = NOW(),
      decided_by     = v_actor,
      decision_notes = v_notes
  WHERE id = p_operation_id
    AND tenant_id = v_member.tenant_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'already_decided');
  END IF;

  RETURN jsonb_build_object(
    'outcome',               p_action,
    'decided_at',            NOW(),
    'decided_by',            v_actor,
    'reservation_id',        v_res_id,
    'visit_id',              v_visit_id,
    'table_reservation_id',  v_table_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME, INT) FROM anon;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME, INT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME, INT) TO authenticated;
-- ════════════════════════════════════════════════════════════════════════════
-- Ciclo de vida de la reserva de mesa (§11–§15)
-- ════════════════════════════════════════════════════════════════════════════
--
--   confirmed → completed   (realizada)
--   confirmed → cancelled   (cancelada, con motivo opcional)
--   confirmed → no_show     (el cliente no se presentó)
--   confirmed → confirmed   (editar fecha, hora y/o cantidad de personas)
--
-- Los tres terminales son definitivos: no se reabren, no se editan y no cambian
-- entre sí. Repetir una transición terminal devuelve un outcome controlado sin
-- reescribir actor ni timestamp.
--
-- Ninguna de estas operaciones toca operation_requests: el restaurante SÍ había
-- aceptado la solicitud, y cancelar o marcar ausencia es un hecho posterior de
-- la reserva, no una reescritura de esa decisión.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Editar / reagendar (§12) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.edit_table_reservation(
  p_reservation_id UUID,
  p_scheduled_date DATE,
  p_scheduled_time TIME,
  p_party_size     INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx    JSONB;
  v_res    record;
  v_moment JSONB;
  v_when   TIMESTAMPTZ;
  v_party  INT;
BEGIN
  v_ctx := public.tenant_actor_context('can_manage_table_reservations');
  IF (v_ctx->>'ok')::BOOLEAN IS NOT TRUE THEN RETURN v_ctx - 'ok'; END IF;

  SELECT r.* INTO v_res
  FROM public.table_reservations r
  WHERE r.id = p_reservation_id AND r.tenant_id = (v_ctx->>'tenant_id')::UUID
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- §11 — solo se edita lo que sigue confirmado.
  IF v_res.status <> 'confirmed' THEN
    RETURN jsonb_build_object('outcome', 'not_editable', 'status', v_res.status);
  END IF;

  -- Sin party_size nuevo se conserva el vigente: se puede mover solo el horario.
  v_party := COALESCE(p_party_size, v_res.party_size);
  IF v_party < 1 OR v_party > 50 THEN
    RETURN jsonb_build_object('outcome', 'invalid_party_size', 'party_size', v_party);
  END IF;

  v_moment := public.resolve_tenant_local_instant(
    (v_ctx->>'tenant_id')::UUID, p_scheduled_date, p_scheduled_time);

  IF (v_moment->>'ok')::BOOLEAN IS NOT TRUE THEN
    RETURN jsonb_build_object('outcome', 'invalid_schedule') || (v_moment - 'ok');
  END IF;

  v_when := (v_moment->>'instant')::TIMESTAMPTZ;

  IF v_when <= NOW() THEN
    RETURN jsonb_build_object(
      'outcome', 'scheduled_time_in_past', 'scheduled_for', v_when, 'now', NOW());
  END IF;

  -- source_operation_request_id NO se toca: la reserva sigue siendo la misma, y
  -- lo que pidió el cliente tampoco cambia. El cambio queda auditado por
  -- trg_audit_table_reservations (old_value → new_value).
  UPDATE public.table_reservations
  SET scheduled_for     = v_when,
      timezone_snapshot = v_moment->>'timezone',
      party_size        = v_party
  WHERE id = p_reservation_id;

  RETURN jsonb_build_object(
    'outcome',                'edited',
    'reservation_id',         p_reservation_id,
    'previous_scheduled_for', v_res.scheduled_for,
    'previous_party_size',    v_res.party_size,
    'scheduled_for',          v_when,
    'party_size',             v_party,
    'timezone',               v_moment->>'timezone'
  );
END;
$function$;

-- ── Completar (§13) ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_table_reservation(p_reservation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx JSONB;
  v_res record;
BEGIN
  v_ctx := public.tenant_actor_context('can_manage_table_reservations');
  IF (v_ctx->>'ok')::BOOLEAN IS NOT TRUE THEN RETURN v_ctx - 'ok'; END IF;

  SELECT r.* INTO v_res
  FROM public.table_reservations r
  WHERE r.id = p_reservation_id AND r.tenant_id = (v_ctx->>'tenant_id')::UUID
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;

  IF v_res.status = 'completed' THEN
    RETURN jsonb_build_object('outcome', 'already_completed',
      'completed_at', v_res.completed_at, 'completed_by', v_res.completed_by);
  END IF;

  IF v_res.status <> 'confirmed' THEN
    RETURN jsonb_build_object('outcome', 'invalid_transition',
      'status', v_res.status, 'target', 'completed');
  END IF;

  UPDATE public.table_reservations
  SET status = 'completed', completed_at = NOW(), completed_by = (v_ctx->>'actor')::UUID
  WHERE id = p_reservation_id;

  RETURN jsonb_build_object('outcome', 'completed',
    'reservation_id', p_reservation_id, 'completed_at', NOW());
END;
$function$;

-- ── Cancelar (§14) ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_table_reservation(
  p_reservation_id UUID,
  p_reason         TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx    JSONB;
  v_res    record;
  v_reason TEXT;
BEGIN
  v_ctx := public.tenant_actor_context('can_manage_table_reservations');
  IF (v_ctx->>'ok')::BOOLEAN IS NOT TRUE THEN RETURN v_ctx - 'ok'; END IF;

  -- Mismo límite y misma validación que decision_notes y las visitas.
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NOT NULL THEN
    IF length(v_reason) > 500 THEN
      RETURN jsonb_build_object('outcome', 'reason_too_long', 'max_length', 500);
    END IF;
    IF v_reason ~ '<[^>]+>' THEN
      RETURN jsonb_build_object('outcome', 'reason_invalid');
    END IF;
  END IF;

  SELECT r.* INTO v_res
  FROM public.table_reservations r
  WHERE r.id = p_reservation_id AND r.tenant_id = (v_ctx->>'tenant_id')::UUID
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;

  IF v_res.status = 'cancelled' THEN
    RETURN jsonb_build_object('outcome', 'already_cancelled',
      'cancelled_at', v_res.cancelled_at, 'cancelled_by', v_res.cancelled_by);
  END IF;

  IF v_res.status <> 'confirmed' THEN
    RETURN jsonb_build_object('outcome', 'invalid_transition',
      'status', v_res.status, 'target', 'cancelled');
  END IF;

  -- §14 — NO se toca operation_requests.status.
  UPDATE public.table_reservations
  SET status = 'cancelled', cancelled_at = NOW(),
      cancelled_by = (v_ctx->>'actor')::UUID, cancellation_reason = v_reason
  WHERE id = p_reservation_id;

  RETURN jsonb_build_object('outcome', 'cancelled',
    'reservation_id', p_reservation_id, 'cancelled_at', NOW());
END;
$function$;

-- ── No-show (§15) ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_table_reservation_no_show(p_reservation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx JSONB;
  v_res record;
BEGIN
  v_ctx := public.tenant_actor_context('can_manage_table_reservations');
  IF (v_ctx->>'ok')::BOOLEAN IS NOT TRUE THEN RETURN v_ctx - 'ok'; END IF;

  SELECT r.* INTO v_res
  FROM public.table_reservations r
  WHERE r.id = p_reservation_id AND r.tenant_id = (v_ctx->>'tenant_id')::UUID
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;

  IF v_res.status = 'no_show' THEN
    RETURN jsonb_build_object('outcome', 'already_no_show',
      'no_show_at', v_res.no_show_at, 'no_show_by', v_res.no_show_by);
  END IF;

  IF v_res.status <> 'confirmed' THEN
    RETURN jsonb_build_object('outcome', 'invalid_transition',
      'status', v_res.status, 'target', 'no_show');
  END IF;

  UPDATE public.table_reservations
  SET status = 'no_show', no_show_at = NOW(), no_show_by = (v_ctx->>'actor')::UUID
  WHERE id = p_reservation_id;

  RETURN jsonb_build_object('outcome', 'no_show',
    'reservation_id', p_reservation_id, 'no_show_at', NOW());
END;
$function$;

DO $$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.edit_table_reservation(UUID, DATE, TIME, INT)',
    'public.complete_table_reservation(UUID)',
    'public.cancel_table_reservation(UUID, TEXT)',
    'public.mark_table_reservation_no_show(UUID)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END $$;

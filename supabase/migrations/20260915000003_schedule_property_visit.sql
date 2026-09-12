-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-B2 — agendar visitas y su ciclo de vida
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── ARQUITECTURA DE RPC ELEGIDA (§7) ────────────────────────────────────────
--
-- Se evaluaron las tres opciones:
--
--   A. Extender decide_operation_request con parámetros opcionales.
--   B. Una RPC aparte para agendar visit_request.
--   C. Helper SQL privado común.
--
-- Se eligió **A para agendar** y **C para el ciclo de vida**, por una razón
-- concreta: agendar ES decidir la solicitud. Son la misma transacción, con la
-- misma autorización, el mismo lock y la misma verificación de "sigue pending".
-- Separarla en una RPC propia (B) obligaría a reimplementar los seis pasos de
-- autorización de decide_operation_request, y §7 pide justamente no tener dos
-- funciones divergentes haciendo lo mismo.
--
-- El riesgo de A —que otro kind reciba parámetros de visita por accidente— se
-- cierra con una guarda explícita: si llegan p_scheduled_date/p_scheduled_time
-- y NO es una visit_request que se está confirmando, la función devuelve
-- 'invalid_parameters' y no hace nada.
--
-- El ciclo de vida (reagendar/completar/cancelar) sí son RPC propias: operan
-- sobre property_visits, no sobre la solicitud, y su autorización es otra. Para
-- que esa autorización exista UNA sola vez se extrajo visit_manager_context().
--
-- ── CUIDADO CON LA SOBRECARGA ───────────────────────────────────────────────
--
-- CREATE OR REPLACE con una firma distinta NO reemplaza: crea una sobrecarga.
-- Quedarían decide_operation_request(UUID,TEXT,TEXT) y
-- decide_operation_request(UUID,TEXT,TEXT,DATE,TIME) conviviendo, y las
-- llamadas de tres argumentos seguirían cayendo en la vieja —la que no conoce
-- can_manage_visits ni agenda visitas—. Por eso la firma anterior se DROPEA
-- explícitamente antes de crear la nueva.
--
-- ── MAPA DE AUTORIZACIÓN FINAL DE real_estate (§19) ─────────────────────────
--
--   reservation_request → owner OR can_confirm_reservations
--   inquiry             → owner OR can_manage_inquiries
--   visit_request       → owner OR can_manage_visits        ← esta fase
--   table_request       → owner OR can_confirm_reservations  (legacy, 3E-C)
--   order_request       → owner OR can_confirm_reservations  (legacy, 3E-C)
--
-- Sin fallback entre permisos: tener can_confirm_reservations ya no habilita
-- absolutamente nada de visitas.
--
-- ── ESTADO COMERCIAL DE LA PROPIEDAD (§10) — DECISIÓN ───────────────────────
--
-- NO se reutiliza check_temporary_rental_eligibility, y no es por comodidad:
-- sus reglas son de una ESTADÍA. Estadía mínima no significa nada para una
-- visita (una visita no dura noches), capacidad tampoco (no se aloja nadie), y
-- operation_type = temporary_rental excluiría visitar una propiedad en venta,
-- que es el caso más común de una inmobiliaria.
--
-- ¿Debería una propiedad vendida/alquilada/pausada/despublicada impedir
-- agendar? En el producto NO existe hoy ninguna regla que lo diga, y esta fase
-- no inventa reglas. Además hay casos legítimos: mostrar una propiedad ya
-- reservada a un interesado en lista de espera, o coordinar la visita de
-- entrega de una alquilada.
--
-- Se aplica entonces el mínimo que §10 fija: la propiedad debe existir,
-- pertenecer al tenant y no estar eliminada. Nada más.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Helper de autorización para el ciclo de vida (§7 opción C) ──────────────
--
-- Una sola implementación de "quién sos y podés gestionar visitas", usada por
-- las tres RPC de ciclo de vida. No se concede a nadie: solo se invoca desde
-- funciones SECURITY DEFINER del mismo dueño.
CREATE OR REPLACE FUNCTION public.visit_manager_context()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor  UUID;
  v_member record;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'unauthenticated');
  END IF;

  IF public.auth_user_type() = 'platform_user' THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'platform_user_not_allowed');
  END IF;

  SELECT tu.tenant_id, tu.role::TEXT AS role, tu.can_manage_visits
  INTO v_member
  FROM public.tenant_users tu
  WHERE tu.id = v_actor AND tu.active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'not_a_tenant_member');
  END IF;

  IF NOT (v_member.role = 'owner' OR v_member.can_manage_visits) THEN
    RETURN jsonb_build_object(
      'ok', false, 'outcome', 'forbidden', 'required_permission', 'can_manage_visits');
  END IF;

  RETURN jsonb_build_object('ok', true, 'actor', v_actor, 'tenant_id', v_member.tenant_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.visit_manager_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.visit_manager_context() FROM anon;
REVOKE ALL ON FUNCTION public.visit_manager_context() FROM authenticated;
REVOKE ALL ON FUNCTION public.visit_manager_context() FROM service_role;

-- ── Helper de resolución de instante (§4) ───────────────────────────────────
--
-- Fecha local + hora local + zona del tenant → instante real. Una sola
-- implementación, usada al agendar y al reagendar, para que no haya dos formas
-- de interpretar la misma hora.
CREATE OR REPLACE FUNCTION public.resolve_tenant_local_instant(
  p_tenant_id UUID,
  p_date      DATE,
  p_time      TIME
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz TEXT;
BEGIN
  IF p_date IS NULL OR p_time IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_date_or_time');
  END IF;

  SELECT NULLIF(btrim(t.timezone), '') INTO v_tz
  FROM public.tenants t WHERE t.id = p_tenant_id;

  IF v_tz IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tenant_without_timezone');
  END IF;

  -- Se valida contra el catálogo real de PostgreSQL. Un nombre inválido haría
  -- fallar AT TIME ZONE con un error crudo; mejor un outcome controlado.
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = v_tz) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_tenant_timezone', 'timezone', v_tz);
  END IF;

  RETURN jsonb_build_object(
    'ok',       true,
    'timezone', v_tz,
    'instant',  (p_date + p_time) AT TIME ZONE v_tz
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_tenant_local_instant(UUID, DATE, TIME) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_tenant_local_instant(UUID, DATE, TIME) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_tenant_local_instant(UUID, DATE, TIME) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_tenant_local_instant(UUID, DATE, TIME) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- decide_operation_request — ahora también agenda visitas
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.decide_operation_request(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.decide_operation_request(
  p_operation_id   UUID,
  p_action         TEXT,
  p_notes          TEXT DEFAULT NULL,
  p_scheduled_date DATE DEFAULT NULL,
  p_scheduled_time TIME DEFAULT NULL
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
         tu.can_confirm_reservations, tu.can_manage_inquiries, tu.can_manage_visits
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
  v_needs := CASE v_op.kind
    WHEN 'inquiry'       THEN 'can_manage_inquiries'
    WHEN 'visit_request' THEN 'can_manage_visits'
    ELSE 'can_confirm_reservations'   -- reservation_request + gastronomía (legacy)
  END;

  v_allowed := v_member.role = 'owner'
           OR (v_needs = 'can_manage_inquiries'     AND v_member.can_manage_inquiries)
           OR (v_needs = 'can_manage_visits'        AND v_member.can_manage_visits)
           OR (v_needs = 'can_confirm_reservations' AND v_member.can_confirm_reservations);

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
     AND NOT (v_op.kind = 'visit_request' AND p_action = 'confirmed')
  THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_parameters',
      'detail',  'la fecha y hora de agenda solo aplican al agendar una visita');
  END IF;

  IF v_op.status <> 'pending' THEN
    SELECT id INTO v_existing
    FROM public.reservations WHERE source_operation_request_id = p_operation_id;

    SELECT id INTO v_visit_id
    FROM public.property_visits WHERE source_operation_request_id = p_operation_id;

    RETURN jsonb_build_object(
      'outcome',        'already_decided',
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
    'outcome',        p_action,
    'decided_at',     NOW(),
    'decided_by',     v_actor,
    'reservation_id', v_res_id,
    'visit_id',       v_visit_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME) FROM anon;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME) FROM service_role;
GRANT EXECUTE ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT, DATE, TIME) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- Ciclo de vida de la visita (§12, §13, §14, §15)
-- ════════════════════════════════════════════════════════════════════════════

-- ── Reagendar ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reschedule_property_visit(
  p_visit_id       UUID,
  p_scheduled_date DATE,
  p_scheduled_time TIME
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx    JSONB;
  v_visit  record;
  v_moment JSONB;
  v_when   TIMESTAMPTZ;
BEGIN
  v_ctx := public.visit_manager_context();
  IF (v_ctx->>'ok')::BOOLEAN IS NOT TRUE THEN RETURN v_ctx - 'ok'; END IF;

  SELECT v.* INTO v_visit
  FROM public.property_visits v
  WHERE v.id = p_visit_id AND v.tenant_id = (v_ctx->>'tenant_id')::UUID
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- §12 — solo se reagenda lo que sigue agendado. Una visita realizada o
  -- cancelada no vuelve a scheduled.
  IF v_visit.status <> 'scheduled' THEN
    RETURN jsonb_build_object('outcome', 'not_reschedulable', 'status', v_visit.status);
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

  -- source_operation_request_id NO se toca: la visita sigue siendo la misma, y
  -- la preferencia original del cliente tampoco cambia. El cambio de horario
  -- queda auditado por trg_audit_property_visits (old_value → new_value).
  UPDATE public.property_visits
  SET scheduled_for     = v_when,
      timezone_snapshot = v_moment->>'timezone'
  WHERE id = p_visit_id;

  RETURN jsonb_build_object(
    'outcome',            'rescheduled',
    'visit_id',           p_visit_id,
    'previous_scheduled_for', v_visit.scheduled_for,
    'scheduled_for',      v_when,
    'timezone',           v_moment->>'timezone'
  );
END;
$function$;

-- ── Completar ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_property_visit(p_visit_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx   JSONB;
  v_visit record;
BEGIN
  v_ctx := public.visit_manager_context();
  IF (v_ctx->>'ok')::BOOLEAN IS NOT TRUE THEN RETURN v_ctx - 'ok'; END IF;

  SELECT v.* INTO v_visit
  FROM public.property_visits v
  WHERE v.id = p_visit_id AND v.tenant_id = (v_ctx->>'tenant_id')::UUID
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Idempotencia: repetir la acción no reescribe quién ni cuándo la completó.
  IF v_visit.status = 'completed' THEN
    RETURN jsonb_build_object(
      'outcome', 'already_completed',
      'completed_at', v_visit.completed_at, 'completed_by', v_visit.completed_by);
  END IF;

  IF v_visit.status <> 'scheduled' THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_transition', 'status', v_visit.status, 'target', 'completed');
  END IF;

  UPDATE public.property_visits
  SET status       = 'completed',
      completed_at = NOW(),
      completed_by = (v_ctx->>'actor')::UUID
  WHERE id = p_visit_id;

  RETURN jsonb_build_object('outcome', 'completed', 'visit_id', p_visit_id, 'completed_at', NOW());
END;
$function$;

-- ── Cancelar ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_property_visit(
  p_visit_id UUID,
  p_reason   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx    JSONB;
  v_visit  record;
  v_reason TEXT;
BEGIN
  v_ctx := public.visit_manager_context();
  IF (v_ctx->>'ok')::BOOLEAN IS NOT TRUE THEN RETURN v_ctx - 'ok'; END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NOT NULL THEN
    IF length(v_reason) > 500 THEN
      RETURN jsonb_build_object('outcome', 'reason_too_long', 'max_length', 500);
    END IF;
    IF v_reason ~ '<[^>]+>' THEN
      RETURN jsonb_build_object('outcome', 'reason_invalid');
    END IF;
  END IF;

  SELECT v.* INTO v_visit
  FROM public.property_visits v
  WHERE v.id = p_visit_id AND v.tenant_id = (v_ctx->>'tenant_id')::UUID
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_visit.status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'outcome', 'already_cancelled',
      'cancelled_at', v_visit.cancelled_at, 'cancelled_by', v_visit.cancelled_by);
  END IF;

  IF v_visit.status <> 'scheduled' THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_transition', 'status', v_visit.status, 'target', 'cancelled');
  END IF;

  -- §15 — NO se toca operation_requests.status. La empresa sí había agendado
  -- esa solicitud; cancelar la cita es un evento posterior de la visita, no una
  -- reescritura de la decisión original.
  UPDATE public.property_visits
  SET status              = 'cancelled',
      cancelled_at        = NOW(),
      cancelled_by        = (v_ctx->>'actor')::UUID,
      cancellation_reason = v_reason
  WHERE id = p_visit_id;

  RETURN jsonb_build_object('outcome', 'cancelled', 'visit_id', p_visit_id, 'cancelled_at', NOW());
END;
$function$;

DO $$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.reschedule_property_visit(UUID, DATE, TIME)',
    'public.complete_property_visit(UUID)',
    'public.cancel_property_visit(UUID, TEXT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3B0 — order_request pasa a can_manage_orders
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── MISMA FIRMA, SIN OVERLOAD ───────────────────────────────────────────────
--
-- Auditado antes de escribir esto: la base tiene UNA sola firma,
--
--   decide_operation_request(uuid, text, text, date, time without time zone, integer)
--
-- y este archivo la reproduce EXACTA. CREATE OR REPLACE con una firma distinta
-- no reemplaza: crea un overload, y las llamadas seguirían cayendo en la
-- función vieja. El cuerpo de abajo se generó a partir de la definición
-- desplegada y solo cambia el bloque de autorización — todo lo demás
-- (materialización de reservas, visitas y mesas, guardas de parámetros,
-- idempotencia, FOR UPDATE) queda byte a byte igual.
--
-- ── QUÉ CAMBIA ──────────────────────────────────────────────────────────────
--
--   reservation_request  can_confirm_reservations        (sin cambios)
--   inquiry              can_manage_inquiries            (sin cambios)
--   visit_request        can_manage_visits               (sin cambios)
--   table_request        can_manage_table_reservations   (sin cambios)
--   order_request        can_manage_orders               ← ERA can_confirm_reservations
--
-- Los cinco enumerados, y el ELSE ya no concede nada.
--
-- ── LO QUE NO CAMBIA ────────────────────────────────────────────────────────
--
-- NO se agrega materialización para order_request. Confirmar un pedido sigue
-- significando únicamente pending → confirmed: no se crea ninguna orden, porque
-- las tablas orders/order_items no existen todavía. Esta fase es exclusivamente
-- autorización.
--
-- tenant_actor_context() también suma el permiso a su allowlist, para que el día
-- que los pedidos tengan RPC de ciclo de vida no haya que tocar dos lugares con
-- criterios distintos. Su firma —(text)— tampoco cambia.
-- ════════════════════════════════════════════════════════════════════════════


-- ── tenant_actor_context: allowlist explícita, sin strings arbitrarios ──────

CREATE OR REPLACE FUNCTION public.tenant_actor_context(p_permission text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
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
         tu.can_manage_visits, tu.can_manage_table_reservations,
         tu.can_manage_orders
  INTO v_member
  FROM public.tenant_users tu
  WHERE tu.id = v_actor AND tu.active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'not_a_tenant_member');
  END IF;

  -- Allowlist: cada permiso se compara contra su propia columna. Un string que
  -- no esté acá no autoriza nada — no hay rama genérica que acepte cualquier
  -- nombre.
  v_allowed := v_member.role = 'owner'
    OR (p_permission = 'can_manage_table_reservations' AND v_member.can_manage_table_reservations)
    OR (p_permission = 'can_manage_visits'             AND v_member.can_manage_visits)
    OR (p_permission = 'can_manage_inquiries'          AND v_member.can_manage_inquiries)
    OR (p_permission = 'can_manage_orders'             AND v_member.can_manage_orders)
    OR (p_permission = 'can_confirm_reservations'      AND v_member.can_confirm_reservations);

  IF NOT v_allowed THEN
    RETURN jsonb_build_object(
      'ok', false, 'outcome', 'forbidden', 'required_permission', p_permission);
  END IF;

  RETURN jsonb_build_object('ok', true, 'actor', v_actor, 'tenant_id', v_member.tenant_id);
END;
$function$;


-- ── decide_operation_request ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.decide_operation_request(p_operation_id uuid, p_action text, p_notes text DEFAULT NULL::text, p_scheduled_date date DEFAULT NULL::date, p_scheduled_time time without time zone DEFAULT NULL::time without time zone, p_party_size integer DEFAULT NULL::integer)
 RETURNS jsonb
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
         tu.can_manage_table_reservations, tu.can_manage_orders
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
  -- Fase 3E-C3B0 — mapa final, con los CINCO kinds enumerados. Ya no hay
  -- legacy: order_request tiene su permiso propio y ninguno cae en un ELSE
  -- permisivo.
  --
  -- El ELSE FALLA CERRADO. Antes concedía can_confirm_reservations a todo lo
  -- que no estuviera enumerado, así que un kind nuevo nacía decidible por quien
  -- tuviera un permiso de otro dominio. Ahora un kind desconocido no lo puede
  -- decidir NADIE, ni el owner: si mañana se agrega uno sin tocar esta función,
  -- el resultado es un error explícito y no una autorización por accidente.
  --
  -- Hoy es inalcanzable (operation_requests_kind_check restringe kind a esos
  -- cinco), y esa es exactamente la idea: es una red para el futuro.
  v_needs := CASE v_op.kind
    WHEN 'reservation_request' THEN 'can_confirm_reservations'
    WHEN 'inquiry'             THEN 'can_manage_inquiries'
    WHEN 'visit_request'       THEN 'can_manage_visits'
    WHEN 'table_request'       THEN 'can_manage_table_reservations'
    WHEN 'order_request'       THEN 'can_manage_orders'
    ELSE NULL
  END;

  IF v_needs IS NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'unknown_kind', 'kind', v_op.kind);
  END IF;

  v_allowed := v_member.role = 'owner'
           OR (v_needs = 'can_manage_inquiries'          AND v_member.can_manage_inquiries)
           OR (v_needs = 'can_manage_visits'             AND v_member.can_manage_visits)
           OR (v_needs = 'can_manage_table_reservations' AND v_member.can_manage_table_reservations)
           OR (v_needs = 'can_manage_orders'             AND v_member.can_manage_orders)
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
$function$
;

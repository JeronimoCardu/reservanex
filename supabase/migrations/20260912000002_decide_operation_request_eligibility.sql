-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-A.2 — decide_operation_request valida elegibilidad
-- ════════════════════════════════════════════════════════════════════════════
--
-- Hasta acá el dashboard podía materializar una pre-reserva que el camino de la
-- IA habría rechazado: 1 noche en una propiedad con estadía mínima de 3, 9
-- huéspedes en una de capacidad 4, o una propiedad marcada como vendida.
--
-- Ahora se valida con public.check_temporary_rental_eligibility, la MISMA
-- función que usan los dos tools de la IA, la creación manual y la
-- reprogramación. Una sola implementación de las reglas.
--
-- ── ORDEN DENTRO DE LA TRANSACCIÓN (§8) ─────────────────────────────────────
--
--   lock de la propiedad
--     → elegibilidad      ← nuevo
--     → disponibilidad
--     → pricing
--     → INSERT reservation
--     → UPDATE operation_request
--
-- Elegibilidad y disponibilidad son cosas distintas y se comprueban las dos:
-- la primera pregunta "¿esta solicitud cumple las reglas de la propiedad?", la
-- segunda "¿las fechas siguen libres?". Ninguna reemplaza a la otra.
--
-- Los huéspedes se calculan ANTES de la elegibilidad porque la regla de
-- capacidad los necesita.
--
-- ── SI LA ELEGIBILIDAD FALLA ────────────────────────────────────────────────
--
-- Se devuelve outcome 'ineligible' con el motivo estructurado y se corta antes
-- del INSERT y antes del UPDATE. La solicitud queda pending, con decided_at y
-- decided_by en NULL, y sin reserva. NO se rechaza automáticamente: el asesor
-- decide si la rechaza, si ajusta la propiedad o si habla con el cliente.
--
-- ── HUÉSPEDES Y CAPACIDAD (§5) ──────────────────────────────────────────────
--
-- guests = adultos + niños + bebés, igual que en 3E-A, y ESE MISMO número se
-- compara contra capacity. No se cambió.
--
-- Se auditó si el dominio distingue el total persistido de la cifra usada para
-- capacidad: no lo hace. La única regla de capacidad que existía era
-- `guests > capacity` en check_property_availability, donde guests es UN número
-- que el LLM declara, sin desglose por edad. `infants` no aparece en ninguna
-- regla del repo — solo en el FormDefinition y en esta suma. Así que exceptuar
-- a los bebés sería inventar una regla de producto nueva (la cuna que no ocupa
-- plaza), y esta fase no inventa reglas. Queda anotado como decisión de
-- producto pendiente, no como comportamiento accidental.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.decide_operation_request(
  p_operation_id UUID,
  p_action       TEXT,
  p_notes        TEXT DEFAULT NULL
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
  v_prop     record;
  v_elig     JSONB;
  v_avail    JSONB;
  v_quote    JSONB;
  v_start    DATE;
  v_end      DATE;
  v_guests   INT;
  v_hold     INT;
  v_res_id   UUID;
  v_existing UUID;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;

  IF public.auth_user_type() = 'platform_user' THEN
    RETURN jsonb_build_object('outcome', 'platform_user_not_allowed');
  END IF;

  SELECT tu.tenant_id, tu.role::TEXT AS role, tu.can_confirm_reservations
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

  IF NOT (v_member.role = 'owner' OR v_member.can_confirm_reservations) THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  IF v_op.status <> 'pending' THEN
    SELECT id INTO v_existing
    FROM public.reservations WHERE source_operation_request_id = p_operation_id;

    RETURN jsonb_build_object(
      'outcome',        'already_decided',
      'status',         v_op.status,
      'decided_at',     v_op.decided_at,
      'decided_by',     v_op.decided_by,
      'decision_notes', v_op.decision_notes,
      'reservation_id', v_existing
    );
  END IF;

  -- ══ Materialización — solo temporary_rental aprobada ════════════════════
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

    -- Los huéspedes se necesitan para la regla de capacidad, así que se
    -- calculan antes de la elegibilidad.
    v_guests := COALESCE((v_op.payload_snapshot->>'adults')::INT, 0)
              + COALESCE((v_op.payload_snapshot->>'children')::INT, 0)
              + COALESCE((v_op.payload_snapshot->>'infants')::INT, 0);
    IF v_guests < 1 THEN v_guests := 1; END IF;

    -- ── Elegibilidad con las reglas canónicas ─────────────────────────────
    -- Misma función que usan la IA, la creación manual y la reprogramación.
    -- Dentro del lock de la propiedad, así la configuración no puede cambiar
    -- entre la validación y el INSERT.
    v_elig := public.check_temporary_rental_eligibility(
      v_member.tenant_id, v_prop.id, v_start, v_end, v_guests);

    IF (v_elig->>'eligible')::BOOLEAN IS NOT TRUE THEN
      -- Ni reserva ni decisión: la solicitud sigue pending para que el asesor
      -- la resuelva. El motivo va estructurado, sin texto que haya que parsear.
      RETURN jsonb_build_object('outcome', 'ineligible') || (v_elig - 'eligible');
    END IF;

    -- Pre-chequeo optimista de disponibilidad: evita trabajo y da el
    -- conflict_source exacto. La garantía dura sigue siendo el trigger.
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

    -- Pricing con el motor canónico (3E-A.1). Usa el mismo cálculo de noches
    -- que la elegibilidad: p_end - p_start.
    v_quote := public.quote_temporary_rental(v_member.tenant_id, v_prop.id, v_start, v_end);

    IF (v_quote->>'ok')::BOOLEAN IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'outcome', 'pricing_failed',
        'reason',  v_quote->>'reason'
      );
    END IF;

    -- La guarda dura vive en trg_guard_reservation_overlap. Si otro writer
    -- ganó la carrera entre el pre-chequeo y este INSERT, el trigger levanta
    -- 23P01 y se traduce al MISMO outcome controlado.
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
        'source',               'form',
        'operation_request_id', p_operation_id,
        'intent',               v_op.intent,
        'decided_by',           v_actor,
        'pricing_mode',         v_quote->>'pricing_mode',
        'total_amount',         v_quote->'total',
        'price_currency',       v_quote->>'currency'
      )
    );
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
    'reservation_id', v_res_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) TO authenticated;

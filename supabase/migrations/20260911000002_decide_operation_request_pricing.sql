-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-A.1 — decide_operation_request cotiza con el motor canónico
-- ════════════════════════════════════════════════════════════════════════════
--
-- Fase 3E-A materializó la reserva sin importes: pricing_mode_snapshot y
-- currency correctos, pero nightly_price_snapshot / subtotal / total / deposit
-- en NULL, y también nights_count, price_currency y pricing_breakdown vacíos.
-- Fue deliberado: estaba prohibido inventar una segunda implementación de
-- pricing, y en ese momento no existía ninguna reutilizable desde SQL.
--
-- Ahora sí existe: public.quote_temporary_rental (20260911000001), que es la
-- misma función que usan los cuatro caminos de TypeScript. Llamarla acá no
-- duplica nada — es exactamente el motivo por el que se extrajo.
--
-- ── QUÉ CAMBIA ──────────────────────────────────────────────────────────────
--
--   · Se cotiza DESPUÉS de tomar el lock de la propiedad y verificar
--     disponibilidad, y antes del INSERT. Al estar dentro del mismo
--     FOR UPDATE, la cotización no puede quedar desfasada de los datos que se
--     usaron para decidir.
--   · El INSERT ahora completa los ocho campos financieros que faltaban.
--   · Si la cotización falla (§11), se devuelve un outcome controlado y la
--     transacción termina sin tocar la solicitud: sigue pending. Nunca se
--     confirma una operation_request sin su reservation.
--
-- ── QUÉ PRECIO SE CAPTURA (§12) ─────────────────────────────────────────────
--
-- El vigente en el momento en que la empresa APRUEBA. Se auditó si alguna capa
-- guardaba una cotización previa para este camino: no existe ninguna. El
-- FormDefinition de temporary_rental sólo pide check_in, check_out, adultos,
-- niños, bebés, mascotas y notas — ningún campo de precio, ninguna cotización
-- mostrada, nada en el payload. La submission no prometió un importe, así que
-- no hay promesa que honrar.
--
-- (El camino de la IA sí tiene una cotización previa —
-- conversation_reservation_drafts, vigente 30 minutos, mostrada al cliente como
-- price_summary— y por eso ese camino la respeta cuando está vigente. Esa es
-- una diferencia deliberada y documentada, no una divergencia de fórmula: los
-- dos caminos usan el mismo motor; lo que difiere es CUÁNDO se congeló el
-- precio, y en cada caso es el momento en que se le comunicó algo al cliente.)
--
-- ── INMUTABILIDAD (§13) ─────────────────────────────────────────────────────
--
-- Las columnas *_snapshot y los importes de reservations ya eran snapshots por
-- diseño: se escriben en el INSERT y nada las recalcula si después cambia
-- properties.base_price_per_night, el cleaning_fee o el pricing_mode. Esta
-- migración conserva esa semántica — solo agrega el momento inicial de escritura
-- que faltaba. No se agregó ningún recálculo automático ni trigger de refresco.
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

    -- Pre-chequeo optimista: evita trabajo y da el conflict_source exacto.
    v_avail := public.temporary_rental_dates_available(
      v_member.tenant_id, v_prop.id, v_start, v_end);

    IF (v_avail->>'available')::BOOLEAN IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'outcome',         'availability_conflict',
        'conflict_source', v_avail->>'conflict_source',
        'conflict_id',     v_avail->>'conflict_id'
      );
    END IF;

    v_guests := COALESCE((v_op.payload_snapshot->>'adults')::INT, 0)
              + COALESCE((v_op.payload_snapshot->>'children')::INT, 0)
              + COALESCE((v_op.payload_snapshot->>'infants')::INT, 0);
    IF v_guests < 1 THEN v_guests := 1; END IF;

    SELECT COALESCE(s.pending_reservation_hold_minutes, 1440) INTO v_hold
    FROM public.ai_settings s WHERE s.tenant_id = v_member.tenant_id;
    v_hold := COALESCE(v_hold, 1440);

    -- ── Pricing con el motor canónico ─────────────────────────────────────
    -- Misma función que usan los cuatro caminos de TypeScript. Se cotiza acá,
    -- dentro del lock de la propiedad, así el precio corresponde exactamente a
    -- los datos con los que se aprobó.
    v_quote := public.quote_temporary_rental(v_member.tenant_id, v_prop.id, v_start, v_end);

    -- §11: si la cotización no se pudo hacer, se corta ANTES del INSERT y
    -- antes del UPDATE de la solicitud. La transacción no deja rastro: la
    -- operation_request sigue pending y no hay reservation. Ojo: 'consult'
    -- NO es una falla — es una cotización válida cuyos importes son NULL.
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

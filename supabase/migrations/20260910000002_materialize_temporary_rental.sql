-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-A — aprobar una temporary_rental crea la reserva, en la misma transacción
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── AUDITORÍA QUE DEFINIÓ ESTE DISEÑO ───────────────────────────────────────
--
-- DISPONIBILIDAD (§2). Hay dos tablas y la pregunta era cuál es la canónica:
--
--   availability_blocks           — unit-level, tiene reservation_id y un
--                                   EXCLUDE gist (no_double_booking). NINGÚN
--                                   código de negocio la lee: solo aparece en
--                                   platform-danger (purge) y en los tipos
--                                   generados. Su propio COMMENT dice que el
--                                   sitio público lee "property_availability_
--                                   blocks, a different table". Es legacy.
--   property_availability_blocks  — property-level, con deleted_at. La leen
--                                   availability-check.shared.ts,
--                                   find-next-available-dates.ts, la action de
--                                   reservas y el sitio público. Es la canónica.
--
--   Ninguna se escribe acá, y no es un olvido: la disponibilidad NO se calcula
--   con filas de bloqueo, se calcula con el ESTADO de la reserva. Ver
--   availability-check.shared.ts — tres capas, todas por property_id:
--     1. reservations status='confirmed' que solapan
--     2. reservations status='pre_reserved' con expires_at > now() que solapan
--     3. property_availability_blocks vivos que solapan
--   Crear la reserva ES lo que bloquea las fechas. Escribir además un bloqueo
--   sería contar dos veces.
--
-- STATUS (§3). No se eligió por nombre; se miró el uso real:
--
--   pending_payment  → 0 usos en todo el código. Valor muerto del enum.
--   pre_reserved     → 32 usos. Es el HOLD: bloquea disponibilidad mientras
--                      expires_at > now(). La UI lo etiqueta "Pendiente".
--                      Es lo que crea create_pending_reservation.
--   confirmed        → 30 usos. Final, bloquea sin vencimiento. La UI dice
--                      "Confirmada".
--
--   Se elige pre_reserved. Aprobar significa "la empresa acepta la solicitud",
--   no "está pagada y cerrada": el producto ya modela pre_reserved → confirmed
--   como un paso humano aparte (confirmReservationAction). Saltar directo a
--   confirmed se saltearía ese paso y le diría al cliente algo que todavía no
--   es cierto.
--
--   expires_at es OBLIGATORIO para que bloquee: la capa 2 exige
--   expires_at > now(), así que un pre_reserved con expires_at NULL no
--   bloquearía nada. Se usa ai_settings.pending_reservation_hold_minutes
--   (default 1440), exactamente el mismo hold que usa la IA.
--
-- PRECIO (§10). create_pending_reservation calcula el snapshot en TypeScript,
-- no en SQL, y no existe ninguna función canónica de pricing reutilizable
-- desde acá. Reimplementarlo en plpgsql sería construir pricing nuevo, que es
-- justamente lo que la fase prohíbe. Así que NO se inventa ningún número: los
-- campos financieros quedan NULL y pricing_mode_snapshot copia el de la
-- propiedad. Es la misma representación que el producto ya usa para una
-- propiedad en modo 'consult'. Queda anotado como limitación.
--
-- CONCURRENCIA (§6). reservations NO tiene EXCLUDE constraint (el único del
-- schema está en availability_blocks, la tabla que nadie escribe). Y no se
-- puede agregar uno equivalente: la capa 2 depende de expires_at > now(), que
-- no es inmutable y por lo tanto no es indexable en un EXCLUDE.
--
--   La garantía se hace con un lock de fila: SELECT ... FROM properties
--   FOR UPDATE serializa por propiedad DENTRO de la transacción, y recién
--   después se re-chequea disponibilidad. Dos aprobaciones simultáneas sobre
--   la misma propiedad se ordenan; la segunda ve la reserva de la primera y
--   sale por availability_conflict con su operación intacta en pending.
-- ════════════════════════════════════════════════════════════════════════════


-- ── Helper: ¿están libres estas fechas? ─────────────────────────────────────
-- Réplica exacta de las tres capas de availability-check.shared.ts. Se
-- implementa en SQL porque la decisión y la materialización tienen que ocurrir
-- en la misma transacción, y el chequeo en TypeScript vive fuera de ella.
--
-- STABLE y no SECURITY DEFINER: la llama la RPC de decisión, que ya es
-- SECURITY DEFINER; no necesita privilegios propios.
CREATE OR REPLACE FUNCTION public.temporary_rental_dates_available(
  p_tenant_id   UUID,
  p_property_id UUID,
  p_start       DATE,
  p_end         DATE
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    -- Capa 1: reservas confirmadas que solapan
    (SELECT jsonb_build_object('available', false, 'conflict_source', 'confirmed', 'conflict_id', r.id)
       FROM public.reservations r
      WHERE r.tenant_id = p_tenant_id AND r.property_id = p_property_id
        AND r.status = 'confirmed' AND r.deleted_at IS NULL
        AND r.start_date < p_end AND r.end_date > p_start
      LIMIT 1),
    -- Capa 2: pre-reservas NO vencidas que solapan
    (SELECT jsonb_build_object('available', false, 'conflict_source', 'pre_reserved', 'conflict_id', r.id)
       FROM public.reservations r
      WHERE r.tenant_id = p_tenant_id AND r.property_id = p_property_id
        AND r.status = 'pre_reserved' AND r.deleted_at IS NULL
        AND r.expires_at > NOW()
        AND r.start_date < p_end AND r.end_date > p_start
      LIMIT 1),
    -- Capa 3: bloqueos manuales vivos que solapan
    (SELECT jsonb_build_object('available', false, 'conflict_source', 'block', 'conflict_id', b.id)
       FROM public.property_availability_blocks b
      WHERE b.tenant_id = p_tenant_id AND b.property_id = p_property_id
        AND b.deleted_at IS NULL
        AND b.start_date < p_end AND b.end_date > p_start
      LIMIT 1),
    jsonb_build_object('available', true)
  );
$function$;

REVOKE ALL ON FUNCTION public.temporary_rental_dates_available(UUID, UUID, DATE, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.temporary_rental_dates_available(UUID, UUID, DATE, DATE) FROM anon;
REVOKE ALL ON FUNCTION public.temporary_rental_dates_available(UUID, UUID, DATE, DATE) FROM authenticated;

COMMENT ON FUNCTION public.temporary_rental_dates_available(UUID, UUID, DATE, DATE) IS
  'Fase 3E-A: las mismas tres capas de availability-check.shared.ts, en SQL, '
  'para poder chequear disponibilidad dentro de la transacción de la decisión. '
  'Uso interno: sin grants a anon/authenticated.';


-- ── decide_operation_request, ahora con materialización ─────────────────────
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
  v_start    DATE;
  v_end      DATE;
  v_guests   INT;
  v_hold     INT;
  v_res_id   UUID;
  v_existing UUID;
BEGIN
  -- ── 1. Hay un usuario ────────────────────────────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;

  -- ── 2. Es usuario de tenant, no de plataforma (bloquea impersonación) ────
  IF public.auth_user_type() = 'platform_user' THEN
    RETURN jsonb_build_object('outcome', 'platform_user_not_allowed');
  END IF;

  -- ── 3. Está en tenant_users y activo ─────────────────────────────────────
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

  -- ── Nota: trim, tope, sin HTML ───────────────────────────────────────────
  v_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');
  IF v_notes IS NOT NULL THEN
    IF length(v_notes) > 500 THEN
      RETURN jsonb_build_object('outcome', 'notes_too_long', 'max_length', 500);
    END IF;
    IF v_notes ~ '<[^>]+>' THEN
      RETURN jsonb_build_object('outcome', 'notes_invalid');
    END IF;
  END IF;

  -- ── 4. La operación es de SU tenant, y se lockea ─────────────────────────
  SELECT o.* INTO v_op
  FROM public.operation_requests o
  WHERE o.id = p_operation_id AND o.tenant_id = v_member.tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- ── 5. Permiso ───────────────────────────────────────────────────────────
  IF NOT (v_member.role = 'owner' OR v_member.can_confirm_reservations) THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  -- ── 6. Sigue pendiente ───────────────────────────────────────────────────
  -- Fase 3E-A: si ya estaba decidida, se devuelve la reserva existente (si la
  -- hay) para que un reintento sea idempotente de verdad (§8) — sin tocar
  -- decided_at, decided_by ni reservation.created_at.
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

  -- ══ MATERIALIZACIÓN — solo temporary_rental aprobada (§4, §18) ═══════════
  -- Cualquier otro kind/intent conserva EXACTAMENTE el comportamiento de la
  -- Fase 3D: se decide y nada más. 3E-B y 3E-C se ocuparán de los demás.
  IF p_action = 'confirmed'
     AND v_op.kind   = 'reservation_request'
     AND v_op.intent = 'temporary_rental'
  THEN
    -- ── Contexto de propiedad (§5) ─────────────────────────────────────────
    -- Sin propiedad no hay reserva posible. NO se inventa un entity_id: se
    -- devuelve un outcome controlado y la operación SIGUE pending, para que
    -- alguien la asocie a una propiedad o la rechace.
    IF v_op.entity_type IS DISTINCT FROM 'property' OR v_op.entity_id IS NULL THEN
      RETURN jsonb_build_object('outcome', 'missing_reservation_context', 'reason', 'no_property');
    END IF;

    -- Lock de la propiedad: serializa dos aprobaciones simultáneas sobre la
    -- misma propiedad ANTES de mirar disponibilidad (§6).
    SELECT p.id, p.currency, p.pricing_mode, p.deleted_at
    INTO v_prop
    FROM public.properties p
    WHERE p.id = v_op.entity_id AND p.tenant_id = v_member.tenant_id
    FOR UPDATE;

    IF NOT FOUND OR v_prop.deleted_at IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'missing_reservation_context', 'reason', 'property_not_found');
    END IF;

    -- ── Fechas ─────────────────────────────────────────────────────────────
    -- De las columnas ya extraídas en la Fase 3C, que salieron del payload
    -- validado por Zod. No se re-parsea el jsonb.
    v_start := v_op.requested_date;
    v_end   := v_op.requested_end_date;

    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
      RETURN jsonb_build_object('outcome', 'invalid_dates');
    END IF;

    -- ── Disponibilidad, ya con el lock tomado ──────────────────────────────
    v_avail := public.temporary_rental_dates_available(
      v_member.tenant_id, v_prop.id, v_start, v_end);

    IF (v_avail->>'available')::BOOLEAN IS NOT TRUE THEN
      -- La operación NO se decide: queda pending para rechazarla o resolverla
      -- a mano (§14, §16).
      RETURN jsonb_build_object(
        'outcome',         'availability_conflict',
        'conflict_source', v_avail->>'conflict_source',
        'conflict_id',     v_avail->>'conflict_id'
      );
    END IF;

    -- ── Huéspedes ──────────────────────────────────────────────────────────
    -- reservations.guests es NOT NULL y el formulario guarda adultos, niños y
    -- bebés por separado, así que hay que totalizar. Es un campo requerido del
    -- dominio de la reserva, no una reinterpretación de lo que dijo el cliente
    -- (el payload_snapshot conserva el desglose exacto e intacto).
    v_guests := COALESCE((v_op.payload_snapshot->>'adults')::INT, 0)
              + COALESCE((v_op.payload_snapshot->>'children')::INT, 0)
              + COALESCE((v_op.payload_snapshot->>'infants')::INT, 0);
    IF v_guests < 1 THEN v_guests := 1; END IF;

    -- ── Hold: el mismo que usa la IA ───────────────────────────────────────
    SELECT COALESCE(s.pending_reservation_hold_minutes, 1440) INTO v_hold
    FROM public.ai_settings s WHERE s.tenant_id = v_member.tenant_id;
    v_hold := COALESCE(v_hold, 1440);

    -- ── La reserva ─────────────────────────────────────────────────────────
    -- Sin números de precio inventados: los campos financieros quedan NULL y
    -- pricing_mode_snapshot copia el de la propiedad. Es la representación que
    -- el producto ya usa para "todavía sin cotizar".
    INSERT INTO public.reservations (
      tenant_id, contact_id, property_id, conversation_id,
      start_date, end_date, guests,
      status, source, source_operation_request_id,
      expires_at, currency, pricing_mode_snapshot,
      customer_notes
    ) VALUES (
      v_member.tenant_id, v_op.contact_id, v_prop.id, v_op.conversation_id,
      v_start, v_end, v_guests,
      'pre_reserved', 'form', p_operation_id,
      NOW() + (v_hold || ' minutes')::INTERVAL,
      COALESCE(v_prop.currency, 'ARS'), v_prop.pricing_mode,
      NULLIF(btrim(COALESCE(v_op.payload_snapshot->>'notes', '')), '')
    )
    RETURNING id INTO v_res_id;

    -- ── Bitácora de la reserva (§21) ───────────────────────────────────────
    -- Se reutiliza reservation_events, igual que create_pending_reservation
    -- con 'ai_created'. No se crea un tercer sistema de auditoría: la decisión
    -- en sí ya queda en audit_logs por el trigger de operation_requests.
    INSERT INTO public.reservation_events (tenant_id, reservation_id, actor_id, event_type, metadata)
    VALUES (
      v_member.tenant_id, v_res_id, v_actor, 'form_approved',
      jsonb_build_object(
        'source',               'form',
        'operation_request_id', p_operation_id,
        'intent',               v_op.intent,
        'decided_by',           v_actor
      )
    );
  END IF;

  -- ── La decisión ──────────────────────────────────────────────────────────
  -- Va DESPUÉS de la materialización: si algo de arriba falló con un outcome
  -- controlado, ya salimos sin tocar la operación; y si algo lanza excepción,
  -- la transacción revierte todo junto. Nunca queda confirmed sin reserva.
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

-- Grants: idénticos a los de la Fase 3D. Se re-afirman porque CREATE OR
-- REPLACE sobre una función existente conserva sus privilegios, pero si
-- alguna vez se recreara desde cero los ALTER DEFAULT PRIVILEGES de Supabase
-- volverían a otorgar EXECUTE a anon y service_role.
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) IS
  'Fase 3D + 3E-A: única vía para decidir una operation_request. '
  'pending → confirmed o pending → rejected. decided_by de auth.uid() y '
  'decided_at de now(). Bloquea platform_users. '
  'Fase 3E-A: si kind=reservation_request e intent=temporary_rental y la acción '
  'es confirmed, crea la reserva (pre_reserved, con hold) EN LA MISMA '
  'TRANSACCIÓN, tras lockear la propiedad y re-chequear disponibilidad. Los '
  'demás kinds conservan el comportamiento de 3D. '
  'Outcomes: confirmed | rejected | already_decided | not_found | forbidden | '
  'unauthenticated | platform_user_not_allowed | not_a_tenant_member | '
  'invalid_action | notes_too_long | notes_invalid | '
  'missing_reservation_context | invalid_dates | availability_conflict.';

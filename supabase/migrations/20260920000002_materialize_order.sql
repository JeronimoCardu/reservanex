-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3C — materialización atómica del pedido + ciclo de vida
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── MISMA FIRMA, SIN OVERLOAD ───────────────────────────────────────────────
--
-- Auditado contra la base antes de escribir esto: existe UNA sola firma,
--
--   decide_operation_request(uuid, text, text, date, time without time zone, integer)
--
-- y este archivo la reproduce EXACTA. CREATE OR REPLACE con una firma distinta
-- no reemplaza: crea un overload, y las llamadas seguirían cayendo en la función
-- vieja. El cuerpo se generó a partir de la definición DESPLEGADA y solo agrega
-- el bloque de materialización D — todo lo demás (autorización por kind,
-- guardas de parámetros, materialización de reservas, visitas y mesas,
-- idempotencia) queda byte a byte igual.
--
-- ── ATOMICIDAD (§7) ─────────────────────────────────────────────────────────
--
-- Una función plpgsql corre dentro de la transacción del caller, así que el
-- lock de la solicitud, el INSERT del pedido, los INSERT de las líneas y el
-- UPDATE de la solicitud son un solo todo-o-nada. Nunca queda una solicitud
-- confirmed sin pedido, ni un pedido a medias.
--
-- Con un matiz que importa: estas rutas devuelven un jsonb de OUTCOME en vez de
-- levantar excepción, y un RETURN no revierte lo ya escrito. Por eso el snapshot
-- se valida ENTERO antes del primer INSERT.
--
-- ── CONCURRENCIA (§8) ───────────────────────────────────────────────────────
--
-- Dos empleados aceptando a la vez se serializan en el FOR UPDATE de la
-- solicitud, que ya estaba. El segundo encuentra status <> 'pending' y devuelve
-- already_decided CON el order_id del primero. La UNIQUE de
-- orders.source_operation_request_id es la última línea de defensa.
-- ════════════════════════════════════════════════════════════════════════════

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
  -- Fase 3E-C3C — materialización del pedido.
  v_order_id   UUID;
  v_snap       JSONB;
  v_items      JSONB;
  v_item       JSONB;
  v_n          INT;
  v_idx        INT;
  v_fulfill    TEXT;
  v_address    TEXT;
  v_pay        TEXT;
  v_currency   TEXT;
  v_subtotal   NUMERIC(14,2);
  v_sum        NUMERIC(14,2);
  v_unit       NUMERIC(14,2);
  v_line       NUMERIC(14,2);
  v_qty        INT;
  v_item_id    UUID;
  v_name       TEXT;
  v_txt        TEXT;
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

    -- Fase 3E-C3C — si ya se había aceptado, se devuelve el pedido existente en
    -- vez de nada: es lo que permite que dos empleados que aceptan a la vez
    -- reciban los dos una respuesta coherente.
    SELECT id INTO v_order_id
    FROM public.orders WHERE source_operation_request_id = p_operation_id;

    RETURN jsonb_build_object(
      'outcome',        'already_decided',
      'table_reservation_id', v_table_id,
      'order_id',       v_order_id,
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

  -- ══ Materialización D — order_request aceptado → pedido (Fase 3E-C3C) ══
  --
  -- TODO sale de payload_snapshot. NO se consulta menu_items.base_price en
  -- ningún momento: el precio ya lo congeló C3B1 al crear la submission, y el
  -- catálogo pudo cambiar entre medio. Lo que sigue NO es repricing — es
  -- validación interna de que el snapshot es coherente CONSIGO MISMO.
  --
  -- La validación completa ocurre ANTES de cualquier INSERT. No alcanza con
  -- confiar en la transacción: estas rutas devuelven un jsonb de outcome en vez
  -- de levantar excepción, y un RETURN no revierte lo ya escrito. Validar
  -- primero es lo que garantiza "0 order, 0 items, request sigue pending".
  IF p_action = 'confirmed' AND v_op.kind = 'order_request' THEN
    v_snap := COALESCE(v_op.payload_snapshot, '{}'::JSONB);

    IF v_op.contact_id IS NULL THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'no_contact');
    END IF;

    -- ── Cabecera ────────────────────────────────────────────────────────────
    v_fulfill := v_snap->>'fulfillment';
    IF v_fulfill IS NULL OR v_fulfill NOT IN ('delivery', 'takeaway') THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'fulfillment');
    END IF;

    v_address := NULLIF(btrim(COALESCE(v_snap->>'address', '')), '');
    IF v_fulfill = 'delivery' AND v_address IS NULL THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'address_required');
    END IF;
    IF v_fulfill = 'takeaway' AND v_address IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'address_not_allowed');
    END IF;

    v_pay := v_snap->>'payment_method';
    IF v_pay IS NULL OR v_pay NOT IN ('cash', 'transfer', 'card') THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'payment_method');
    END IF;

    v_currency := btrim(COALESCE(v_snap->>'currency', ''));
    IF char_length(v_currency) <> 3 THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'currency');
    END IF;

    -- Canónico: dígitos, punto, exactamente dos decimales. El mismo formato que
    -- escribe C3B1; cualquier otra cosa es un snapshot corrupto.
    v_txt := v_snap->>'subtotal';
    IF v_txt IS NULL OR v_txt !~ '^[0-9]{1,12}\.[0-9]{2}$' THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'subtotal_format');
    END IF;
    v_subtotal := v_txt::NUMERIC;

    IF char_length(COALESCE(v_snap->>'notes', '')) > 1000 THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'notes_too_long');
    END IF;

    -- ── Líneas ──────────────────────────────────────────────────────────────
    v_items := v_snap->'items';
    IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'items_not_array');
    END IF;

    v_n := jsonb_array_length(v_items);
    IF v_n < 1 OR v_n > 25 THEN
      RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'items_count', 'count', v_n);
    END IF;

    v_sum := 0;
    FOR v_idx IN 0 .. v_n - 1 LOOP
      v_item := v_items->v_idx;

      IF jsonb_typeof(v_item) <> 'object' THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'item_not_object', 'index', v_idx);
      END IF;

      BEGIN
        v_item_id := (v_item->>'item_id')::UUID;
      EXCEPTION WHEN others THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'item_id', 'index', v_idx);
      END;
      IF v_item_id IS NULL THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'item_id', 'index', v_idx);
      END IF;

      v_name := btrim(COALESCE(v_item->>'name', ''));
      IF char_length(v_name) = 0 OR char_length(v_name) > 120 THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'name', 'index', v_idx);
      END IF;

      IF jsonb_typeof(v_item->'quantity') <> 'number' THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'quantity_type', 'index', v_idx);
      END IF;
      v_qty := (v_item->>'quantity')::NUMERIC;
      IF v_qty IS NULL OR v_qty < 1 OR v_qty > 99
         OR (v_item->>'quantity')::NUMERIC <> trunc((v_item->>'quantity')::NUMERIC) THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'quantity', 'index', v_idx);
      END IF;

      v_txt := v_item->>'unit_price';
      IF v_txt IS NULL OR v_txt !~ '^[0-9]{1,12}\.[0-9]{2}$' THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'unit_price_format', 'index', v_idx);
      END IF;
      v_unit := v_txt::NUMERIC;

      v_txt := v_item->>'line_total';
      IF v_txt IS NULL OR v_txt !~ '^[0-9]{1,12}\.[0-9]{2}$' THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'line_total_format', 'index', v_idx);
      END IF;
      v_line := v_txt::NUMERIC;

      -- §9 — la aritmética del snapshot, verificada con NUMERIC de Postgres.
      IF v_line <> v_unit * v_qty THEN
        RETURN jsonb_build_object(
          'outcome', 'invalid_snapshot', 'reason', 'line_total_mismatch', 'index', v_idx);
      END IF;

      IF char_length(COALESCE(v_item->>'notes', '')) > 300 THEN
        RETURN jsonb_build_object('outcome', 'invalid_snapshot', 'reason', 'item_notes_too_long', 'index', v_idx);
      END IF;

      -- El producto tiene que existir y ser del tenant. NO se exige que siga
      -- publicado, disponible ni sin archivar: el catálogo pudo cambiar después
      -- del pedido y eso no puede impedir materializar lo que ya se acordó.
      IF NOT EXISTS (
        SELECT 1 FROM public.menu_items mi
        WHERE mi.id = v_item_id AND mi.tenant_id = v_member.tenant_id
      ) THEN
        RETURN jsonb_build_object(
          'outcome', 'invalid_snapshot', 'reason', 'menu_item_not_in_tenant', 'index', v_idx);
      END IF;

      v_sum := v_sum + v_line;
    END LOOP;

    IF v_sum <> v_subtotal THEN
      RETURN jsonb_build_object(
        'outcome', 'invalid_snapshot', 'reason', 'subtotal_mismatch',
        'expected', v_sum::TEXT, 'snapshot', v_subtotal::TEXT);
    END IF;

    -- ── Recién acá se escribe ───────────────────────────────────────────────
    INSERT INTO public.orders (
      tenant_id, contact_id, source_operation_request_id, status,
      fulfillment, delivery_address_snapshot, payment_method,
      currency, subtotal, notes, confirmed_at, confirmed_by
    ) VALUES (
      v_member.tenant_id, v_op.contact_id, p_operation_id, 'confirmed',
      v_fulfill, v_address, v_pay,
      v_currency, v_subtotal, NULLIF(btrim(COALESCE(v_snap->>'notes', '')), ''),
      NOW(), v_actor
    )
    RETURNING id INTO v_order_id;

    FOR v_idx IN 0 .. v_n - 1 LOOP
      v_item := v_items->v_idx;
      INSERT INTO public.order_items (
        order_id, menu_item_id, name_snapshot, unit_price_snapshot,
        quantity, line_total, notes, sort_order
      ) VALUES (
        v_order_id,
        (v_item->>'item_id')::UUID,
        btrim(v_item->>'name'),
        (v_item->>'unit_price')::NUMERIC,
        (v_item->>'quantity')::INT,
        (v_item->>'line_total')::NUMERIC,
        NULLIF(btrim(COALESCE(v_item->>'notes', '')), ''),
        v_idx
      );
    END LOOP;
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
    'table_reservation_id',  v_table_id,
    'order_id',              v_order_id
  );
END;
$function$
;


-- ════════════════════════════════════════════════════════════════════════════
-- transition_order_status — el ciclo de vida operacional (§13, §14, §15)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Un solo punto de mutación para el pedido, con el mismo patrón que
-- cancel_table_reservation y complete_property_visit:
--
--   · el actor sale de auth.uid() vía tenant_actor_context, NUNCA del browser;
--   · tenant_actor_context ya rechaza platform_user, así que la impersonación
--     de plataforma no puede escribir;
--   · autoriza owner OR can_manage_orders, y nada más — can_confirm_reservations
--     no concede nada sobre pedidos desde 3E-C3B0;
--   · FOR UPDATE sobre el pedido: dos transiciones simultáneas se serializan.
--
-- Las transiciones válidas son exactamente seis. Todo lo demás —incluidos los
-- saltos hacia adelante como confirmed → completed y cualquier cosa que salga
-- de un estado terminal— devuelve invalid_transition sin tocar la fila.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.transition_order_status(
  p_order_id UUID,
  p_status   TEXT,
  p_reason   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx    JSONB;
  v_order  record;
  v_reason TEXT;
  v_actor  UUID;
  v_now    TIMESTAMPTZ := NOW();
BEGIN
  v_ctx := public.tenant_actor_context('can_manage_orders');
  IF (v_ctx->>'ok')::BOOLEAN IS NOT TRUE THEN RETURN v_ctx - 'ok'; END IF;
  v_actor := (v_ctx->>'actor')::UUID;

  IF p_status IS NULL OR p_status NOT IN ('preparing', 'ready', 'completed', 'cancelled') THEN
    RETURN jsonb_build_object('outcome', 'invalid_status', 'status', p_status);
  END IF;

  -- §16 — el motivo es OPCIONAL. Si llega, se valida igual que decision_notes.
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NOT NULL THEN
    IF p_status <> 'cancelled' THEN
      RETURN jsonb_build_object(
        'outcome', 'invalid_parameters',
        'detail',  'el motivo solo aplica al cancelar un pedido');
    END IF;
    IF length(v_reason) > 500 THEN
      RETURN jsonb_build_object('outcome', 'reason_too_long', 'max_length', 500);
    END IF;
    IF v_reason ~ '<[^>]+>' THEN
      RETURN jsonb_build_object('outcome', 'reason_invalid');
    END IF;
  END IF;

  SELECT o.* INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id AND o.tenant_id = (v_ctx->>'tenant_id')::UUID
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;

  IF v_order.status = p_status THEN
    RETURN jsonb_build_object('outcome', 'already_in_status', 'status', p_status);
  END IF;

  -- §14 — las SEIS transiciones permitidas, enumeradas. Fuera de esta lista no
  -- hay ninguna: ni saltos hacia adelante, ni retrocesos, ni salidas de un
  -- estado terminal.
  IF NOT (
       (v_order.status = 'confirmed' AND p_status IN ('preparing', 'cancelled'))
    OR (v_order.status = 'preparing' AND p_status IN ('ready',     'cancelled'))
    OR (v_order.status = 'ready'     AND p_status IN ('completed', 'cancelled'))
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_transition', 'status', v_order.status, 'target', p_status);
  END IF;

  -- §15 — cada transición deja su marca. Las anteriores NO se borran: un pedido
  -- completado conserva cuándo empezó a prepararse y cuándo estuvo listo.
  IF p_status = 'preparing' THEN
    UPDATE public.orders
    SET status = 'preparing', preparing_at = v_now, preparing_by = v_actor
    WHERE id = p_order_id;

  ELSIF p_status = 'ready' THEN
    UPDATE public.orders
    SET status = 'ready', ready_at = v_now, ready_by = v_actor
    WHERE id = p_order_id;

  ELSIF p_status = 'completed' THEN
    UPDATE public.orders
    SET status = 'completed', completed_at = v_now, completed_by = v_actor
    WHERE id = p_order_id;

  ELSE
    UPDATE public.orders
    SET status = 'cancelled', cancelled_at = v_now, cancelled_by = v_actor,
        cancellation_reason = v_reason
    WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'outcome',    p_status,
    'order_id',   p_order_id,
    'status',     p_status,
    'changed_at', v_now,
    'changed_by', v_actor);
END;
$function$;

-- Mismo criterio de grants que el resto de las RPC operacionales: la ejecuta el
-- usuario autenticado, y la propia función decide si puede.
REVOKE ALL ON FUNCTION public.transition_order_status(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_order_status(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.transition_order_status(UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.transition_order_status(UUID, TEXT, TEXT) IS
  'Fase 3E-C3C: único punto de mutación del ciclo de vida de un pedido. Resuelve '
  'el actor con auth.uid(), exige owner OR can_manage_orders, rechaza '
  'platform_user (la impersonación no escribe) y solo admite las seis '
  'transiciones válidas. NO edita items, precios ni datos del pedido: eso es '
  'evidencia de lo aceptado.';

-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-A.2 — reglas de elegibilidad canónicas para temporary_rental
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── LA DIVERGENCIA ──────────────────────────────────────────────────────────
--
-- Antes de esta migración, cada writer aplicaba su propio subconjunto de
-- reglas. La auditoría completa (§1) encontró seis divergencias, no dos:
--
--   regla                        IA-cotiza  IA-crea  manual  reprog.  formulario
--   ──────────────────────────────────────────────────────────────────────────
--   end > start                     sí        sí       sí      sí        sí
--   propiedad existe/no borrada     sí        sí       sí      sí        sí
--   operation_type temporary        sí        sí       sí      sí        NO
--   commercial_status available     sí        sí       NO      NO        NO
--   capacity                        sí        NO       NO      NO        NO
--   minimum_stay_nights             sí        sí       NO      NO        NO
--   disponibilidad (3 capas)        sí        sí       sí      sí        sí
--
-- Lo más grave no era el formulario: era que create_pending_reservation —el
-- writer REAL de la IA— leía `capacity` de properties y NUNCA la comparaba. La
-- capacidad solo se verificaba al cotizar. Si el LLM cotizaba para 4 y creaba
-- para 9, la reserva entraba igual. O sea que "la IA valida capacity" era
-- verdad a medias.
--
-- ── QUÉ ES UNA REGLA DE MATERIALIZACIÓN (§2) ────────────────────────────────
--
-- TIPO A — impiden que la reserva exista. Van acá, y las aplica todo writer
-- cuyo resultado ocupe fechas:
--
--     · fechas coherentes (check-out posterior a check-in)
--     · la propiedad existe y no está borrada
--     · commercial_status = 'available'  (alquilada/pausada/vendida no reserva)
--     · operation_type = 'temporary_rental'
--     · huéspedes <= capacity
--     · noches >= minimum_stay_nights
--
-- TIPO B — quedan FUERA, con motivo explícito:
--
--     · published = true — es visibilidad de catálogo, no una regla de
--       reserva. Solo check_property_availability la exige, porque es la que
--       le habla a un cliente sobre el catálogo público. Un asesor puede
--       reservar una propiedad despublicada; eso es correcto hoy y se
--       mantiene.
--
--     · fecha de inicio en el pasado — depende del ACTOR, no de la propiedad.
--       La IA la bloquea (un cliente no puede reservar ayer). La creación
--       manual NO la bloquea, y está bien: un asesor carga reservas
--       retroactivas como entrada de datos. Meterla acá le quitaría esa
--       capacidad al dashboard. Cada camino la conserva exactamente como hoy.
--
--     · pricing_mode — no es una regla de elegibilidad. 'consult' significa
--       "el precio lo coordina el asesor", no "no se puede reservar".
--
-- ── POR QUÉ UNA FUNCIÓN Y NO UN TRIGGER ─────────────────────────────────────
--
-- La disponibilidad SÍ tiene un trigger duro (trg_guard_reservation_overlap):
-- un solapamiento es un hecho, verdadero para siempre, y ninguna reserva ya
-- existente se vuelve inválida porque otra aparezca.
--
-- La elegibilidad no es así: depende de configuración MUTABLE. Si mañana el
-- dueño sube minimum_stay_nights de 2 a 5, o baja capacity de 8 a 4, todas las
-- pre-reservas vigentes que cumplían pasarían a violar la regla. Un trigger las
-- volvería inconfirmables retroactivamente — confirmar una pre-reserva legítima
-- fallaría por un cambio de configuración posterior. Eso sería un bug, no una
-- garantía.
--
-- Así que se centraliza igual que el pricing en 3E-A.1: UNA función, llamada
-- por todos los writers. La aritmética y los umbrales existen una sola vez.
--
-- ── SEMÁNTICA EXACTA, TOMADA DEL ESQUEMA REAL ───────────────────────────────
--
-- minimum_stay_nights: INTEGER NOT NULL DEFAULT 1, CHECK (>= 1).
--   NULL es imposible y 0 es imposible. El `?? 1` que tenía el TypeScript era
--   código defensivo muerto. La comparación es `noches < minimum_stay_nights`.
--
-- noches = p_end - p_start, LA MISMA expresión que quote_temporary_rental. No
--   hay dos cálculos de noches: la función devuelve `nights` para que los
--   callers no lo recalculen. Check-out es exclusivo (no se cuenta la noche de
--   salida), que es lo que ya hacía todo el sistema.
--
-- capacity: INTEGER, CHECK (NULL OR > 0). NULL = sin límite declarado, y
--   entonces la regla no aplica. Mismo tratamiento que tenía la IA.
--
-- p_guests NULL = "no se declaró cuánta gente", y la regla de capacidad se
--   saltea. Replica el `guests !== undefined` de check_property_availability,
--   donde guests es opcional.
--
-- El ORDEN de las reglas es deliberado: replica exactamente el de los tools de
-- la IA (fechas → propiedad → estado comercial → tipo de operación → capacidad
-- → estadía mínima), así el PRIMER error reportado para una misma entrada sigue
-- siendo el mismo de antes. No es cosmético: los mensajes al cliente cambiarían
-- si el orden cambiara.
--
-- SECURITY INVOKER (no DEFINER): las RLS de properties acotan al tenant del
-- caller, igual que quote_temporary_rental. STABLE: solo lee.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_temporary_rental_eligibility(
  p_tenant_id   UUID,
  p_property_id UUID,
  p_start       DATE,
  p_end         DATE,
  p_guests      INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_prop   record;
  v_nights INT;
BEGIN
  -- 1. Fechas. Primero, porque no necesita la propiedad — y porque es el orden
  --    en que ya lo hacían los tools de la IA.
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'invalid_dates');
  END IF;

  -- 2. La propiedad.
  SELECT p.title, p.commercial_status, p.operation_type,
         p.capacity, p.minimum_stay_nights
  INTO v_prop
  FROM public.properties p
  WHERE p.id = p_property_id
    AND p.tenant_id = p_tenant_id
    AND p.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'property_not_found');
  END IF;

  -- 3. Estado comercial: alquilada, pausada o vendida no acepta reservas.
  IF v_prop.commercial_status <> 'available' THEN
    RETURN jsonb_build_object(
      'eligible',          false,
      'reason',            'property_not_available',
      'commercial_status', v_prop.commercial_status
    );
  END IF;

  -- 4. Tipo de operación: venta o alquiler tradicional no acepta reservas
  --    de alquiler temporal.
  IF v_prop.operation_type <> 'temporary_rental' THEN
    RETURN jsonb_build_object(
      'eligible',       false,
      'reason',         'not_temporary_rental',
      'operation_type', v_prop.operation_type
    );
  END IF;

  v_nights := p_end - p_start;

  -- 5. Capacidad. capacity NULL = sin límite declarado; p_guests NULL = no se
  --    declaró cuánta gente. En cualquiera de los dos casos no hay nada que
  --    comparar.
  IF p_guests IS NOT NULL
     AND v_prop.capacity IS NOT NULL
     AND p_guests > v_prop.capacity
  THEN
    RETURN jsonb_build_object(
      'eligible',         false,
      'reason',           'capacity_exceeded',
      'capacity',         v_prop.capacity,
      'requested_guests', p_guests
    );
  END IF;

  -- 6. Estadía mínima.
  IF v_nights < v_prop.minimum_stay_nights THEN
    RETURN jsonb_build_object(
      'eligible',            false,
      'reason',              'minimum_stay_not_met',
      'minimum_stay_nights', v_prop.minimum_stay_nights,
      'requested_nights',    v_nights
    );
  END IF;

  RETURN jsonb_build_object(
    'eligible',            true,
    'nights',              v_nights,
    'minimum_stay_nights', v_prop.minimum_stay_nights,
    'capacity',            v_prop.capacity
  );
END;
$function$;

COMMENT ON FUNCTION public.check_temporary_rental_eligibility(UUID, UUID, DATE, DATE, INT) IS
  'Fase 3E-A.2: ÚNICA fuente de verdad de las reglas que determinan si una '
  'reserva de alquiler temporal puede existir (fechas, propiedad, estado '
  'comercial, tipo de operación, capacidad, estadía mínima). La llaman los '
  'cinco writers: los dos tools de la IA, la creación manual, la '
  'reprogramación y decide_operation_request. Devuelve el mismo `nights` que '
  'usa quote_temporary_rental, así que no hay dos cálculos de noches. '
  'Deliberadamente NO incluye published (visibilidad de catálogo) ni fecha de '
  'inicio pasada (depende del actor: un asesor carga reservas retroactivas). '
  'Es una función y no un trigger porque depende de configuración mutable: un '
  'cambio posterior de minimum_stay_nights o capacity no debe invalidar '
  'reservas ya creadas.';

-- Supabase otorga EXECUTE por ALTER DEFAULT PRIVILEGES a anon/authenticated/
-- service_role en funciones nuevas de public, y REVOKE FROM PUBLIC no lo
-- deshace. Hay que revocar por rol.
REVOKE ALL ON FUNCTION public.check_temporary_rental_eligibility(UUID, UUID, DATE, DATE, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_temporary_rental_eligibility(UUID, UUID, DATE, DATE, INT) FROM anon;

GRANT EXECUTE ON FUNCTION public.check_temporary_rental_eligibility(UUID, UUID, DATE, DATE, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_temporary_rental_eligibility(UUID, UUID, DATE, DATE, INT) TO service_role;

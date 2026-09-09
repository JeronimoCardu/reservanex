-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-A — guarda única de solapamiento para TODOS los writers
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL PROBLEMA ─────────────────────────────────────────────────────────────
--
-- reservations no tiene EXCLUDE constraint, y todos los caminos que ocupan
-- fechas hacen "chequear disponibilidad → escribir" en sentencias separadas.
-- Entre las dos hay una ventana TOCTOU: dos writers pueden ver libre lo mismo
-- y ambos escribir.
--
-- ── AUDITORÍA DE WRITERS (§1) ───────────────────────────────────────────────
--
--   writer                                   status        ¿chequea?  ¿lock?
--   ─────────────────────────────────────────────────────────────────────────
--   createReservationAction                  cualquiera    sí (3 capas)  NO
--   create_pending_reservation (IA)          pre_reserved  sí           NO
--   confirmReservationAction                 confirmed     sí (3 capas)  NO
--   rescheduleReservationAction              (mueve fechas) sí (3 capas) NO
--   decide_operation_request (3E-A)          pre_reserved  sí (SQL)     SÍ
--   updateReservationStatusAction            inquiry|interested — no bloqueante
--   cancel-recent-reservation (IA)           cancelled     — libera
--   reservation-payments (x3)                solo payment_status — no bloqueante
--
-- O sea: CUATRO writers bloqueantes sin lock, no uno. El riesgo reportado como
-- "el camino de la IA" era en realidad más amplio.
--
-- ── POR QUÉ UN TRIGGER Y NO CUATRO RPC ──────────────────────────────────────
--
-- La alternativa era mover cada camino a su propia RPC transaccional. Se
-- descartó por tres razones:
--
--   1. Serían cuatro implementaciones de la misma regla, que es exactamente la
--      divergencia que §3 pide evitar. Un trigger es UNA implementación.
--   2. Un writer futuro que nadie recuerde proteger queda cubierto solo.
--   3. No toca una línea del camino de la IA, así que su pricing en TypeScript,
--      sus mensajes y su reservation_event quedan intactos (§4). Mover ese
--      cálculo a SQL habría sido reimplementar pricing.
--
-- Un EXCLUDE constraint no sirve acá: la regla depende de expires_at > now()
-- para las pre-reservas, y eso no es inmutable, así que no es indexable.
--
-- ── LA PRIMITIVA ────────────────────────────────────────────────────────────
--
-- La misma que ya usa decide_operation_request: lock de la fila de properties.
-- Tomarlo dentro del trigger significa que se toma en la MISMA transacción que
-- el INSERT/UPDATE, sin importar quién lo haya disparado. Dos writers sobre la
-- misma propiedad se serializan; el segundo ve lo que escribió el primero.
--
-- Los chequeos de disponibilidad que ya hacen las actions y la IA NO se
-- eliminan: siguen sirviendo para dar un mensaje lindo antes de intentar. Lo
-- que cambia es que ahora son una optimización, no la garantía.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_reservation_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_conflict_id     UUID;
  v_conflict_source TEXT;
  v_era_bloqueante  BOOLEAN;
BEGIN
  -- Solo interesa el estado RESULTANTE bloqueante y con propiedad.
  IF NEW.property_id IS NULL
     OR NEW.deleted_at IS NOT NULL
     OR NEW.status NOT IN ('pre_reserved', 'confirmed')
  THEN
    RETURN NEW;
  END IF;

  -- En UPDATE, solo re-chequear si cambió algo que pueda crear un solapamiento
  -- nuevo. Sin esto, cada marca de pago o cada nota pagaría el lock y el
  -- chequeo sin motivo.
  IF TG_OP = 'UPDATE' THEN
    v_era_bloqueante := (OLD.status IN ('pre_reserved','confirmed') AND OLD.deleted_at IS NULL);

    IF v_era_bloqueante
       AND OLD.property_id IS NOT DISTINCT FROM NEW.property_id
       AND OLD.start_date  IS NOT DISTINCT FROM NEW.start_date
       AND OLD.end_date    IS NOT DISTINCT FROM NEW.end_date
    THEN
      -- Ya bloqueaba exactamente lo mismo: nada nuevo que verificar.
      -- (pre_reserved → confirmed sobre las mismas fechas cae acá.)
      RETURN NEW;
    END IF;
  END IF;

  -- ── La primitiva: lock de la propiedad ──────────────────────────────────
  -- Serializa a todos los writers de ESTA propiedad dentro de la transacción.
  PERFORM 1 FROM public.properties WHERE id = NEW.property_id FOR UPDATE;

  -- ── Las mismas tres capas de availability-check.shared.ts ───────────────
  -- Excluyendo la propia fila, para que un UPDATE no choque consigo mismo.

  SELECT r.id INTO v_conflict_id
  FROM public.reservations r
  WHERE r.tenant_id = NEW.tenant_id
    AND r.property_id = NEW.property_id
    AND r.id <> NEW.id
    AND r.status = 'confirmed'
    AND r.deleted_at IS NULL
    AND r.start_date < NEW.end_date
    AND r.end_date   > NEW.start_date
  LIMIT 1;
  IF FOUND THEN v_conflict_source := 'confirmed'; END IF;

  IF v_conflict_id IS NULL THEN
    SELECT r.id INTO v_conflict_id
    FROM public.reservations r
    WHERE r.tenant_id = NEW.tenant_id
      AND r.property_id = NEW.property_id
      AND r.id <> NEW.id
      AND r.status = 'pre_reserved'
      AND r.deleted_at IS NULL
      AND r.expires_at > NOW()
      AND r.start_date < NEW.end_date
      AND r.end_date   > NEW.start_date
    LIMIT 1;
    IF FOUND THEN v_conflict_source := 'pre_reserved'; END IF;
  END IF;

  IF v_conflict_id IS NULL THEN
    SELECT b.id INTO v_conflict_id
    FROM public.property_availability_blocks b
    WHERE b.tenant_id = NEW.tenant_id
      AND b.property_id = NEW.property_id
      AND b.deleted_at IS NULL
      AND b.start_date < NEW.end_date
      AND b.end_date   > NEW.start_date
    LIMIT 1;
    IF FOUND THEN v_conflict_source := 'block'; END IF;
  END IF;

  IF v_conflict_id IS NOT NULL THEN
    -- 23P01 = exclusion_violation. Es literalmente lo que pasó, y le da a los
    -- callers un código estable para mapear sin parsear el mensaje.
    RAISE EXCEPTION
      'Las fechas % a % ya están ocupadas para esta propiedad (%: %)',
      NEW.start_date, NEW.end_date, v_conflict_source, v_conflict_id
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_reservation_overlap ON public.reservations;
CREATE TRIGGER trg_guard_reservation_overlap
  BEFORE INSERT OR UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_reservation_overlap();

COMMENT ON FUNCTION public.guard_reservation_overlap() IS
  'Fase 3E-A: garantía única de no-solapamiento para TODOS los writers de '
  'reservations (manual, IA, confirmación, reprogramación y aprobación de '
  'solicitudes). Lockea la fila de properties y re-verifica las tres capas de '
  'disponibilidad dentro de la misma transacción del write, cerrando la '
  'ventana entre "chequear" y "escribir". Solo actúa cuando el estado '
  'resultante bloquea (pre_reserved|confirmed, no borrada, con propiedad) y, '
  'en UPDATE, solo si cambiaron propiedad o fechas. Levanta 23P01 '
  '(exclusion_violation) ante conflicto.';

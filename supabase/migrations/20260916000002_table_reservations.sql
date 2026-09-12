-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C2 — table_reservations: lo que el restaurante ACORDÓ,
--               distinto de lo que el cliente pidió
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── AUDITORÍA PREVIA (3E-C §1) ──────────────────────────────────────────────
--
-- No existe ninguna entidad reutilizable. Verificado contra las 41 tablas del
-- esquema con el patrón table|order|product|menu|item|stock|inventor|deliver|
-- pickup|address|kitchen|prepar|hour|shift|restaurant|dish|combo|categor:
-- CERO coincidencias. No hay mesas, ni reservas de mesa, ni menú, ni stock.
--
--   · reservations — es alquiler temporal por noches: start/end_date, guests,
--     pricing, hold, expires_at, y dispara trg_guard_reservation_overlap. Una
--     mesa no ocupa un inmueble ni bloquea fechas.
--   · property_visits — cita en una propiedad; exige property_id NOT NULL.
--   · tasks / notes / notifications — to-do genérico, texto libre, avisos.
--   · tenants.business_hours — JSONB de texto libre ({"lunes":"9 a 18"}), que
--     solo se renderiza en el sitio público. Ningún código lo parsea y ningún
--     tenant lo tiene cargado. No es un modelo horario. Ver §7 de la fase.
--
-- ── LA DISTINCIÓN QUE JUSTIFICA LA TABLA (§2) ───────────────────────────────
--
--   operation_request  = qué pidió el cliente   (date, time, people, notes)
--   table_reservation  = qué acordó el restaurante
--
-- Y acá esa distinción es MÁS fuerte que en visitas: la decisión de producto de
-- esta fase es que el restaurante PUEDE confirmar valores distintos, porque
-- pueden haberse acordado con el cliente por fuera del sistema ("¿te sirve a
-- las 21 y agrego una silla?").
--
-- El cliente pidió 20:30 para 4; el restaurante puede registrar 21:00 para 5.
-- Las dos cosas son ciertas y las dos tienen que quedar guardadas, cada una en
-- su lugar. Por eso los valores SOLICITADOS no se copian acá: viven inmutables
-- en operation_requests.requested_date / requested_time / payload_snapshot, y
-- se llegan siguiendo source_operation_request_id.
--
-- ── TIMEZONE (§3) ───────────────────────────────────────────────────────────
--
-- Se reutiliza tal cual la arquitectura validada en 3E-B2, sin una segunda
-- implementación de conversión:
--
--   scheduled_for     TIMESTAMPTZ  → el instante real
--   timezone_snapshot TEXT         → la zona con la que se interpretó
--
-- El instante lo calcula public.resolve_tenant_local_instant(), el MISMO helper
-- que usan las visitas. El navegador nunca es la autoridad de zona.
--
-- El snapshot congela la interpretación: si mañana el restaurante corrige su
-- timezone, una reserva ya acordada tiene que seguir diciendo la hora que se
-- acordó.
--
-- ── SIN MESAS Y SIN CAPACIDAD (§6) ──────────────────────────────────────────
--
-- No hay table_id: el producto no modela mesas individuales. Tampoco hay
-- capacidad total, cantidad de mesas, turnos ni duración de una reserva.
--
-- CONSECUENCIA EXPLÍCITA Y DELIBERADA: en V1 dos reservas para las 20:30
-- conviven sin conflicto. No se agrega ningún constraint de "una reserva por
-- horario" porque sería incorrecto — un restaurante tiene muchas mesas — ni
-- ninguna detección de sobre-reserva, porque no hay datos para sostenerla.
--
-- ── SIN HORARIO COMERCIAL (§7) ──────────────────────────────────────────────
--
-- La única regla temporal de V1 es scheduled_for > NOW(). Se puede registrar
-- una reserva a las 4 AM porque nada en el sistema sabe cuándo abre el local.
-- Es una limitación conocida, no un descuido.
--
-- ── SIN SOFT DELETE ─────────────────────────────────────────────────────────
--
-- El ciclo ya tiene 'cancelled' para "esta reserva no va a ocurrir", y RLS no
-- concede DELETE a nadie. Mismo criterio que property_visits.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.table_reservations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id                  UUID NOT NULL REFERENCES public.contacts(id),

  -- Una operation_request produce COMO MÁXIMO una reserva. La garantía es la
  -- UNIQUE, no un SELECT previo: sobrevive a reintentos y a concurrencia.
  -- Mismo patrón que reservations.source_operation_request_id (3E-A) y
  -- property_visits.source_operation_request_id (3E-B2).
  source_operation_request_id UUID NOT NULL UNIQUE REFERENCES public.operation_requests(id),

  -- Lo ACORDADO. Lo solicitado vive en la operation_request.
  scheduled_for               TIMESTAMPTZ NOT NULL,
  timezone_snapshot           TEXT        NOT NULL,
  party_size                  INTEGER     NOT NULL,

  status                      TEXT NOT NULL DEFAULT 'confirmed',

  -- Actores y momentos, con el par <verbo>_at / <verbo>_by que usan
  -- reservations y property_visits.
  confirmed_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  completed_at                TIMESTAMPTZ,
  completed_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  cancelled_at                TIMESTAMPTZ,
  cancelled_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  cancellation_reason         TEXT,
  no_show_at                  TIMESTAMPTZ,
  no_show_by                  UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  -- TEXT + CHECK, como operation_requests, property_visits y form_submissions.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='table_reservations_status_check'
                 AND conrelid='public.table_reservations'::regclass) THEN
    ALTER TABLE public.table_reservations ADD CONSTRAINT table_reservations_status_check
      CHECK (status IN ('confirmed', 'completed', 'cancelled', 'no_show'));
  END IF;

  -- Coherencia estado ↔ marcas. Cada estado terminal dice cuándo ocurrió, y
  -- ninguno puede tener las marcas de otro.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='table_reservations_lifecycle_coherence_check'
                 AND conrelid='public.table_reservations'::regclass) THEN
    ALTER TABLE public.table_reservations ADD CONSTRAINT table_reservations_lifecycle_coherence_check
      CHECK (
        (status = 'confirmed' AND completed_at IS NULL     AND cancelled_at IS NULL     AND no_show_at IS NULL) OR
        (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL     AND no_show_at IS NULL) OR
        (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL     AND no_show_at IS NULL) OR
        (status = 'no_show'   AND no_show_at   IS NOT NULL AND completed_at IS NULL     AND cancelled_at IS NULL)
      );
  END IF;

  -- Mismo rango que valida el formulario público (1..50). No se inventa una
  -- capacidad máxima del restaurante: es el rango que el cliente puede pedir.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='table_reservations_party_size_check'
                 AND conrelid='public.table_reservations'::regclass) THEN
    ALTER TABLE public.table_reservations ADD CONSTRAINT table_reservations_party_size_check
      CHECK (party_size >= 1 AND party_size <= 50);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='table_reservations_cancellation_reason_check'
                 AND conrelid='public.table_reservations'::regclass) THEN
    ALTER TABLE public.table_reservations ADD CONSTRAINT table_reservations_cancellation_reason_check
      CHECK (cancellation_reason IS NULL OR length(cancellation_reason) <= 500);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='table_reservations_timezone_snapshot_check'
                 AND conrelid='public.table_reservations'::regclass) THEN
    ALTER TABLE public.table_reservations ADD CONSTRAINT table_reservations_timezone_snapshot_check
      CHECK (length(btrim(timezone_snapshot)) > 0);
  END IF;
END $$;

-- El listado del dashboard es cronológico y filtra por estado.
CREATE INDEX IF NOT EXISTS idx_table_reservations_tenant_status_scheduled
  ON public.table_reservations (tenant_id, status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_table_reservations_contact
  ON public.table_reservations (tenant_id, contact_id);

-- ── Coherencia de tenant, garantizada por la base ───────────────────────────
--
-- Las FK garantizan que el contacto y la solicitud EXISTEN, no que sean del
-- MISMO tenant que la reserva. Mismo criterio que
-- trg_guard_property_visit_tenant: un writer futuro que nadie recuerde
-- proteger queda cubierto igual.
CREATE OR REPLACE FUNCTION public.guard_table_reservation_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = NEW.contact_id AND c.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'El contacto % no pertenece al tenant %', NEW.contact_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.operation_requests o
    WHERE o.id = NEW.source_operation_request_id AND o.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'La solicitud % no pertenece al tenant %', NEW.source_operation_request_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_table_reservation_tenant ON public.table_reservations;
CREATE TRIGGER trg_guard_table_reservation_tenant
  BEFORE INSERT OR UPDATE OF tenant_id, contact_id, source_operation_request_id
  ON public.table_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_table_reservation_tenant();

DROP TRIGGER IF EXISTS set_table_reservations_updated_at ON public.table_reservations;
CREATE TRIGGER set_table_reservations_updated_at
  BEFORE UPDATE ON public.table_reservations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- §17 — se reutiliza audit_table_change → audit_logs, el mismo sistema que
-- tienen reservations, operation_requests y property_visits.
DROP TRIGGER IF EXISTS trg_audit_table_reservations ON public.table_reservations;
CREATE TRIGGER trg_audit_table_reservations
  AFTER INSERT OR UPDATE OR DELETE ON public.table_reservations
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

-- ── RLS (§16) ───────────────────────────────────────────────────────────────
--
-- SELECT tenant-scoped. INSERT/UPDATE/DELETE: NADIE, ni el owner. Toda mutación
-- pasa por las RPC SECURITY DEFINER de esta fase, que revalidan permiso, estado
-- y transición. Mismo criterio que property_visits y operation_requests: si el
-- browser pudiera escribir la tabla podría fabricar una reserva sin solicitud,
-- saltarse una transición o poner un confirmed_by que no es quien confirmó.
ALTER TABLE public.table_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_select_table_reservations ON public.table_reservations;
CREATE POLICY tenant_select_table_reservations
  ON public.table_reservations
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

-- Impersonación: SOLO lectura, espejando lo que la tabla concede al tenant.
DROP POLICY IF EXISTS sa_imp_select_table_reservations ON public.table_reservations;
CREATE POLICY sa_imp_select_table_reservations
  ON public.table_reservations
  FOR SELECT TO authenticated
  USING (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());

-- ── Grants reales (§16) ─────────────────────────────────────────────────────
--
-- Supabase otorga INSERT/UPDATE/DELETE a anon y authenticated en toda tabla
-- nueva de public vía ALTER DEFAULT PRIVILEGES. RLS los frena hoy, pero
-- apoyarse solo en eso significa que el día que alguien agregue una policy el
-- grant ya está puesto. Se revocan, igual que en property_visits.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.table_reservations FROM authenticated;
REVOKE ALL ON TABLE public.table_reservations FROM anon;
GRANT SELECT ON TABLE public.table_reservations TO authenticated;

COMMENT ON TABLE public.table_reservations IS
  'Fase 3E-C2: la reserva de mesa que el restaurante ACORDÓ a partir de una '
  'solicitud. NO es lo que pidió el cliente: esa evidencia vive inmutable en '
  'operation_requests (requested_date, requested_time y payload_snapshot) y no '
  'se copia acá. El restaurante puede confirmar fecha, hora o cantidad de '
  'personas distintas, porque pueden haberse acordado por fuera del sistema. '
  'V1 no modela mesas físicas ni capacidad: dos reservas al mismo horario '
  'conviven, y no hay horario comercial aplicable.';

COMMENT ON COLUMN public.table_reservations.scheduled_for IS
  'Fase 3E-C2: el instante acordado. Se calcula en SQL con '
  'resolve_tenant_local_instant() — el mismo helper que usan las visitas — '
  'a partir de la fecha y hora locales y de tenants.timezone.';

COMMENT ON COLUMN public.table_reservations.timezone_snapshot IS
  'Fase 3E-C2: la zona IANA con la que se interpretó la hora local al acordar. '
  'Congelada: si mañana cambia tenants.timezone, esta reserva sigue '
  'mostrándose con la hora que se acordó.';

COMMENT ON COLUMN public.table_reservations.party_size IS
  'Fase 3E-C2: la cantidad de personas ACORDADA, que puede diferir de la '
  'solicitada (payload_snapshot.people). Rango 1..50, el mismo que valida el '
  'formulario público — no es una capacidad del restaurante, que no existe.';

-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-B2 — property_visits: la visita que la inmobiliaria efectivamente
--               agendó, distinta de la que el cliente pidió
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── AUDITORÍA PREVIA (§1) — reconfirmada después de 3E-B1 ───────────────────
--
-- Sigue sin existir ninguna entidad reutilizable. Nada apareció desde B1:
--
--   · No hay tablas de visitas, citas, showings, meetings ni calendario
--     (0 coincidencias en information_schema con %visit%, %appointment%,
--     %showing%, %meeting%, %calendar%).
--   · tasks — to-do genérico: title/description/assigned_to/due_date/priority.
--     No tiene property_id. Es una tarea del equipo, no una cita con un
--     cliente en una propiedad concreta.
--   · reservations — ocupa fechas, tiene noches, huéspedes, pricing, hold y
--     expires_at, y dispara trg_guard_reservation_overlap. Una visita no ocupa
--     nada. Meterla ahí volvería fechas indisponibles por ir a mirar un depto.
--   · notes / notifications / documents / seller_clients — texto libre, entrega
--     de avisos, archivos y comisiones.
--   · operation_requests — sirve para la SOLICITUD y ya la representa bien,
--     pero no tiene dónde guardar la fecha/hora que la empresa acuerda, ni el
--     ciclo de vida posterior de la cita.
--
-- ── LA DISTINCIÓN QUE JUSTIFICA LA TABLA (§3) ───────────────────────────────
--
--   operation_request  = qué pidió el cliente
--   property_visit     = qué terminó agendando la inmobiliaria
--
-- La preferencia original (requested_date + preferred_time_range en
-- payload_snapshot) NO se copia acá. Queda inmutable donde está. Si alguien
-- quiere saber qué había pedido el cliente, sigue el vínculo
-- source_operation_request_id — el mismo criterio con el que 3E-A no duplicó
-- las fechas pedidas dentro de la reserva.
--
-- La hora agendada NO tiene por qué caer dentro de la franja pedida: la franja
-- era una preferencia, la cita es lo acordado. Por eso no hay ningún CHECK que
-- las relacione.
--
-- ── TIMEZONE (§4) ───────────────────────────────────────────────────────────
--
-- Esta es la primera feature del producto donde una HORA CONCRETA tiene
-- semántica real, así que hubo que decidir de verdad.
--
-- Lo que la auditoría encontró:
--   · tenants.timezone existe (TEXT NOT NULL, IANA) y hasta hoy era metadata
--     que ningún flujo consumía — su propio COMMENT lo dice.
--   · Todo el resto del producto define "hoy" como la fecha UTC
--     (new Date().toISOString().split('T')[0]). Eso alcanza para fechas
--     sueltas; para una cita a las 17:30 no alcanza.
--   · Los timezone de todos los tenants son nombres IANA válidos
--     (verificado contra pg_timezone_names).
--
-- Arquitectura elegida — DOS columnas:
--
--   scheduled_for     TIMESTAMPTZ  → el INSTANTE real. Ordena, filtra y compara
--                                    bien, y es lo que van a necesitar las
--                                    notificaciones y los calendarios futuros.
--   timezone_snapshot TEXT         → la zona con la que se interpretó la hora
--                                    local al agendar.
--
-- El instante se calcula en SQL, no en el browser:
--
--     (p_scheduled_date + p_scheduled_time) AT TIME ZONE tenants.timezone
--
-- El navegador NUNCA es la autoridad: manda fecha y hora locales del tenant, y
-- la base resuelve. Un asesor de vacaciones en otro huso agenda igual.
--
-- Por qué el snapshot: si mañana el tenant corrige su timezone, las visitas ya
-- agendadas tienen que seguir significando lo mismo. Con el snapshot, mostrar
-- una visita histórica es `scheduled_for AT TIME ZONE timezone_snapshot`, y esa
-- lectura no cambia nunca. Sin él, cambiar tenants.timezone reescribiría el
-- pasado.
--
-- Descartado: guardar la hora local suelta (DATE + TIME) sin instante —
-- imposible ordenar o comparar entre tenants, e imposible notificar. También
-- descartado guardar solo TIMESTAMPTZ — se pierde la zona con la que se
-- acordó, y "17:30" deja de ser reconstruible.
--
-- ── SIN CONFLICTOS DE AGENDA (§11) ──────────────────────────────────────────
--
-- NO hay constraint de un visitante por propiedad y hora, ni de asesor, ni de
-- horario comercial. No existe infraestructura de agenda —ni horarios de
-- tenant, ni disponibilidad de asesores, ni asignación— y prometer detección de
-- choques sin poder sostenerla sería peor que no prometerla.
--
-- CONSECUENCIA EXPLÍCITA: en V1 dos visitas pueden coexistir a la misma hora en
-- la misma propiedad. Es una decisión, no un descuido.
--
-- ── SIN SOFT DELETE ─────────────────────────────────────────────────────────
--
-- reservations tiene deleted_at; operation_requests no. Acá tampoco: el ciclo
-- de vida ya tiene 'cancelled' para "esta visita no va a ocurrir", y RLS no
-- concede DELETE a nadie. Una columna de borrado suave sin camino de borrado
-- sería decorativa.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.property_visits (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id                  UUID NOT NULL REFERENCES public.contacts(id),
  property_id                 UUID NOT NULL REFERENCES public.properties(id),

  -- §2 — UNA operation_request produce COMO MÁXIMO UNA visita. La garantía es
  -- la UNIQUE, no un SELECT previo: sobrevive a reintentos y a concurrencia.
  -- Mismo patrón que operation_requests.source_submission_id (3C) y que
  -- reservations.source_operation_request_id (3E-A).
  source_operation_request_id UUID NOT NULL UNIQUE REFERENCES public.operation_requests(id),

  scheduled_for               TIMESTAMPTZ NOT NULL,
  timezone_snapshot           TEXT        NOT NULL,

  status                      TEXT NOT NULL DEFAULT 'scheduled',

  -- Actores y momentos, con el par <verbo>_at / <verbo>_by que ya usa
  -- reservations (confirmed_by, completed_by, cancelled_by).
  scheduled_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  completed_at                TIMESTAMPTZ,
  completed_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  cancelled_at                TIMESTAMPTZ,
  cancelled_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  cancellation_reason         TEXT,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  -- Taxonomía TEXT + CHECK, como operation_requests y form_submissions: la
  -- fuente tipada vive en el código, no en un enum de PG.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='property_visits_status_check'
                 AND conrelid='public.property_visits'::regclass) THEN
    ALTER TABLE public.property_visits ADD CONSTRAINT property_visits_status_check
      CHECK (status IN ('scheduled', 'completed', 'cancelled'));
  END IF;

  -- Coherencia estado ↔ marcas: una visita realizada dice cuándo, una cancelada
  -- también, y una agendada no puede tener ninguna de las dos.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='property_visits_lifecycle_coherence_check'
                 AND conrelid='public.property_visits'::regclass) THEN
    ALTER TABLE public.property_visits ADD CONSTRAINT property_visits_lifecycle_coherence_check
      CHECK (
        (status = 'scheduled' AND completed_at IS NULL     AND cancelled_at IS NULL) OR
        (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL) OR
        (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='property_visits_cancellation_reason_check'
                 AND conrelid='public.property_visits'::regclass) THEN
    ALTER TABLE public.property_visits ADD CONSTRAINT property_visits_cancellation_reason_check
      CHECK (cancellation_reason IS NULL OR length(cancellation_reason) <= 500);
  END IF;

  -- El snapshot de zona tiene que ser algo, y algo no vacío. Que sea un nombre
  -- IANA válido lo valida la RPC contra pg_timezone_names: no se puede poner en
  -- un CHECK porque esa consulta no es IMMUTABLE.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='property_visits_timezone_snapshot_check'
                 AND conrelid='public.property_visits'::regclass) THEN
    ALTER TABLE public.property_visits ADD CONSTRAINT property_visits_timezone_snapshot_check
      CHECK (length(btrim(timezone_snapshot)) > 0);
  END IF;
END $$;

-- El listado del dashboard es cronológico y filtra por estado: "próximas
-- primero". Este índice es exactamente esa consulta.
CREATE INDEX IF NOT EXISTS idx_property_visits_tenant_status_scheduled
  ON public.property_visits (tenant_id, status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_property_visits_property
  ON public.property_visits (tenant_id, property_id);

CREATE INDEX IF NOT EXISTS idx_property_visits_contact
  ON public.property_visits (tenant_id, contact_id);

-- ── Coherencia de tenant, garantizada por la base ───────────────────────────
--
-- Las FK sueltas garantizan que la propiedad y el contacto EXISTEN, no que
-- pertenezcan al MISMO tenant que la visita. Sin esto, una visita del tenant A
-- podría apuntar a una propiedad del tenant B.
--
-- Se resuelve con trigger y no confiando en la RPC, por la misma razón que
-- llevó a trg_guard_reservation_overlap en 3E-A: un writer futuro que nadie
-- recuerde proteger queda cubierto igual.
CREATE OR REPLACE FUNCTION public.guard_property_visit_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = NEW.property_id AND p.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'La propiedad % no pertenece al tenant %', NEW.property_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

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

DROP TRIGGER IF EXISTS trg_guard_property_visit_tenant ON public.property_visits;
CREATE TRIGGER trg_guard_property_visit_tenant
  BEFORE INSERT OR UPDATE OF tenant_id, property_id, contact_id, source_operation_request_id
  ON public.property_visits
  FOR EACH ROW EXECUTE FUNCTION public.guard_property_visit_tenant();

DROP TRIGGER IF EXISTS set_property_visits_updated_at ON public.property_visits;
CREATE TRIGGER set_property_visits_updated_at
  BEFORE UPDATE ON public.property_visits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- §21 — se reutiliza el sistema de auditoría existente (audit_table_change →
-- audit_logs), el mismo que tienen reservations, properties y
-- operation_requests. Sin sistema paralelo.
DROP TRIGGER IF EXISTS trg_audit_property_visits ON public.property_visits;
CREATE TRIGGER trg_audit_property_visits
  AFTER INSERT OR UPDATE OR DELETE ON public.property_visits
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

-- ── RLS (§20) ───────────────────────────────────────────────────────────────
--
-- SELECT tenant-scoped para authenticated, como el resto del CRM.
--
-- INSERT / UPDATE / DELETE: NADIE. Ni siquiera el owner. Toda mutación pasa por
-- las RPC SECURITY DEFINER de esta fase, que son las que revalidan permiso,
-- estado y transición. Es el mismo criterio que dejó operation_requests sin
-- UPDATE directo desde 3C: si el browser pudiera escribir la tabla, podría
-- fabricar una visita sin solicitud, moverla a completed sin pasar por la
-- transición, o ponerle un scheduled_by que no es quien la agendó.
ALTER TABLE public.property_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_select_property_visits ON public.property_visits;
CREATE POLICY tenant_select_property_visits
  ON public.property_visits
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

-- Impersonación: SOLO lectura, espejando lo que esta tabla concede al propio
-- tenant. Un super admin impersonando no puede agendar ni cancelar visitas —
-- consistente con el criterio de operation_requests, donde la impersonación
-- tampoco decide.
DROP POLICY IF EXISTS sa_imp_select_property_visits ON public.property_visits;
CREATE POLICY sa_imp_select_property_visits
  ON public.property_visits
  FOR SELECT TO authenticated
  USING (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());

COMMENT ON TABLE public.property_visits IS
  'Fase 3E-B2: la visita que la inmobiliaria efectivamente agendó a partir de '
  'una solicitud aprobada. NO es lo que pidió el cliente — esa preferencia vive '
  'inmutable en operation_requests (requested_date + preferred_time_range en '
  'payload_snapshot) y no se copia acá. La hora agendada no tiene por qué caer '
  'dentro de la franja pedida. No ocupa disponibilidad ni bloquea fechas: una '
  'visita no es una reserva. En V1 no hay detección de choques de agenda '
  '(no existe infraestructura de disponibilidad de asesores).';

COMMENT ON COLUMN public.property_visits.scheduled_for IS
  'Fase 3E-B2: el instante real de la cita. Se calcula en SQL como '
  '(fecha_local + hora_local) AT TIME ZONE tenants.timezone — el navegador '
  'nunca es la autoridad de zona horaria.';

COMMENT ON COLUMN public.property_visits.timezone_snapshot IS
  'Fase 3E-B2: la zona IANA con la que se interpretó la hora local al agendar. '
  'Congelada a propósito: si mañana cambia tenants.timezone, esta visita tiene '
  'que seguir mostrándose con la hora que se acordó. Mostrar = '
  'scheduled_for AT TIME ZONE timezone_snapshot.';

COMMENT ON COLUMN public.property_visits.source_operation_request_id IS
  'Fase 3E-B2: la solicitud que originó la visita. UNIQUE — una solicitud '
  'produce como máximo una visita, garantizado por la base y no por código.';

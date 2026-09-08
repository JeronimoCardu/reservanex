-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3C — submission confirmada → operación PENDING
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── AUDITORÍA PREVIA (§1) ───────────────────────────────────────────────────
--
-- Lo que YA existe y se evaluó para reutilizar:
--
--   · reservations — muy especializada: start/end_date, guests, snapshots de
--     precio (nightly_price_snapshot, subtotal, fees, deposit), payment_status,
--     comprobantes de pago, cancelled_by/completed_by. Es "una reserva de
--     alquiler temporal por noches", no "una solicitud genérica".
--     Su enum reservation_status es
--     inquiry|interested|pre_reserved|pending_payment|confirmed|cancelled|completed
--     — NO tiene 'pending'.
--
--   · reservation_events — bitácora específica de reservations.
--   · conversation_reservation_drafts — borrador efímero que arma la IA durante
--     la conversación; ya tiene precedente de SNAPSHOT (property_title).
--   · tasks — to-do interno (title/description/assigned_to/due_date). Es una
--     tarea del equipo, no una solicitud del cliente.
--   · availability_blocks / property_availability_blocks — bloqueo de fechas.
--   · NO existen orders, inquiries, leads ni requests. "lead_*" son columnas de
--     conversations (marketing), no una entidad.
--
-- ── POR QUÉ UNA TABLA NUEVA Y NO reservations (§3) ──────────────────────────
--
-- Opción A (reutilizar tablas específicas) se descartó por dos razones duras:
--
--   1. Solo temporary_rental tiene forma de reservation. table_reservation no
--      (no hay noches, ni unidad, ni precio); property_visit tampoco (es una
--      cita); las tres consultas son preguntas — y §10 prohíbe explícitamente
--      forzarlas a reservations. Quedarían 6 de 7 intents sin lugar.
--
--   2. MÁS GRAVE: el estado que el repo usa hoy como "pendiente de decisión"
--      en reservations es 'pre_reserved', y
--      apps/worker/src/tools/availability-check.shared.ts lo trata como fuente
--      de CONFLICTO — una reserva pre_reserved vuelve las fechas
--      INDISPONIBLES. Crear la operación así violaría el §20 de esta fase
--      ("una solicitud pendiente no debe volver una fecha indisponible
--      automáticamente"). Y usar 'inquiry'/'interested' para esquivarlo
--      ensuciaría reservations con filas que no son reservas.
--
-- Opción B (tabla base común) es la correcta, PERO acotada: las 7 intents
-- producen literalmente el mismo objeto de dominio — "un pedido del cliente
-- que la empresa tiene que aprobar o rechazar". Lo compartido (tenant,
-- contacto, estado, submission de origen, decisión, timestamps) es
-- genuinamente compartido; lo específico de cada intent NO se aplana en
-- columnas, queda en payload_snapshot. Eso evita la mega-tabla que mezcla
-- conceptos incompatibles y evita, a la vez, triplicar las mismas 6 columnas.
--
-- CONSECUENCIA DELIBERADA: esta fase NO crea filas en reservations. Una
-- reservation se creará cuando la empresa APRUEBE la solicitud (fase futura).
-- Así reservations sigue significando "una reserva de verdad" y §20 se cumple
-- por construcción: nada de lo que hace 3C toca disponibilidad.
--
-- ── TAXONOMÍAS ──────────────────────────────────────────────────────────────
-- TEXT + CHECK, como form_submissions (Fase 3A), no enums de Postgres: la
-- fuente de verdad tipada vive en packages/validators y los enums de PG no
-- llegan a Enums<> sin regenerar tipos en cada cambio.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.operation_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id            UUID NOT NULL REFERENCES public.contacts(id),
  conversation_id       UUID REFERENCES public.conversations(id),

  -- §4 — la garantía de idempotencia vive en la DB, no en un SELECT previo.
  -- UNIQUE: una submission confirmada produce COMO MÁXIMO una operación,
  -- pase lo que pase con reintentos, webhooks duplicados o carreras.
  source_submission_id  UUID NOT NULL UNIQUE REFERENCES public.form_submissions(id),

  kind                  TEXT NOT NULL,
  intent                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',

  -- Contexto de publicación. Snapshot deliberado (§7/§14): si mañana cambia
  -- el título de la propiedad, la solicitud histórica tiene que seguir
  -- diciendo por qué publicación entró el cliente. Mismo criterio que
  -- conversation_reservation_drafts.property_title.
  entity_type           TEXT,
  entity_id             UUID,
  publication_ref       TEXT,
  entity_title_snapshot TEXT,

  -- Campos operativos extraídos del payload SOLO cuando son inequívocos, para
  -- poder listar/ordenar/filtrar sin abrir el jsonb. No se deriva ni se suma
  -- nada: no hay "party_size" porque para temporary_rental habría que sumar
  -- adultos+niños+bebés, y esa clase de derivación es justamente lo que la
  -- Fase 3B prohíbe hacer con los datos del cliente.
  requested_date        DATE,
  requested_end_date    DATE,
  requested_time        TIME,

  -- Evidencia inmutable de lo que el cliente confirmó.
  payload_snapshot      JSONB NOT NULL,
  customer_confirmed_at TIMESTAMPTZ NOT NULL,

  -- Decisión humana. Se completa en una fase posterior; acá siempre nace NULL.
  decided_at            TIMESTAMPTZ,
  decided_by            UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  decision_notes        TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operation_requests_kind_check'
                 AND conrelid='public.operation_requests'::regclass) THEN
    ALTER TABLE public.operation_requests ADD CONSTRAINT operation_requests_kind_check
      CHECK (kind IN ('reservation_request','visit_request','table_request','order_request','inquiry'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operation_requests_intent_check'
                 AND conrelid='public.operation_requests'::regclass) THEN
    ALTER TABLE public.operation_requests ADD CONSTRAINT operation_requests_intent_check
      CHECK (intent IN (
        'property_inquiry','property_visit','monthly_rental_inquiry','temporary_rental',
        'general_inquiry','table_reservation','food_order'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operation_requests_status_check'
                 AND conrelid='public.operation_requests'::regclass) THEN
    ALTER TABLE public.operation_requests ADD CONSTRAINT operation_requests_status_check
      CHECK (status IN ('pending','confirmed','rejected','cancelled'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operation_requests_entity_type_check'
                 AND conrelid='public.operation_requests'::regclass) THEN
    ALTER TABLE public.operation_requests ADD CONSTRAINT operation_requests_entity_type_check
      CHECK (entity_type IS NULL OR entity_type IN ('property'));
  END IF;

  -- Coherencia: una operación decidida tiene que decir cuándo, y una no
  -- decidida no puede tener fecha de decisión.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='operation_requests_decision_coherence_check'
                 AND conrelid='public.operation_requests'::regclass) THEN
    ALTER TABLE public.operation_requests ADD CONSTRAINT operation_requests_decision_coherence_check
      CHECK (
        (status = 'pending'  AND decided_at IS NULL) OR
        (status <> 'pending' AND decided_at IS NOT NULL)
      );
  END IF;
END $$;

-- Listado del owner: lo pendiente primero, lo más nuevo arriba (§17).
CREATE INDEX IF NOT EXISTS idx_operation_requests_tenant_status_created
  ON public.operation_requests (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operation_requests_contact
  ON public.operation_requests (tenant_id, contact_id);

DROP TRIGGER IF EXISTS set_operation_requests_updated_at ON public.operation_requests;
CREATE TRIGGER set_operation_requests_updated_at
  BEFORE UPDATE ON public.operation_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- §19 — se reutiliza el sistema de auditoría existente (audit_table_change →
-- audit_logs), el mismo que ya tienen reservations, properties y tenants. No
-- se construye un segundo mecanismo. Esto es lo que va a registrar quién
-- aprueba o rechaza la solicitud cuando exista esa UI.
DROP TRIGGER IF EXISTS trg_audit_operation_requests ON public.operation_requests;
CREATE TRIGGER trg_audit_operation_requests
  AFTER INSERT OR UPDATE OR DELETE ON public.operation_requests
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

-- ── RLS (§18) ───────────────────────────────────────────────────────────────
--
-- Evaluación explícita de roles, no copia ciega de FOR ALL:
--
--   · tenant_role solo tiene owner|receptionist, y ambos operan el día a día
--     (ambos tienen *_all_reservations, *_all_contacts). Una policy
--     tenant-scoped por auth_tenant_id() los cubre exactamente a los dos, sin
--     dejar afuera a nadie ni incluir a un tercer rol que no existe.
--   · los platform_users NO son tenant_users, así que auth_tenant_id() es NULL
--     para ellos y quedan excluidos salvo por sa_imp_.
--   · INSERT: NADIE. Las operaciones solo nacen dentro de la RPC, con el
--     service role, atadas a una submission confirmada. Permitir INSERT desde
--     el CRM abriría la puerta a operaciones sin submission de origen, que es
--     justamente lo que source_submission_id NOT NULL UNIQUE existe para
--     impedir.
--   · DELETE: NADIE. Una solicitud es evidencia de un pedido real del cliente.
--     Se cancela cambiando status, no borrando la fila.
--   · UPDATE: sí, es como se aprueba/rechaza más adelante.
ALTER TABLE public.operation_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_select_operation_requests ON public.operation_requests;
CREATE POLICY tenant_select_operation_requests
  ON public.operation_requests
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS tenant_update_operation_requests ON public.operation_requests;
CREATE POLICY tenant_update_operation_requests
  ON public.operation_requests
  FOR UPDATE TO authenticated
  USING      (tenant_id = public.auth_tenant_id())
  WITH CHECK (tenant_id = public.auth_tenant_id());

-- Impersonación: mismo criterio que se aplicó a form_submissions en la Fase
-- 3A.1 — espeja los permisos de ESTA tabla (SELECT+UPDATE), no el FOR ALL de
-- documents/reservations, para que un super admin impersonando no tenga más
-- poder que el propio dueño del tenant.
DROP POLICY IF EXISTS sa_imp_select_operation_requests ON public.operation_requests;
CREATE POLICY sa_imp_select_operation_requests
  ON public.operation_requests
  FOR SELECT TO authenticated
  USING (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());

DROP POLICY IF EXISTS sa_imp_update_operation_requests ON public.operation_requests;
CREATE POLICY sa_imp_update_operation_requests
  ON public.operation_requests
  FOR UPDATE TO authenticated
  USING      (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id())
  WITH CHECK (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());

COMMENT ON TABLE public.operation_requests IS
  'Fase 3C: un pedido del cliente, nacido de una form_submission confirmada, '
  'esperando que la empresa lo apruebe o lo rechace. status=pending NO es una '
  'reserva ni un pedido aceptado: es "el cliente pidió esto". Crear la '
  'reservation/orden real es una decisión humana posterior. NO afecta '
  'disponibilidad (ver §20 de la fase).';

COMMENT ON COLUMN public.operation_requests.source_submission_id IS
  'Fase 3C: la submission que originó la operación. UNIQUE — es LA garantía de '
  'idempotencia: una submission confirmada no puede producir dos operaciones, '
  'ni siquiera bajo reintentos o requests concurrentes.';

COMMENT ON COLUMN public.operation_requests.payload_snapshot IS
  'Fase 3C: copia inmutable de form_submissions.payload al momento de confirmar. '
  'La submission sigue siendo la evidencia original y su payload no se muta '
  'nunca después de confirmed; este snapshot existe para que la operación '
  'sobreviva sin depender de leer la submission en cada consulta.';

COMMENT ON COLUMN public.operation_requests.entity_title_snapshot IS
  'Fase 3C: título de la publicación al momento del pedido. Snapshot a '
  'propósito: si la propiedad se renombra o se borra, la solicitud histórica '
  'tiene que seguir diciendo por qué publicación entró el cliente.';

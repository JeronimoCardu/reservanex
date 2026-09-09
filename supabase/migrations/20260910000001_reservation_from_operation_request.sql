-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-A — vínculo operation_request → reservation
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── AUDITORÍA PREVIA ────────────────────────────────────────────────────────
--
-- No existía ninguna referencia de reservations a operation_requests
-- (information_schema: 0 columnas con 'operation' en el nombre), así que no se
-- duplica nada.
--
-- ── LA GARANTÍA (§7) ────────────────────────────────────────────────────────
--
-- source_operation_request_id UNIQUE: una operation_request produce COMO
-- MÁXIMO una reservation, y la DB es la que lo impide — no un SELECT previo.
-- Es la misma decisión que form_submissions → operation_requests en la Fase 3C
-- (source_submission_id UNIQUE), por la misma razón: los reintentos, los
-- webhooks duplicados y las carreras no pueden crear una segunda fila.
--
-- ON DELETE RESTRICT: una reservation viva no debe quedar apuntando a una
-- operación borrada, y borrar la operación de una reserva existente sería
-- perder la trazabilidad de por qué existe esa reserva.
--
-- ── source = 'form' (§9) ────────────────────────────────────────────────────
--
-- reservations_source_check aceptaba solo 'manual' | 'ai'. Una reserva nacida
-- de un formulario aprobado no es ninguna de las dos:
--
--   'manual' significa "alguien la cargó a mano en el CRM"
--   'ai'     significa "la creó create_pending_reservation desde la conversación"
--
-- Sobrecargar 'manual' perdería la distinción justo donde importa (de dónde
-- salió la reserva). Se agrega 'form' en vez de reinterpretar un valor
-- existente.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS source_operation_request_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reservations_source_operation_request_id_fkey'
      AND conrelid = 'public.reservations'::regclass
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_source_operation_request_id_fkey
      FOREIGN KEY (source_operation_request_id)
      REFERENCES public.operation_requests(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- UNIQUE parcial: solo aplica cuando hay operación de origen, así que las
-- reservas creadas a mano o por la IA (todas con NULL) no se estorban entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_source_operation_request_key
  ON public.reservations (source_operation_request_id)
  WHERE source_operation_request_id IS NOT NULL;

-- ── source: agregar 'form' ──────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reservations'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%source%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%form%'
  ) THEN
    ALTER TABLE public.reservations DROP CONSTRAINT reservations_source_check;
    ALTER TABLE public.reservations ADD CONSTRAINT reservations_source_check
      CHECK (source IN ('manual', 'ai', 'form'));
  END IF;
END $$;

COMMENT ON COLUMN public.reservations.source_operation_request_id IS
  'Fase 3E-A: la operation_request aprobada que originó esta reserva. UNIQUE '
  '(parcial, solo cuando no es NULL) — una solicitud produce como máximo una '
  'reserva, garantizado por la DB y no por un chequeo en código. NULL para las '
  'reservas creadas a mano o por la IA.';

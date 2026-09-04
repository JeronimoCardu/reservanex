-- =============================================================================
-- 20260816000004_monthly_rental_fk_columns.sql
-- Sprint 5B — Vincula documents, tasks y notes con monthly_rental_contracts.
--
-- Agrega FK nullable monthly_rental_contract_id a:
--   - public.documents  (para contratos, comprobantes y recibos de alquiler mensual)
--   - public.tasks      (para alertas de vencimiento ligadas a contratos)
--   - public.notes      (para notas asociadas a contratos)
--
-- Además modifica las constraints de documents para ampliarlas:
--   payment_proof y receipt ahora aceptan:
--     reservation_id IS NOT NULL   (comportamiento original para reservas temporarias)
--     OR monthly_rental_contract_id IS NOT NULL  (nuevo: alquiler mensual)
--
-- IDEMPOTENTE:
--   ADD COLUMN IF NOT EXISTS
--   CREATE INDEX IF NOT EXISTS (parcial)
--   Constraints: DROP IF EXISTS + ADD IF NOT EXISTS
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A) Agregar monthly_rental_contract_id a documents, tasks, notes
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS monthly_rental_contract_id UUID
  REFERENCES public.monthly_rental_contracts(id) ON DELETE SET NULL;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS monthly_rental_contract_id UUID
  REFERENCES public.monthly_rental_contracts(id) ON DELETE SET NULL;

ALTER TABLE public.notes
  ADD COLUMN IF NOT EXISTS monthly_rental_contract_id UUID
  REFERENCES public.monthly_rental_contracts(id) ON DELETE SET NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- B) Índices parciales para FK nullable (solo filas con valor, evita overhead)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_documents_monthly_rental_contract_id
  ON public.documents (monthly_rental_contract_id)
  WHERE monthly_rental_contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_monthly_rental_contract_id
  ON public.tasks (monthly_rental_contract_id)
  WHERE monthly_rental_contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notes_monthly_rental_contract_id
  ON public.notes (monthly_rental_contract_id)
  WHERE monthly_rental_contract_id IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- C) Ampliar constraints de documents para soportar contexto de alquiler mensual
--
-- Constraints originales (20260812000001):
--   documents_payment_proof_requires_reservation  → payment_proof requiere reservation_id
--   documents_receipt_requires_reservation        → receipt requiere reservation_id
--
-- Nuevas constraints (más amplias):
--   documents_payment_proof_requires_billing_context  → reservation_id OR monthly_rental_contract_id
--   documents_receipt_requires_billing_context        → reservation_id OR monthly_rental_contract_id
--
-- El DROP es seguro porque: las filas existentes que cumplen la constraint original
-- también cumplen la nueva (si tenían reservation_id, siguen teniéndolo).
-- ─────────────────────────────────────────────────────────────────────────────

-- DROP constraints originales (si existen)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname  = 'documents_payment_proof_requires_reservation'
  ) THEN
    ALTER TABLE public.documents DROP CONSTRAINT documents_payment_proof_requires_reservation;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname  = 'documents_receipt_requires_reservation'
  ) THEN
    ALTER TABLE public.documents DROP CONSTRAINT documents_receipt_requires_reservation;
  END IF;
END $$;

-- ADD constraints ampliadas (idempotentes)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname  = 'documents_payment_proof_requires_billing_context'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_payment_proof_requires_billing_context
      CHECK (
        document_type <> 'payment_proof'
        OR reservation_id IS NOT NULL
        OR monthly_rental_contract_id IS NOT NULL
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname  = 'documents_receipt_requires_billing_context'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_receipt_requires_billing_context
      CHECK (
        document_type <> 'receipt'
        OR reservation_id IS NOT NULL
        OR monthly_rental_contract_id IS NOT NULL
      );
  END IF;
END $$;

COMMENT ON CONSTRAINT documents_payment_proof_requires_billing_context
  ON public.documents IS
  'Un comprobante de pago debe estar vinculado a una reserva temporal o a un contrato mensual.';

COMMENT ON CONSTRAINT documents_receipt_requires_billing_context
  ON public.documents IS
  'Un recibo debe estar vinculado a una reserva temporal o a un contrato mensual.';

COMMIT;

-- Sprint 2C audit: every payment_proof and receipt document must reference a reservation.
-- This migration INTENTIONALLY fails if orphaned rows exist — that means the pre-migration
-- audit was not performed.  Clean up the data before re-running.
--
-- Both constraints are idempotent: adding them a second time is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname  = 'documents_payment_proof_requires_reservation'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_payment_proof_requires_reservation
      CHECK (
        document_type <> 'payment_proof'
        OR reservation_id IS NOT NULL
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname  = 'documents_receipt_requires_reservation'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_receipt_requires_reservation
      CHECK (
        document_type <> 'receipt'
        OR reservation_id IS NOT NULL
      );
  END IF;
END $$;

COMMENT ON CONSTRAINT documents_payment_proof_requires_reservation
  ON public.documents IS
  'Every payment_proof document must be linked to a reservation.';

COMMENT ON CONSTRAINT documents_receipt_requires_reservation
  ON public.documents IS
  'Every receipt document must be linked to a reservation.';

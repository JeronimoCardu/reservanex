-- Sprint 2C-2: Link specific payment proof documents to deposit / full payment events.
-- These nullable FK columns record which comprobante the operator used when manually
-- marking a reservation's deposit or full payment as paid.  The existing payment_status,
-- deposit_paid_at, paid_at, amount_paid, and payment_notes fields are unchanged.

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS deposit_payment_proof_document_id uuid
    REFERENCES public.documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS full_payment_proof_document_id uuid
    REFERENCES public.documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.reservations.deposit_payment_proof_document_id IS
  'Optional payment_proof document that evidences the deposit payment.';
COMMENT ON COLUMN public.reservations.full_payment_proof_document_id IS
  'Optional payment_proof document that evidences full payment.';

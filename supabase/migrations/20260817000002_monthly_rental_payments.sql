-- =============================================================================
-- 20260817000002_monthly_rental_payments.sql
-- Sprint 5C.2 — Registro de pagos para cuotas de alquiler mensual.
--
-- Crea:
--   monthly_rental_payments         — pagos registrados contra una cuota
--   record_monthly_rental_payment() — RPC atómica: inserta pago + recalcula cuota
--   void_monthly_rental_payment()   — RPC atómica: anula pago + recalcula cuota
--
-- Atomicidad:
--   Las RPCs son funciones PL/pgSQL (SECURITY INVOKER). Todas las operaciones
--   ocurren en una única transacción, por lo que insertar pago + actualizar
--   amount_paid/status en monthly_rental_charges es atómico.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: monthly_rental_payments
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_rental_payments (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id)                   ON DELETE CASCADE,
  contract_id         UUID        NOT NULL REFERENCES public.monthly_rental_contracts(id)  ON DELETE CASCADE,
  charge_id           UUID        NOT NULL REFERENCES public.monthly_rental_charges(id)    ON DELETE CASCADE,

  -- Datos del pago
  amount              NUMERIC     NOT NULL,
  paid_at             DATE        NOT NULL,
  payment_method      TEXT        NOT NULL DEFAULT 'transfer',
  notes               TEXT,

  -- Referencias a documentos (futura implementación de recibos)
  receipt_document_id UUID        REFERENCES public.documents(id)     ON DELETE SET NULL,
  proof_document_id   UUID        REFERENCES public.documents(id)     ON DELETE SET NULL,

  -- Estado (active = vigente, voided = anulado)
  status              TEXT        NOT NULL DEFAULT 'active',

  -- Auditoría
  created_by          UUID        REFERENCES public.tenant_users(id)  ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at           TIMESTAMPTZ,
  voided_by           UUID        REFERENCES public.tenant_users(id)  ON DELETE SET NULL,
  void_reason         TEXT
);

-- Checks
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_payments_amount_check' AND conrelid = 'public.monthly_rental_payments'::regclass) THEN
    ALTER TABLE public.monthly_rental_payments ADD CONSTRAINT monthly_rental_payments_amount_check
      CHECK (amount > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_payments_payment_method_check' AND conrelid = 'public.monthly_rental_payments'::regclass) THEN
    ALTER TABLE public.monthly_rental_payments ADD CONSTRAINT monthly_rental_payments_payment_method_check
      CHECK (payment_method IN ('transfer', 'cash', 'check', 'card', 'other'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_payments_status_check' AND conrelid = 'public.monthly_rental_payments'::regclass) THEN
    ALTER TABLE public.monthly_rental_payments ADD CONSTRAINT monthly_rental_payments_status_check
      CHECK (status IN ('active', 'voided'));
  END IF;
END $$;

-- Índices
CREATE INDEX IF NOT EXISTS idx_monthly_rental_payments_tenant_id
  ON public.monthly_rental_payments (tenant_id);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_payments_contract_id
  ON public.monthly_rental_payments (contract_id);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_payments_charge_id
  ON public.monthly_rental_payments (charge_id);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_payments_status
  ON public.monthly_rental_payments (status);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_payments_paid_at
  ON public.monthly_rental_payments (paid_at DESC);

COMMENT ON TABLE public.monthly_rental_payments IS
  'Pagos registrados sobre cuotas de alquiler mensual. Inmutables: solo cambia status de active→voided.';


-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — monthly_rental_payments
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.monthly_rental_payments ENABLE ROW LEVEL SECURITY;

-- Super Admin en modo impersonation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_payments' AND policyname = 'sa_imp_all_monthly_rental_payments') THEN
    CREATE POLICY sa_imp_all_monthly_rental_payments
      ON public.monthly_rental_payments FOR ALL TO authenticated
      USING (
        public.is_super_admin()
        AND EXISTS (
          SELECT 1 FROM public.monthly_rental_contracts c
          WHERE c.id = monthly_rental_payments.contract_id
            AND c.tenant_id = public.auth_impersonating_tenant_id()
        )
      )
      WITH CHECK (
        public.is_super_admin()
        AND EXISTS (
          SELECT 1 FROM public.monthly_rental_contracts c
          WHERE c.id = monthly_rental_payments.contract_id
            AND c.tenant_id = public.auth_impersonating_tenant_id()
        )
      );
  END IF;
END $$;

-- Owner: acceso total
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_payments' AND policyname = 'owner_all_monthly_rental_payments') THEN
    CREATE POLICY owner_all_monthly_rental_payments
      ON public.monthly_rental_payments FOR ALL TO authenticated
      USING  (public.is_owner() AND tenant_id = public.auth_tenant_id())
      WITH CHECK (public.is_owner() AND tenant_id = public.auth_tenant_id());
  END IF;
END $$;

-- Receptionist: solo SELECT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_payments' AND policyname = 'receptionist_select_monthly_rental_payments') THEN
    CREATE POLICY receptionist_select_monthly_rental_payments
      ON public.monthly_rental_payments FOR SELECT TO authenticated
      USING (public.is_receptionist() AND tenant_id = public.auth_tenant_id());
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: compute new charge status after payment recalculation
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_charge_status_from_payment(
  p_amount_paid  numeric,
  p_total_amount numeric,
  p_due_date     date
) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_amount_paid >= p_total_amount THEN 'paid'
    WHEN p_amount_paid >  0             THEN 'partially_paid'
    WHEN p_due_date < CURRENT_DATE      THEN 'overdue'
    ELSE                                     'pending'
  END
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: record_monthly_rental_payment
-- ─────────────────────────────────────────────────────────────────────────────
-- Inserta un pago sobre una cuota y recalcula amount_paid + status de la cuota.
-- Retorna: { payment_id, amount_paid, new_status }
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_monthly_rental_payment(
  p_charge_id      uuid,
  p_amount         numeric,
  p_paid_at        date,
  p_payment_method text,
  p_notes          text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  v_tenant_id      uuid;
  v_charge         record;
  v_payment_id     uuid;
  v_new_amount_paid numeric;
  v_new_status     text;
BEGIN
  -- Auth check
  v_tenant_id := public.auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no tenant context';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Solo los owners pueden registrar pagos';
  END IF;

  -- Load charge (RLS enforces tenant ownership)
  SELECT * INTO v_charge
  FROM public.monthly_rental_charges
  WHERE id = p_charge_id AND tenant_id = v_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cuota no encontrada';
  END IF;
  IF v_charge.status = 'cancelled' THEN
    RAISE EXCEPTION 'No se puede registrar un pago en una cuota cancelada';
  END IF;
  IF v_charge.status = 'paid' THEN
    RAISE EXCEPTION 'La cuota ya está completamente pagada';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a 0';
  END IF;
  IF (v_charge.amount_paid + p_amount) > v_charge.total_amount THEN
    RAISE EXCEPTION 'El pago (%) supera el saldo pendiente (%) de la cuota',
      p_amount, (v_charge.total_amount - v_charge.amount_paid);
  END IF;

  -- Insert payment
  INSERT INTO public.monthly_rental_payments(
    tenant_id, contract_id, charge_id,
    amount, paid_at, payment_method, notes,
    status, created_by
  )
  VALUES (
    v_tenant_id, v_charge.contract_id, p_charge_id,
    p_amount, p_paid_at, p_payment_method, p_notes,
    'active', auth.uid()
  )
  RETURNING id INTO v_payment_id;

  -- Recalculate amount_paid from all active payments for this charge
  SELECT COALESCE(SUM(amount), 0) INTO v_new_amount_paid
  FROM public.monthly_rental_payments
  WHERE charge_id = p_charge_id AND status = 'active';

  v_new_status := public.compute_charge_status_from_payment(
    v_new_amount_paid, v_charge.total_amount, v_charge.due_date
  );

  -- Update charge
  UPDATE public.monthly_rental_charges
  SET amount_paid = v_new_amount_paid, status = v_new_status
  WHERE id = p_charge_id;

  RETURN jsonb_build_object(
    'payment_id',  v_payment_id,
    'amount_paid', v_new_amount_paid,
    'new_status',  v_new_status
  );
END;
$$;

COMMENT ON FUNCTION public.record_monthly_rental_payment IS
  'Atómicamente inserta un pago activo y recalcula amount_paid+status de la cuota.';


-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: void_monthly_rental_payment
-- ─────────────────────────────────────────────────────────────────────────────
-- Anula un pago activo y recalcula amount_paid + status de la cuota.
-- Retorna: { charge_id, amount_paid, new_status }
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.void_monthly_rental_payment(
  p_payment_id uuid,
  p_reason     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  v_tenant_id       uuid;
  v_payment         record;
  v_charge          record;
  v_new_amount_paid numeric;
  v_new_status      text;
BEGIN
  v_tenant_id := public.auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no tenant context';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Solo los owners pueden anular pagos';
  END IF;

  -- Load payment (RLS enforces tenant ownership)
  SELECT * INTO v_payment
  FROM public.monthly_rental_payments
  WHERE id = p_payment_id AND tenant_id = v_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago no encontrado';
  END IF;
  IF v_payment.status = 'voided' THEN
    RAISE EXCEPTION 'El pago ya está anulado';
  END IF;

  -- Void payment
  UPDATE public.monthly_rental_payments
  SET
    status      = 'voided',
    voided_at   = now(),
    voided_by   = auth.uid(),
    void_reason = p_reason
  WHERE id = p_payment_id;

  -- Load charge for recalculation
  SELECT * INTO v_charge
  FROM public.monthly_rental_charges
  WHERE id = v_payment.charge_id;

  -- Recalculate from remaining active payments
  SELECT COALESCE(SUM(amount), 0) INTO v_new_amount_paid
  FROM public.monthly_rental_payments
  WHERE charge_id = v_payment.charge_id AND status = 'active';

  v_new_status := public.compute_charge_status_from_payment(
    v_new_amount_paid, v_charge.total_amount, v_charge.due_date
  );

  UPDATE public.monthly_rental_charges
  SET amount_paid = v_new_amount_paid, status = v_new_status
  WHERE id = v_payment.charge_id;

  RETURN jsonb_build_object(
    'charge_id',   v_payment.charge_id,
    'amount_paid', v_new_amount_paid,
    'new_status',  v_new_status
  );
END;
$$;

COMMENT ON FUNCTION public.void_monthly_rental_payment IS
  'Atómicamente anula un pago y recalcula amount_paid+status de la cuota.';

COMMIT;

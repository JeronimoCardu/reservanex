-- =============================================================================
-- 20260816000003_monthly_rental_tables.sql
-- Sprint 5B — Módulo Alquileres Mensuales: tablas fundacionales.
--
-- Crea:
--   monthly_rental_contracts  — contrato de alquiler mensual por propiedad/inquilino
--   monthly_rental_charges    — cuotas/períodos generados para cada contrato
--
-- NO crea:
--   monthly_rental_payments   — Sprint 5C
--   monthly_rental_adjustments — Sprint 5D
--
-- Patrones seguidos:
--   - tenant_id en todas las tablas (RLS base)
--   - deleted_at para soft-delete en contracts
--   - updated_at automático via trigger set_updated_at() (ya existe en base_schema_v3)
--   - RLS: owner full CRUD, receptionist SELECT, sa_imp full CRUD en impersonation
--   - Constraints idempotentes via DO $$ IF NOT EXISTS $$
--   - Triggers idempotentes via DROP TRIGGER IF EXISTS + CREATE TRIGGER
--   - Índices idempotentes via CREATE INDEX IF NOT EXISTS
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: monthly_rental_contracts
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_rental_contracts (
  id                           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id                    UUID        NOT NULL REFERENCES public.tenants(id)      ON DELETE CASCADE,
  property_id                  UUID        NOT NULL REFERENCES public.properties(id)   ON DELETE RESTRICT,
  contact_id                   UUID        NOT NULL REFERENCES public.contacts(id)     ON DELETE RESTRICT,

  -- Estado del contrato
  status                       TEXT        NOT NULL DEFAULT 'draft',

  -- Período
  start_date                   DATE        NOT NULL,
  end_date                     DATE,

  -- Monto
  rent_amount                  NUMERIC     NOT NULL,
  currency                     TEXT        NOT NULL DEFAULT 'ARS',

  -- Condiciones de pago
  due_day                      SMALLINT    NOT NULL DEFAULT 10,

  -- Depósito
  deposit_amount               NUMERIC,
  deposit_paid                 BOOLEAN     NOT NULL DEFAULT false,

  -- Expensas y servicios
  expenses_amount              NUMERIC,
  services_notes               TEXT,

  -- Reajuste
  adjustment_frequency_months  SMALLINT,
  adjustment_type              TEXT,
  adjustment_notes             TEXT,

  -- Notas
  contract_notes               TEXT,
  internal_notes               TEXT,

  -- Metadatos
  created_by                   UUID        REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                   TIMESTAMPTZ
);

-- Checks
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_contracts_status_check' AND conrelid = 'public.monthly_rental_contracts'::regclass) THEN
    ALTER TABLE public.monthly_rental_contracts ADD CONSTRAINT monthly_rental_contracts_status_check
      CHECK (status IN ('draft', 'active', 'ended', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_contracts_due_day_check' AND conrelid = 'public.monthly_rental_contracts'::regclass) THEN
    ALTER TABLE public.monthly_rental_contracts ADD CONSTRAINT monthly_rental_contracts_due_day_check
      CHECK (due_day BETWEEN 1 AND 31);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_contracts_rent_amount_check' AND conrelid = 'public.monthly_rental_contracts'::regclass) THEN
    ALTER TABLE public.monthly_rental_contracts ADD CONSTRAINT monthly_rental_contracts_rent_amount_check
      CHECK (rent_amount >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_contracts_deposit_amount_check' AND conrelid = 'public.monthly_rental_contracts'::regclass) THEN
    ALTER TABLE public.monthly_rental_contracts ADD CONSTRAINT monthly_rental_contracts_deposit_amount_check
      CHECK (deposit_amount IS NULL OR deposit_amount >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_contracts_expenses_amount_check' AND conrelid = 'public.monthly_rental_contracts'::regclass) THEN
    ALTER TABLE public.monthly_rental_contracts ADD CONSTRAINT monthly_rental_contracts_expenses_amount_check
      CHECK (expenses_amount IS NULL OR expenses_amount >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_contracts_adjustment_freq_check' AND conrelid = 'public.monthly_rental_contracts'::regclass) THEN
    ALTER TABLE public.monthly_rental_contracts ADD CONSTRAINT monthly_rental_contracts_adjustment_freq_check
      CHECK (adjustment_frequency_months IS NULL OR adjustment_frequency_months > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_contracts_dates_check' AND conrelid = 'public.monthly_rental_contracts'::regclass) THEN
    ALTER TABLE public.monthly_rental_contracts ADD CONSTRAINT monthly_rental_contracts_dates_check
      CHECK (end_date IS NULL OR end_date >= start_date);
  END IF;
END $$;

-- Índices
CREATE INDEX IF NOT EXISTS idx_monthly_rental_contracts_tenant_id
  ON public.monthly_rental_contracts (tenant_id);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_contracts_property_id
  ON public.monthly_rental_contracts (property_id);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_contracts_contact_id
  ON public.monthly_rental_contracts (contact_id);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_contracts_status
  ON public.monthly_rental_contracts (status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_monthly_rental_contracts_tenant_status
  ON public.monthly_rental_contracts (tenant_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_monthly_rental_contracts_end_date
  ON public.monthly_rental_contracts (end_date)
  WHERE status = 'active' AND deleted_at IS NULL;

COMMENT ON TABLE public.monthly_rental_contracts IS
  'Contratos de alquiler mensual/tradicional. Vincula una propiedad (operation_type=long_term_rental) con un inquilino (contact). status: draft→active→ended|cancelled.';


-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: monthly_rental_charges
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_rental_charges (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id)                   ON DELETE CASCADE,
  contract_id         UUID        NOT NULL REFERENCES public.monthly_rental_contracts(id)  ON DELETE CASCADE,

  -- Período
  period_year         SMALLINT    NOT NULL,
  period_month        SMALLINT    NOT NULL,
  due_date            DATE        NOT NULL,

  -- Montos
  rent_amount         NUMERIC     NOT NULL,
  expenses_amount     NUMERIC     NOT NULL DEFAULT 0,
  services_amount     NUMERIC     NOT NULL DEFAULT 0,
  adjustments_amount  NUMERIC     NOT NULL DEFAULT 0,
  late_fee_amount     NUMERIC     NOT NULL DEFAULT 0,
  total_amount        NUMERIC     NOT NULL,
  amount_paid         NUMERIC     NOT NULL DEFAULT 0,

  -- Estado
  status              TEXT        NOT NULL DEFAULT 'pending',
  notes               TEXT,

  -- Metadatos
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (contract_id, period_year, period_month)
);

-- Checks
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_charges_status_check' AND conrelid = 'public.monthly_rental_charges'::regclass) THEN
    ALTER TABLE public.monthly_rental_charges ADD CONSTRAINT monthly_rental_charges_status_check
      CHECK (status IN ('pending', 'overdue', 'partially_paid', 'paid', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_charges_period_month_check' AND conrelid = 'public.monthly_rental_charges'::regclass) THEN
    ALTER TABLE public.monthly_rental_charges ADD CONSTRAINT monthly_rental_charges_period_month_check
      CHECK (period_month BETWEEN 1 AND 12);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_charges_period_year_check' AND conrelid = 'public.monthly_rental_charges'::regclass) THEN
    ALTER TABLE public.monthly_rental_charges ADD CONSTRAINT monthly_rental_charges_period_year_check
      CHECK (period_year BETWEEN 2000 AND 2100);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monthly_rental_charges_amounts_check' AND conrelid = 'public.monthly_rental_charges'::regclass) THEN
    ALTER TABLE public.monthly_rental_charges ADD CONSTRAINT monthly_rental_charges_amounts_check
      CHECK (
        rent_amount       >= 0 AND
        expenses_amount   >= 0 AND
        services_amount   >= 0 AND
        adjustments_amount >= 0 AND
        late_fee_amount   >= 0 AND
        total_amount      >= 0 AND
        amount_paid       >= 0
      );
  END IF;
END $$;

-- Índices
CREATE INDEX IF NOT EXISTS idx_monthly_rental_charges_tenant_id
  ON public.monthly_rental_charges (tenant_id);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_charges_contract_id
  ON public.monthly_rental_charges (contract_id);

CREATE INDEX IF NOT EXISTS idx_monthly_rental_charges_due_date_pending
  ON public.monthly_rental_charges (due_date)
  WHERE status NOT IN ('paid', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_monthly_rental_charges_tenant_status
  ON public.monthly_rental_charges (tenant_id, status);

COMMENT ON TABLE public.monthly_rental_charges IS
  'Cuotas mensuales de un contrato de alquiler. Una fila por período (year+month). status: pending→overdue|partially_paid|paid|cancelled.';


-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — monthly_rental_contracts
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.monthly_rental_contracts ENABLE ROW LEVEL SECURITY;

-- Super Admin en modo impersonation: acceso total al tenant impersonado
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_contracts' AND policyname = 'sa_imp_all_monthly_rental_contracts') THEN
    CREATE POLICY sa_imp_all_monthly_rental_contracts
      ON public.monthly_rental_contracts FOR ALL TO authenticated
      USING  (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id())
      WITH CHECK (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());
  END IF;
END $$;

-- Owner: CRUD total
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_contracts' AND policyname = 'owner_all_monthly_rental_contracts') THEN
    CREATE POLICY owner_all_monthly_rental_contracts
      ON public.monthly_rental_contracts FOR ALL TO authenticated
      USING  (public.is_owner() AND tenant_id = public.auth_tenant_id())
      WITH CHECK (public.is_owner() AND tenant_id = public.auth_tenant_id());
  END IF;
END $$;

-- Receptionist: SELECT solo (MVP — sin permiso can_manage_rentals todavía)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_contracts' AND policyname = 'receptionist_select_monthly_rental_contracts') THEN
    CREATE POLICY receptionist_select_monthly_rental_contracts
      ON public.monthly_rental_contracts FOR SELECT TO authenticated
      USING (public.is_receptionist() AND tenant_id = public.auth_tenant_id());
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — monthly_rental_charges
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.monthly_rental_charges ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_charges' AND policyname = 'sa_imp_all_monthly_rental_charges') THEN
    CREATE POLICY sa_imp_all_monthly_rental_charges
      ON public.monthly_rental_charges FOR ALL TO authenticated
      USING (
        public.is_super_admin()
        AND EXISTS (
          SELECT 1 FROM public.monthly_rental_contracts c
          WHERE c.id = monthly_rental_charges.contract_id
            AND c.tenant_id = public.auth_impersonating_tenant_id()
        )
      )
      WITH CHECK (
        public.is_super_admin()
        AND EXISTS (
          SELECT 1 FROM public.monthly_rental_contracts c
          WHERE c.id = monthly_rental_charges.contract_id
            AND c.tenant_id = public.auth_impersonating_tenant_id()
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_charges' AND policyname = 'owner_all_monthly_rental_charges') THEN
    CREATE POLICY owner_all_monthly_rental_charges
      ON public.monthly_rental_charges FOR ALL TO authenticated
      USING  (public.is_owner() AND tenant_id = public.auth_tenant_id())
      WITH CHECK (public.is_owner() AND tenant_id = public.auth_tenant_id());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_rental_charges' AND policyname = 'receptionist_select_monthly_rental_charges') THEN
    CREATE POLICY receptionist_select_monthly_rental_charges
      ON public.monthly_rental_charges FOR SELECT TO authenticated
      USING (public.is_receptionist() AND tenant_id = public.auth_tenant_id());
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGERS — updated_at automático (set_updated_at ya existe en base_schema_v3)
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_monthly_rental_contracts_updated_at ON public.monthly_rental_contracts;
CREATE TRIGGER trg_monthly_rental_contracts_updated_at
  BEFORE UPDATE ON public.monthly_rental_contracts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_monthly_rental_charges_updated_at ON public.monthly_rental_charges;
CREATE TRIGGER trg_monthly_rental_charges_updated_at
  BEFORE UPDATE ON public.monthly_rental_charges
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMIT;

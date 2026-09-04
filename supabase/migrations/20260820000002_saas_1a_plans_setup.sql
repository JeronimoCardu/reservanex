-- =============================================================================
-- 20260820000002_saas_1a_plans_setup.sql
-- Sprint SaaS 1A — Planes comerciales, límites de usuarios, setup operators
-- =============================================================================
-- Cambios:
--   1. platform_role enum: agrega 'operator'
--   2. tenants: plan_code, plan_label, max_owners, max_receptionists, setup_status
--   3. is_operator() helper function
--   4. tenant_setup_assignments tabla + RLS
--   5. Backfill de tenants existentes
-- =============================================================================
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + DO $$ para constraints e índices
-- IMPORTANTE: No aplicar por MCP. Aplicar manualmente o vía pnpm db:push.
-- =============================================================================


-- ── 1. Extender platform_role enum ───────────────────────────────────────────
-- Los operators son personal interno de ReservaNex que configura el CRM
-- antes de entregarlo al owner del tenant.
ALTER TYPE public.platform_role ADD VALUE IF NOT EXISTS 'operator';


-- ── 2. Agregar columnas de plan y setup a tenants ─────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS plan_code         TEXT         NULL,
  ADD COLUMN IF NOT EXISTS plan_label        TEXT         NULL,
  ADD COLUMN IF NOT EXISTS max_owners        INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_receptionists INTEGER      NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS setup_status      TEXT         NOT NULL DEFAULT 'not_started';

-- Nota: max_users (ya existente, default 5) sirve como max_total_users.
-- No se renombra para no romper código existente.


-- ── 3. CHECK constraints ──────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_plan_code_check'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_plan_code_check
      CHECK (plan_code IS NULL OR plan_code IN (
        'agents_4', 'agents_6', 'agents_8', 'agents_10', 'custom'
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_setup_status_check'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_setup_status_check
      CHECK (setup_status IN (
        'not_started', 'assigned', 'in_progress', 'completed', 'approved', 'revoked'
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_max_owners_check'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_max_owners_check
      CHECK (max_owners >= 1);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_max_receptionists_check'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_max_receptionists_check
      CHECK (max_receptionists >= 0);
  END IF;
END $$;


-- ── 4. Backfill de tenants existentes ─────────────────────────────────────────
-- Asigna plan_code 'agents_4' como base para todos los tenants existentes.
-- El super admin puede cambiarlo manualmente desde el panel.
UPDATE public.tenants
SET
  plan_code         = 'agents_4',
  plan_label        = 'Plan 4 agentes',
  max_owners        = 1,
  max_receptionists = 4,
  setup_status      = CASE
    WHEN onboarding_status IN ('delivered', 'ready_to_deliver') THEN 'completed'
    WHEN onboarding_status IN ('meta_setup', 'testing')          THEN 'in_progress'
    WHEN onboarding_status = 'approved'                          THEN 'assigned'
    ELSE 'not_started'
  END
WHERE deleted_at IS NULL
  AND plan_code IS NULL;


-- ── 5. is_operator() helper ──────────────────────────────────────────────────
-- Sigue el mismo patrón que is_super_admin(), is_seller(), etc.
CREATE OR REPLACE FUNCTION public.is_operator()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'user_type') = 'platform_user'
    AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'operator',
    false
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated;


-- ── 6. tenant_setup_assignments ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenant_setup_assignments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  operator_id   UUID        NOT NULL REFERENCES public.platform_users(id),
  status        TEXT        NOT NULL DEFAULT 'active',
  assigned_by   UUID        NULL REFERENCES public.platform_users(id),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ NULL,
  completed_at  TIMESTAMPTZ NULL,
  completed_by  UUID        NULL REFERENCES public.platform_users(id),
  revoked_at    TIMESTAMPTZ NULL,
  revoked_by    UUID        NULL REFERENCES public.platform_users(id),
  notes         TEXT        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tenant_setup_assignments_status_check
    CHECK (status IN ('active', 'completed', 'revoked', 'expired'))
);

COMMENT ON TABLE public.tenant_setup_assignments IS
  'Asignaciones de operators internos de ReservaNex a tenants para configuración inicial. '
  'El operator no ocupa cupo del plan — no es tenant_user.';

-- Un solo assignment activo por par (tenant, operator)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_tsa_unique_active_tenant_operator'
      AND tablename = 'tenant_setup_assignments'
  ) THEN
    CREATE UNIQUE INDEX idx_tsa_unique_active_tenant_operator
      ON public.tenant_setup_assignments (tenant_id, operator_id)
      WHERE status = 'active';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tsa_operator_id
  ON public.tenant_setup_assignments (operator_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_tsa_tenant_id
  ON public.tenant_setup_assignments (tenant_id)
  WHERE status = 'active';

-- updated_at trigger
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_updated_at_tenant_setup_assignments'
  ) THEN
    CREATE TRIGGER set_updated_at_tenant_setup_assignments
      BEFORE UPDATE ON public.tenant_setup_assignments
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ── 7. RLS para tenant_setup_assignments ─────────────────────────────────────

ALTER TABLE public.tenant_setup_assignments ENABLE ROW LEVEL SECURITY;

-- Super admin: acceso total
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'sa_all_tenant_setup_assignments'
      AND tablename  = 'tenant_setup_assignments'
  ) THEN
    CREATE POLICY "sa_all_tenant_setup_assignments"
    ON public.tenant_setup_assignments FOR ALL TO authenticated
    USING  (public.is_super_admin())
    WITH CHECK (public.is_super_admin());
  END IF;
END $$;

-- Operator: puede leer sus propios assignments
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'operator_select_own_assignments'
      AND tablename  = 'tenant_setup_assignments'
  ) THEN
    CREATE POLICY "operator_select_own_assignments"
    ON public.tenant_setup_assignments FOR SELECT TO authenticated
    USING (
      public.is_operator()
      AND operator_id = auth.uid()
    );
  END IF;
END $$;

-- Operator: puede marcar sus assignments activos como 'completed'
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'operator_complete_own_active_assignments'
      AND tablename  = 'tenant_setup_assignments'
  ) THEN
    CREATE POLICY "operator_complete_own_active_assignments"
    ON public.tenant_setup_assignments FOR UPDATE TO authenticated
    USING (
      public.is_operator()
      AND operator_id = auth.uid()
      AND status = 'active'
    )
    WITH CHECK (
      public.is_operator()
      AND operator_id = auth.uid()
    );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.tenant_setup_assignments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tenant_setup_assignments TO service_role;

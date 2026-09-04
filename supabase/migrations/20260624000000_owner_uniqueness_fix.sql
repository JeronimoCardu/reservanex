-- Migration: 20260624000000_owner_uniqueness_fix.sql
-- Guarantees at most one active owner per tenant at the database level.
-- Fixes B2 TOCTOU race condition identified in Phase 2 audit.
--
-- Rollback:
--   DROP INDEX IF EXISTS public.idx_one_active_owner_per_tenant;

-- ─── 1. Pre-flight check ────────────────────────────────────────────────────
-- Abort if the data already violates the constraint we are about to create.
-- Resolving violations manually is required before applying this migration.

DO $$
DECLARE
  violation_count integer;
BEGIN
  SELECT COUNT(*) INTO violation_count
  FROM (
    SELECT tenant_id
    FROM   public.tenant_users
    WHERE  role = 'owner'
      AND  active = true
    GROUP  BY tenant_id
    HAVING COUNT(*) > 1
  ) v;

  IF violation_count > 0 THEN
    RAISE EXCEPTION
      'Cannot apply migration: % tenant(s) already have more than one active owner. '
      'Run the diagnostic query below, resolve violations, then retry. '
      'SELECT tenant_id, COUNT(*) FROM public.tenant_users WHERE role = ''owner'' '
      'AND active = true GROUP BY tenant_id HAVING COUNT(*) > 1;',
      violation_count;
  END IF;
END $$;

-- ─── 2. Partial unique index ────────────────────────────────────────────────
-- Only rows where role = 'owner' AND active = true participate in the
-- uniqueness guarantee. Inactive owners (active = false) and all receptionists
-- are outside the index — no constraint applies to them.
--
-- Covered transitions:
--   owner → receptionist  : row leaves the index, constraint released ✓
--   receptionist → owner  : row enters the index, constraint checked  ✓
--   deactivate owner      : active = false, row leaves the index       ✓
--   reactivate old owner  : active = true, constraint fires if another
--                           active owner exists                         ✓
--   new tenant creation   : single owner insert, no conflict           ✓
--
-- Note: CREATE INDEX CONCURRENTLY is not available inside a transaction.
-- For zero-downtime deployment on a high-traffic table, run this index
-- outside of a migration transaction using psql directly before applying
-- the migration, then remove the CREATE INDEX statement here.

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_owner_per_tenant
  ON public.tenant_users (tenant_id)
  WHERE (role = 'owner' AND active = true);

-- ─── 3. Validation queries (run after apply) ───────────────────────────────
-- Confirm index exists:
--   SELECT indexname, indexdef
--   FROM   pg_indexes
--   WHERE  tablename = 'tenant_users'
--     AND  indexname = 'idx_one_active_owner_per_tenant';
--
-- Confirm enforcement (should fail with unique_violation):
--   INSERT INTO public.tenant_users (id, tenant_id, name, email, role, active)
--   SELECT gen_random_uuid(), tenant_id, 'Test', 'test@test.com', 'owner', true
--   FROM   public.tenant_users
--   WHERE  role = 'owner' AND active = true
--   LIMIT  1;

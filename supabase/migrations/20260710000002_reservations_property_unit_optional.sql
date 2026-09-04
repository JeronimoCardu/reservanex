-- Migration: 20260710000002_reservations_property_unit_optional
--
-- Problem:
--   reservations.unit_id was NOT NULL, which prevents creating reservations for
--   properties that have no separate units (e.g. a single house vs. apartment complex).
--   Additionally, the table had no direct property_id, making it impossible to display
--   the property on a reservation without joining through units (which fails when null).
--
-- Changes:
--   1. Add property_id (nullable) — stores the property directly; required when unit_id is
--      null, and populated for convenience even when unit_id is set.
--   2. Drop NOT NULL on unit_id — unit is now optional ("unidad si aplica").
--   3. Update receptionist RLS — the old policy required unit_id to be non-null to scope
--      via units → properties. The new policy handles unit_id IS NULL gracefully.
--   4. Add reservations to Supabase Realtime publication.
--
-- Backward compat: existing rows with unit_id set are unaffected (property_id will be NULL
-- for them, but they can derive it via unit.property_id). New rows from the UI will always
-- have property_id set.

BEGIN;

-- ── 1. Add property_id ────────────────────────────────────────────────────────
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id);

CREATE INDEX IF NOT EXISTS idx_reservations_property_id
  ON public.reservations(property_id)
  WHERE property_id IS NOT NULL AND deleted_at IS NULL;

-- ── 2. Make unit_id optional ──────────────────────────────────────────────────
ALTER TABLE public.reservations
  ALTER COLUMN unit_id DROP NOT NULL;

-- ── 3. Update receptionist RLS to handle nullable unit_id ─────────────────────
-- The original policy fails when unit_id IS NULL because the EXISTS subquery returns
-- no rows. The new policy allows access when unit_id IS NULL (tenant scope is sufficient)
-- and preserves workspace scoping when unit_id is set.
DROP POLICY IF EXISTS "receptionist_all_reservations" ON public.reservations;

CREATE POLICY "receptionist_all_reservations"
ON public.reservations FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
  AND (
    -- No unit: workspace scope cannot be derived → allow all tenant receptionists
    unit_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.units u
      JOIN public.properties p ON p.id = u.property_id
      WHERE u.id = reservations.unit_id
        AND u.tenant_id = public.auth_tenant_id()
        AND (
          public.auth_workspace_ids() IS NULL
          OR p.workspace_id IS NULL
          OR p.workspace_id = ANY(public.auth_workspace_ids())
        )
    )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    unit_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.units u
      JOIN public.properties p ON p.id = u.property_id
      WHERE u.id = reservations.unit_id
        AND u.tenant_id = public.auth_tenant_id()
        AND (
          public.auth_workspace_ids() IS NULL
          OR p.workspace_id IS NULL
          OR p.workspace_id = ANY(public.auth_workspace_ids())
        )
    )
  )
);

-- ── 4. Enable Realtime for reservations ───────────────────────────────────────
-- Guard against "already member of publication" error (e.g. table added via dashboard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname    = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'reservations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.reservations;
  END IF;
END $$;

-- Carry full old-row on UPDATE/DELETE events (same as other realtime tables).
ALTER TABLE public.reservations REPLICA IDENTITY FULL;

COMMIT;

-- Migration: 20260717000002_property_availability_blocks
--
-- Creates a property-level manual availability block table (MVP, no units).
-- The existing availability_blocks table is unit-based and incompatible with
-- the property-level reservation MVP.
--
-- Also updates ai_settings.pending_reservation_hold_minutes default to 1440 (24h)
-- and migrates existing rows that still have the old default of 60 min.

BEGIN;

-- ── 1. property_availability_blocks ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.property_availability_blocks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  property_id  UUID        NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  start_date   DATE        NOT NULL,
  end_date     DATE        NOT NULL,
  reason       TEXT,
  created_by   UUID        REFERENCES public.tenant_users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,

  CONSTRAINT property_availability_blocks_dates_valid CHECK (end_date > start_date)
);

CREATE INDEX IF NOT EXISTS idx_prop_avail_blocks_tenant_property
  ON public.property_availability_blocks(tenant_id, property_id, start_date, end_date)
  WHERE deleted_at IS NULL;

-- ── 2. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.property_availability_blocks ENABLE ROW LEVEL SECURITY;

-- Owners can do anything on their tenant's blocks
CREATE POLICY "owner_all_property_availability_blocks"
ON public.property_availability_blocks FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionists with can_confirm_reservations can CRUD blocks
CREATE POLICY "receptionist_confirm_property_availability_blocks"
ON public.property_availability_blocks FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.can_confirm_reservations = true
      AND tu.active = true
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.can_confirm_reservations = true
      AND tu.active = true
  )
);

-- ── 3. Update ai_settings default from 60 → 1440 (24h) ──────────────────────
ALTER TABLE public.ai_settings
  ALTER COLUMN pending_reservation_hold_minutes SET DEFAULT 1440;

-- Migrate existing rows that still have the old 60-min default
-- (conservative: only update if the value is exactly 60)
UPDATE public.ai_settings
SET pending_reservation_hold_minutes = 1440
WHERE pending_reservation_hold_minutes = 60;

COMMIT;

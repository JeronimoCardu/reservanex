-- =============================================================
-- Migration: 20260627000004_sa_imp_all_unit_images
-- =============================================================
--
-- Implements audit finding A-02.
--
-- Problem:
--   property_images has four RLS policies (sa_imp, owner, receptionist, anon).
--   unit_images only had three (owner, receptionist, anon).
--   The sa_imp_all_unit_images policy was missing, leaving Super Admins
--   unable to read or write unit images when impersonating a tenant,
--   even though they can access every other object in the tenant.
--
-- Solution:
--   Add sa_imp_all_unit_images following the identical pattern as
--   sa_imp_all_property_images, adapted to the unit_images → units
--   join path (unit_images has no direct tenant_id column).
--
-- Symmetry after this migration:
--   property_images: sa_imp ✓  owner ✓  receptionist ✓  anon ✓
--   unit_images:     sa_imp ✓  owner ✓  receptionist ✓  anon ✓
--
-- Idempotency: DROP POLICY IF EXISTS before CREATE POLICY.
-- No other policies are modified.
-- =============================================================

BEGIN;

DROP POLICY IF EXISTS "sa_imp_all_unit_images" ON public.unit_images;

CREATE POLICY "sa_imp_all_unit_images"
ON public.unit_images FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_images.unit_id
      AND u.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_images.unit_id
      AND u.tenant_id = public.auth_impersonating_tenant_id()
  )
);

COMMIT;

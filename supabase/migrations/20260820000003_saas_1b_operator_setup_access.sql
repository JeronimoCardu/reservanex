-- =============================================================================
-- 20260820000003_saas_1b_operator_setup_access.sql
-- Sprint SaaS 1B — Operator setup access to tenant CRM
-- =============================================================================
-- Allows a platform operator with an active impersonation_sessions record
-- to access tenant tables needed for initial CRM setup.
--
-- The operator does NOT become a tenant_user. Access is mediated by:
--   1. impersonation_sessions (existing table, SA-audited)
--   2. tenant_setup_assignments (validates the operator is assigned to the tenant)
--
-- Strategy: extend existing impersonation pattern with is_operator_in_setup().
-- All operator policies follow the same shape as sa_imp_* policies.
--
-- Tables opened:  tenants, ai_settings, workspaces, tenant_users,
--                 user_workspace_assignments, properties, property_images,
--                 units, unit_images, availability_blocks, property_videos
-- Tables blocked: conversations, messages, contacts, reservations,
--                 documents, monthly_rentals, receipts (no policies added)
-- Storage opened: property-images (INSERT/DELETE), property-videos (INSERT/DELETE)
-- =============================================================================


-- ── 1. is_operator_in_setup() ─────────────────────────────────────────────────
-- Returns TRUE if the caller is a platform operator AND has an active
-- impersonation session (created by startSetupImpersonationAction).
-- STABLE: auth_impersonating_tenant_id() is already STABLE (cached per stmt).

CREATE OR REPLACE FUNCTION public.is_operator_in_setup()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    public.is_operator()
    AND public.auth_impersonating_tenant_id() IS NOT NULL,
    false
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_operator_in_setup() TO authenticated;

COMMENT ON FUNCTION public.is_operator_in_setup() IS
  'SaaS 1B: Returns true when the caller is a platform operator with an active '
  'impersonation session (ended_at IS NULL in impersonation_sessions). '
  'Used by operator_setup_* RLS policies.';


-- ── 2. tenants — SELECT + UPDATE ─────────────────────────────────────────────
-- Operator needs SELECT to load business settings, UPDATE to save them.

CREATE POLICY "operator_setup_select_tenants"
ON public.tenants FOR SELECT TO authenticated
USING (
  public.is_operator_in_setup()
  AND id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "operator_setup_update_tenants"
ON public.tenants FOR UPDATE TO authenticated
USING (
  public.is_operator_in_setup()
  AND id = public.auth_impersonating_tenant_id()
  AND deleted_at IS NULL
)
WITH CHECK (
  public.is_operator_in_setup()
  AND id = public.auth_impersonating_tenant_id()
);


-- ── 3. ai_settings ───────────────────────────────────────────────────────────
-- Operator configures bot behavior during setup.

CREATE POLICY "operator_setup_all_ai_settings"
ON public.ai_settings FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
);


-- ── 4. workspaces — SELECT only ──────────────────────────────────────────────
-- Operator can see workspaces to assign users correctly.
-- CREATE INDEX already exists for owner; no new index needed.

CREATE POLICY "operator_setup_select_workspaces"
ON public.workspaces FOR SELECT TO authenticated
USING (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
);


-- ── 5. tenant_users — ALL ────────────────────────────────────────────────────
-- Operator invites and manages initial users during setup.
-- Uses ALL (SELECT + INSERT + UPDATE + DELETE) to allow full user management.

CREATE POLICY "operator_setup_all_tenant_users"
ON public.tenant_users FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
);


-- ── 6. user_workspace_assignments — ALL ──────────────────────────────────────
-- Operator assigns receptionists to workspaces.

CREATE POLICY "operator_setup_all_workspace_assignments"
ON public.user_workspace_assignments FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id         = user_workspace_assignments.user_id
      AND tu.tenant_id  = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_operator_in_setup()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id         = user_workspace_assignments.user_id
      AND tu.tenant_id  = public.auth_impersonating_tenant_id()
  )
);


-- ── 7. properties — ALL ──────────────────────────────────────────────────────

CREATE POLICY "operator_setup_all_properties"
ON public.properties FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
);


-- ── 8. property_images — ALL ─────────────────────────────────────────────────

CREATE POLICY "operator_setup_all_property_images"
ON public.property_images FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_operator_in_setup()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
);


-- ── 9. units — ALL ───────────────────────────────────────────────────────────

CREATE POLICY "operator_setup_all_units"
ON public.units FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
);


-- ── 10. unit_images — ALL ────────────────────────────────────────────────────

CREATE POLICY "operator_setup_all_unit_images"
ON public.unit_images FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_images.unit_id
      AND u.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_operator_in_setup()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_images.unit_id
      AND u.tenant_id = public.auth_impersonating_tenant_id()
  )
);


-- ── 11. availability_blocks — ALL ────────────────────────────────────────────

CREATE POLICY "operator_setup_all_availability_blocks"
ON public.availability_blocks FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_operator_in_setup()
  AND tenant_id = public.auth_impersonating_tenant_id()
);


-- ── 12. property_videos — ALL ────────────────────────────────────────────────

CREATE POLICY "operator_setup_all_property_videos"
ON public.property_videos FOR ALL TO authenticated
USING (
  public.is_operator_in_setup()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_videos.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_operator_in_setup()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_videos.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
);


-- ── 13. Storage: property-images bucket ──────────────────────────────────────
-- Operators upload/delete images during property setup.
-- Path convention: property-images/{tenant_id}/{uuid}.{ext}
-- foldername(name)[1] = tenant_id segment.

CREATE POLICY "operator_setup_insert_property_images_storage"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'property-images'
  AND (storage.foldername(name))[1] = (public.auth_impersonating_tenant_id())::text
  AND public.is_operator_in_setup()
);

CREATE POLICY "operator_setup_delete_property_images_storage"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'property-images'
  AND (storage.foldername(name))[1] = (public.auth_impersonating_tenant_id())::text
  AND public.is_operator_in_setup()
);


-- ── 14. Storage: property-videos bucket ──────────────────────────────────────
-- Path convention: property-videos/{tenant_id}/{uuid}.{ext}

CREATE POLICY "operator_setup_insert_property_videos_storage"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'property-videos'
  AND (storage.foldername(name))[1] = (public.auth_impersonating_tenant_id())::text
  AND public.is_operator_in_setup()
);

CREATE POLICY "operator_setup_delete_property_videos_storage"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'property-videos'
  AND (storage.foldername(name))[1] = (public.auth_impersonating_tenant_id())::text
  AND public.is_operator_in_setup()
);

-- =============================================================================
-- 20260901000002_security_hardening_fase10.sql
-- Fase 10 — security audit findings, verified against the real linked
-- schema (Supabase's own `db advisors --type security` plus manual
-- pg_catalog inspection, re-verified during the Fase 10 Paso 2 preflight
-- with fresh queries against the live project). Every change here is
-- scoped to a confirmed real finding — nothing speculative, nothing
-- "just in case."
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0. CRITICAL — discovered during the Paso 2 preflight while re-auditing
--    tenants_public (item 4 below): the base `tenants` table itself had a
--    policy, `anon_select_active_tenants` (qual: deleted_at IS NULL, NO
--    other restriction), granting the fully-unauthenticated `anon` role
--    row-level SELECT on every non-deleted tenant. RLS is row-level only —
--    it cannot restrict which COLUMNS are visible — and `tenants` mixes
--    public-designated columns (public_name, public_phone, ...) with
--    clearly private ones on the SAME row: payment_alias, payment_cbu,
--    payment_account_holder, payment_bank, payment_notes,
--    primary_owner_name, primary_owner_email, primary_owner_phone,
--    onboarding_notes, and more.
--
--    EMPIRICALLY CONFIRMED against the real linked project (isolated test
--    fixture, immediately deleted, never the pilot tenant): an anon-key
--    client with zero session could directly read payment_cbu,
--    payment_alias, payment_account_holder, and primary_owner_email for a
--    tenant row via `select(...).eq('id', ...)`. This is a live,
--    unauthenticated, project-wide banking/PII disclosure — more severe
--    than every other finding in this migration combined.
--
--    Confirmed via repo-wide grep that NOTHING legitimate depends on this
--    policy: the public-site feature (apps/web/src/lib/repositories/
--    public-site.repository.ts) reads tenants exclusively through
--    createAdminClient() (service-role, bypasses RLS entirely) — it was
--    never relying on anon RLS access to begin with. No browser/client
--    component anywhere queries `tenants` via the anon-key browser client.
--    Dropping this policy is a pure risk-reduction with zero functional
--    impact on anything currently working.
--
--    A repo-wide sweep of every OTHER `anon_select_*` policy
--    (availability_blocks, properties, property_images, unit_images,
--    units) found them correctly scoped to published/active rows with no
--    equivalent private-column mixing — `tenants` was the only broken one.
-- =============================================================================

DROP POLICY IF EXISTS anon_select_active_tenants ON public.tenants;

COMMENT ON TABLE public.tenants IS
  'Fase 10 security fix: removed anon_select_active_tenants, a row-level '
  'policy that (because RLS cannot restrict columns) exposed every '
  'non-deleted tenant''s payment_cbu/payment_alias/payment_account_holder/ '
  'primary_owner_email and other private columns to a fully unauthenticated '
  'caller. Confirmed unused by any current code path — the public-site '
  'feature reads this table exclusively via the service-role admin client.';

-- =============================================================================
-- 1. CRITICAL — conversation_reservation_drafts had RLS disabled entirely,
--    AND the `anon` role (fully unauthenticated) held SELECT/INSERT/UPDATE/
--    DELETE/TRUNCATE on it. Confirmed via information_schema.role_table_grants
--    against the live project, and empirically with a real anon-key client:
--    unauthenticated SELECT and UPDATE both succeeded against a fixture row.
--
--    Enabled here with REAL tenant-scoped policies — not "zero policies,
--    service-role only" as originally proposed — mirroring the immediate
--    neighbor table `reservations` exactly (same owner_all / receptionist_all
--    / sa_imp_all shape, same auth_tenant_id()/auth_impersonating_tenant_id()
--    mechanism), since this table is conceptually "the draft that becomes a
--    reservation" and should carry the same real tenant-user access as its
--    neighbor, not a narrower one. Differs from reservations' policies only
--    where the schema itself differs: no deleted_at column here (so no
--    "AND deleted_at IS NULL" clause), and conversation_id is NOT NULL on
--    every row here (so no "conversation_id IS NULL OR" branch needed).
-- =============================================================================

ALTER TABLE public.conversation_reservation_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_all_conversation_reservation_drafts
  ON public.conversation_reservation_drafts
  FOR ALL
  USING (is_owner() AND tenant_id = auth_tenant_id())
  WITH CHECK (is_owner() AND tenant_id = auth_tenant_id());

CREATE POLICY receptionist_all_conversation_reservation_drafts
  ON public.conversation_reservation_drafts
  FOR ALL
  USING (
    is_receptionist() AND tenant_id = auth_tenant_id() AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.tenant_users tu ON tu.id = auth.uid() AND tu.tenant_id = c.tenant_id AND tu.active = true
      WHERE c.id = conversation_reservation_drafts.conversation_id
        AND c.tenant_id = conversation_reservation_drafts.tenant_id
        AND (c.assigned_user_id IS NULL OR c.assigned_user_id = tu.id)
    )
  )
  WITH CHECK (
    is_receptionist() AND tenant_id = auth_tenant_id() AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.tenant_users tu ON tu.id = auth.uid() AND tu.tenant_id = c.tenant_id AND tu.active = true
      WHERE c.id = conversation_reservation_drafts.conversation_id
        AND c.tenant_id = conversation_reservation_drafts.tenant_id
        AND (c.assigned_user_id IS NULL OR c.assigned_user_id = tu.id)
    )
  );

CREATE POLICY sa_imp_all_conversation_reservation_drafts
  ON public.conversation_reservation_drafts
  FOR ALL
  USING (is_super_admin() AND tenant_id = auth_impersonating_tenant_id())
  WITH CHECK (is_super_admin() AND tenant_id = auth_impersonating_tenant_id());

COMMENT ON TABLE public.conversation_reservation_drafts IS
  'Fase 10 security fix: RLS was missing entirely (confirmed via Supabase '
  'security advisors + an empirical anon-key read/write test against a real '
  'fixture). Enabled with owner/receptionist/superadmin-impersonation '
  'policies mirroring the neighboring reservations table exactly — real '
  'tenant-user access works the same way it does for reservations, cross- '
  'tenant and unauthenticated access is denied the same way.';

-- =============================================================================
-- 2. CRITICAL — Postgres RLS does NOT govern TRUNCATE (a documented Postgres
--    limitation, not a bug in any policy). Confirmed the `anon` AND
--    `authenticated` roles hold TRUNCATE on every single table in the public
--    schema (re-verified fresh during this preflight — same 36+ tables,
--    including ones with fully-correct RLS policies like conversations/
--    reservations/tenants) — this is Supabase's own project default
--    privilege grant, present since project creation, completely
--    independent of any RLS policy quality. Anyone with just the public
--    anon key could run `TRUNCATE TABLE tenants;` (or any table) and wipe
--    it for every tenant, bypassing RLS entirely, regardless of how well
--    that table's policies are written.
--
--    Revoking TRUNCATE from anon/authenticated breaks nothing: no
--    application code (browser, server action, worker, or the /platform
--    admin_purge_tenant()/RESET RESERVANEX path) ever issues a TRUNCATE —
--    every delete path is scoped DELETE/UPDATE through RLS or an explicit
--    tenant_id filter. service_role keeps TRUNCATE (untouched below) since
--    it is the fully-trusted role and nothing here needs it revoked from it.
--
--    ALTER DEFAULT PRIVILEGES: confirmed via pg_tables that every existing
--    table in this schema is owned by `postgres` (the role the Supabase
--    CLI's migration runner connects as), so the default-privilege change
--    is pinned explicitly `FOR ROLE postgres` rather than relying on
--    "whichever role happens to run this statement" — a future migration
--    creating a new table as `postgres` (the standard/only way migrations
--    run in this project) will never silently re-grant TRUNCATE to
--    anon/authenticated again.
-- =============================================================================

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;

-- =============================================================================
-- 3. CRITICAL/HIGH — claim_ai_auto_reply_slot(uuid, uuid) is SECURITY DEFINER
--    and was executable by BOTH `anon` (fully unauthenticated) and
--    `authenticated` — and, by Postgres's own default, `PUBLIC` (every
--    role, unless explicitly revoked; revoking only from anon/authenticated
--    would NOT have been sufficient, since PUBLIC is a separate, broader
--    grant target that anon/authenticated also inherit from). Its body
--    trusts the caller-supplied p_tenant_id directly (`WHERE id =
--    p_conversation_id AND tenant_id = p_tenant_id`) with no check that
--    p_tenant_id matches the calling user's own tenant — so any caller who
--    knew (or guessed) another tenant's conversation_id + tenant_id pair
--    could increment that tenant's ai_auto_replies_count directly via
--    POST /rest/v1/rpc/claim_ai_auto_reply_slot, with no session at all —
--    empirically confirmed against a real fixture.
--
--    Confirmed via repo-wide grep the ONLY real call site is
--    apps/worker/src/processor.ts:197, using the worker's own service-role
--    client — revoking PUBLIC/anon/authenticated execute breaks nothing
--    real, exactly the same REVOKE/GRANT pattern already used for
--    claim_next_outbox_item/claim_next_media_event
--    (20260826000003_device_dispatch_lease.sql).
-- =============================================================================

REVOKE ALL ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid) TO service_role;

-- =============================================================================
-- 4. LOW — tenants_public is an unused view (confirmed via repo-wide grep:
--    no code queries it — public-site.repository.ts uses its own explicit,
--    tenant-scoped query instead, via the service-role client) but is
--    still live and queryable via PostgREST by anon/authenticated. It
--    never filtered by public_site_enabled, so a tenant that has NOT
--    opted into a public site was still fully visible through it.
--
--    security_invoker was deliberately NOT enabled here: this view's own
--    purpose (if it were ever used) is to expose public-designated tenant
--    columns to anon WITHOUT depending on `tenants`' own RLS granting that
--    access — and item 0 above just removed the one policy that used to
--    do exactly that. Switching this view to security_invoker would make
--    it inherit `tenants`' RLS and return zero rows for anon, which is a
--    behavior change with no clear benefit given the view is unused today;
--    not changed without a concrete reason to.
-- =============================================================================

CREATE OR REPLACE VIEW public.tenants_public AS
  SELECT id, name, slug, logo_url, primary_color, secondary_color, site_config,
         custom_domain, public_slug, public_site_enabled, public_name,
         public_description, public_cover_image_url, public_primary_color,
         public_phone, public_email, public_instagram_url, public_website_url
  FROM public.tenants
  WHERE deleted_at IS NULL
    AND public_site_enabled = true;

COMMENT ON VIEW public.tenants_public IS
  'Fase 10 security fix: added the public_site_enabled = true filter this view '
  'was missing (confirmed unused by any current code path via repo-wide grep — '
  'public-site.repository.ts queries tenants directly instead, via the service '
  'role — but still live and queryable via PostgREST, so a disabled tenant''s '
  'public-designated columns were fully visible through it before this fix). '
  'Deliberately still SECURITY DEFINER, not security_invoker — see this '
  'migration''s inline comment for why.';

-- =============================================================================
-- 5. LOW — 8 functions had a mutable search_path (Supabase security advisor
--    WARN). Standard hardening: pin search_path so the function body can
--    never be tricked by an object created earlier in an attacker-
--    influenced search_path. Purely additive — does not change behavior for
--    any of these, all of which already only ever reference public.* /
--    unqualified names that live in the public schema.
-- =============================================================================

ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.set_task_completed_at() SET search_path = public;
ALTER FUNCTION public.set_conversation_closed_at() SET search_path = public;
ALTER FUNCTION public.clear_expires_at_on_advance() SET search_path = public;
ALTER FUNCTION public.normalize_contact_phone_ar(text) SET search_path = public;
ALTER FUNCTION public.compute_charge_status_from_payment(numeric, numeric, date) SET search_path = public;
ALTER FUNCTION public.record_monthly_rental_payment(uuid, numeric, date, text, text) SET search_path = public;
ALTER FUNCTION public.void_monthly_rental_payment(uuid, text) SET search_path = public;

COMMIT;

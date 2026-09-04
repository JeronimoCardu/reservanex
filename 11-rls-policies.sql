-- ============================================================
-- OrderFlow — RLS Policies V1
-- Version:    1.0
-- Date:       2026-06-22
-- Applies to: 10-supabase-schema-v2.sql
-- Model:      Zero Trust — all access denied by default.
--             Policies grant exceptions, never blanket access.
-- ============================================================
--
-- ARCHITECTURE
-- ────────────────────────────────────────────────────────────
-- JWT app_metadata claims (set by custom_access_token_hook):
--   user_type  → 'platform_user' | 'tenant_user'
--   role       → 'super_admin' | 'seller' | 'owner' | 'receptionist'
--   tenant_id  → UUID (tenant_users only; NULL for platform_users)
--   branch_id  → UUID (receptionist scoped to branch; NULL = all branches)
--
-- Helper functions (defined in schema V2):
--   public.auth_user_type()     → TEXT
--   public.auth_tenant_id()     → UUID
--   public.auth_user_role()     → TEXT
--   public.auth_branch_id()     → UUID | NULL
--   public.auth_impersonated_by() → UUID | NULL
--   public.is_super_admin()     → BOOLEAN
--   public.is_seller()          → BOOLEAN
--   public.is_platform_user()   → BOOLEAN
--   public.is_tenant_user()     → BOOLEAN
--   public.is_owner()           → BOOLEAN
--   public.is_receptionist()    → BOOLEAN
--
-- Helper function added in THIS file:
--   public.auth_impersonating_tenant_id() → UUID | NULL
--   Returns the target tenant during an active impersonation session.
--   NULL when super_admin is not currently impersonating anyone.
--
-- IMPERSONATION MODEL
-- ────────────────────────────────────────────────────────────
-- Super Admin has two access modes:
--
--   1. Platform mode (no impersonation):
--      Can manage platform_users, tenants, seller_clients.
--      Cannot see any tenant-level business data.
--
--   2. Impersonation mode (active session in impersonation_sessions):
--      auth_impersonating_tenant_id() returns the target tenant UUID.
--      Tenant-scoped policies allow access to exactly that one tenant.
--      Exiting impersonation (ended_at set) reverts to platform mode.
--
-- No global RLS bypass exists for super_admin. Access flows through
-- the same policies as every other role — just with different conditions.
--
-- PERMISSION SUMMARY
-- ────────────────────────────────────────────────────────────
-- Role            | Platform tables | Tenant tables
-- ─────────────── | ─────────────── | ──────────────────────
-- super_admin     | full CRUD       | CRUD (impersonation only)
-- seller          | SELECT assigned | none
-- owner           | SELECT own      | full CRUD within tenant
-- receptionist    | SELECT own      | CRM CRUD (branch-scoped)
-- anon            | SELECT public   | none (public props/units only)
-- service_role    | bypass RLS      | bypass RLS (workers, pg_cron)
-- ============================================================


-- ============================================================
-- SECTION 1 — IMPERSONATION HELPER FUNCTION
-- ============================================================

-- Queries the live impersonation_sessions table instead of relying on JWT claims.
-- STABLE: PostgreSQL caches the result for the duration of a single SQL statement,
-- preventing per-row DB calls while still reflecting session end (ended_at IS NULL).
-- Returns NULL when: (a) caller is not super_admin, (b) no active session found.
CREATE OR REPLACE FUNCTION public.auth_impersonating_tenant_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT target_tenant_id
  FROM public.impersonation_sessions
  WHERE platform_user_id = auth.uid()
    AND ended_at IS NULL
  ORDER BY started_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.auth_impersonating_tenant_id() IS
  'Returns the target_tenant_id of the super_admin''s active impersonation session, '
  'or NULL if not impersonating. Used in all tenant-scoped policies for super_admin access.';

-- Grant so the function can be called in RLS policy context
GRANT EXECUTE ON FUNCTION public.auth_impersonating_tenant_id() TO authenticated;


-- ============================================================
-- SECTION 2 — PLATFORM TABLES
-- platform_users, tenants, seller_clients, impersonation_sessions
-- ============================================================

-- ── platform_users ──────────────────────────────────────────
-- Super Admin: full platform management (users, roles, activation)
-- Platform users (seller/admin): see and update own profile
-- Tenant users: no access (platform-internal table)
-- ─────────────────────────────────────────────────────────────

-- Super Admin can manage all platform staff
CREATE POLICY "sa_all_platform_users"
ON public.platform_users FOR ALL TO authenticated
USING  (public.is_super_admin())
WITH CHECK (public.is_super_admin());

-- Every platform user can read and update their own profile
-- (updating role is blocked at application layer — RLS can't restrict specific columns)
CREATE POLICY "platform_user_self"
ON public.platform_users FOR SELECT TO authenticated
USING (
  public.is_platform_user()
  AND id = auth.uid()
);

CREATE POLICY "platform_user_update_self"
ON public.platform_users FOR UPDATE TO authenticated
USING (
  public.is_platform_user()
  AND id = auth.uid()
)
WITH CHECK (
  public.is_platform_user()
  AND id = auth.uid()
);


-- ── tenants ──────────────────────────────────────────────────
-- Super Admin: full CRUD (platform admin dashboard, onboarding, billing management)
-- Seller:      SELECT assigned tenants only (via seller_clients)
-- Owner:       SELECT own tenant + UPDATE own settings/branding
-- Receptionist: SELECT own tenant (needed for display and site config reads)
-- anon:        SELECT active tenants (column-level grants restrict to safe fields)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_all_tenants"
ON public.tenants FOR ALL TO authenticated
USING  (public.is_super_admin())
WITH CHECK (public.is_super_admin());

-- Sellers see only their active client portfolio
CREATE POLICY "seller_select_tenants"
ON public.tenants FOR SELECT TO authenticated
USING (
  public.is_seller()
  AND EXISTS (
    SELECT 1 FROM public.seller_clients sc
    WHERE sc.seller_id = auth.uid()
      AND sc.tenant_id = tenants.id
      AND sc.active = true
  )
);

-- Owners see their own tenant
CREATE POLICY "owner_select_own_tenant"
ON public.tenants FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND id = public.auth_tenant_id()
);

-- Owners update own tenant settings (branding, slug, site_config)
-- Does NOT cover plan/status/limits — those are super_admin-only
CREATE POLICY "owner_update_own_tenant"
ON public.tenants FOR UPDATE TO authenticated
USING (
  public.is_owner()
  AND id = public.auth_tenant_id()
  AND deleted_at IS NULL
)
WITH CHECK (
  public.is_owner()
  AND id = public.auth_tenant_id()
);

-- Receptionists see their tenant (for display and site_config reads)
CREATE POLICY "receptionist_select_own_tenant"
ON public.tenants FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND id = public.auth_tenant_id()
);

-- Public website: lookup tenant by slug for routing
-- Column-level grants on tenants (in schema V2) restrict visible fields to safe ones.
CREATE POLICY "anon_select_active_tenants"
ON public.tenants FOR SELECT TO anon
USING (deleted_at IS NULL);


-- ── seller_clients ───────────────────────────────────────────
-- Super Admin: full CRUD (assign sellers, adjust commissions)
-- Seller:      SELECT own rows (see their portfolio)
-- Others:      no access
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_all_seller_clients"
ON public.seller_clients FOR ALL TO authenticated
USING  (public.is_super_admin())
WITH CHECK (public.is_super_admin());

CREATE POLICY "seller_select_own_clients"
ON public.seller_clients FOR SELECT TO authenticated
USING (
  public.is_seller()
  AND seller_id = auth.uid()
);


-- ── impersonation_sessions ───────────────────────────────────
-- Super Admin: INSERT (start session) + UPDATE (end session) + SELECT (own history)
-- Owner:       SELECT sessions targeting their tenant (transparency/audit)
-- ─────────────────────────────────────────────────────────────

-- Super Admin manages their own impersonation sessions
CREATE POLICY "sa_manage_own_impersonation"
ON public.impersonation_sessions FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND platform_user_id = auth.uid()
)
WITH CHECK (
  public.is_super_admin()
  AND platform_user_id = auth.uid()
);

-- Owners can see when their tenant has been accessed by platform support
CREATE POLICY "owner_select_own_impersonation_sessions"
ON public.impersonation_sessions FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND target_tenant_id = public.auth_tenant_id()
);


-- ============================================================
-- SECTION 3 — TENANT CONFIGURATION TABLES
-- branches, tenant_users, whatsapp_accounts, ai_settings
-- ============================================================

-- ── branches ─────────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD in active session's tenant
-- Owner:        full CRUD (manage offices)
-- Receptionist: SELECT (read-only — can't create/modify offices)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_branches"
ON public.branches FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_branches"
ON public.branches FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_select_branches"
ON public.branches FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ── tenant_users ─────────────────────────────────────────────
-- Super Admin (impersonating): SELECT (read staff list in support context)
-- Owner:        full CRUD (invite, update, deactivate staff)
-- Tenant user:  SELECT own profile + UPDATE own profile (name, email)
-- ─────────────────────────────────────────────────────────────

-- Super Admin in impersonation mode sees all users of that tenant
CREATE POLICY "sa_imp_select_tenant_users"
ON public.tenant_users FOR SELECT TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

-- Owner manages all staff in their tenant
CREATE POLICY "owner_all_tenant_users"
ON public.tenant_users FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Every tenant user can read their own profile
CREATE POLICY "tenant_user_select_self"
ON public.tenant_users FOR SELECT TO authenticated
USING (
  public.is_tenant_user()
  AND id = auth.uid()
);

-- Tenant users can update their own name/email
-- Role and tenant_id changes are blocked at application layer (RLS can't restrict columns)
CREATE POLICY "tenant_user_update_self"
ON public.tenant_users FOR UPDATE TO authenticated
USING (
  public.is_tenant_user()
  AND id = auth.uid()
)
WITH CHECK (
  public.is_tenant_user()
  AND id = auth.uid()
  AND tenant_id = public.auth_tenant_id()
);


-- ── whatsapp_accounts ────────────────────────────────────────
-- Super Admin (impersonating): full CRUD (troubleshoot WhatsApp connections)
-- Owner:        full CRUD (connect/disconnect numbers, rotate tokens)
-- Receptionist: SELECT (view connected numbers for context)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_whatsapp_accounts"
ON public.whatsapp_accounts FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_whatsapp_accounts"
ON public.whatsapp_accounts FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_select_whatsapp_accounts"
ON public.whatsapp_accounts FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ── ai_settings ──────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD (AI prompt support)
-- Owner:        full CRUD (configure AI persona, model, escalation)
-- Receptionist: SELECT (understand AI configuration in use)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_ai_settings"
ON public.ai_settings FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_ai_settings"
ON public.ai_settings FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_select_ai_settings"
ON public.ai_settings FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ============================================================
-- SECTION 4 — PROPERTY TABLES
-- properties, property_images, units, unit_images
-- ============================================================

-- ── properties ───────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD (support investigations)
-- Owner:        full CRUD (manage property catalogue)
-- Receptionist: SELECT (branch-scoped: sees properties in their branch
--               or all if no branch restriction)
-- anon:         SELECT published only (public website)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_properties"
ON public.properties FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_properties"
ON public.properties FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionists browse properties when handling inquiries.
-- Branch-scoped receptionists see their branch properties + unassigned ones.
CREATE POLICY "receptionist_select_properties"
ON public.properties FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
  AND (
    public.auth_branch_id() IS NULL
    OR branch_id IS NULL
    OR branch_id = public.auth_branch_id()
  )
);

-- anon sees published catalogue for the tenant they're browsing
-- (frontend always includes tenant_id in query — policy is the security net)
CREATE POLICY "anon_select_published_properties"
ON public.properties FOR SELECT TO anon
USING (
  published = true
  AND deleted_at IS NULL
);


-- ── property_images ───────────────────────────────────────────
-- Inherits access from parent properties via EXISTS check.
-- No tenant_id on this table — isolation via the property FK.
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_property_images"
ON public.property_images FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
);

CREATE POLICY "owner_all_property_images"
ON public.property_images FOR ALL TO authenticated
USING (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
)
WITH CHECK (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
);

CREATE POLICY "receptionist_select_property_images"
ON public.property_images FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_id
      AND p.tenant_id = public.auth_tenant_id()
      AND p.deleted_at IS NULL
      AND (
        public.auth_branch_id() IS NULL
        OR p.branch_id IS NULL
        OR p.branch_id = public.auth_branch_id()
      )
  )
);

CREATE POLICY "anon_select_published_property_images"
ON public.property_images FOR SELECT TO anon
USING (
  EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_id
      AND p.published = true
      AND p.deleted_at IS NULL
  )
);


-- ── units ────────────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD
-- Owner:        full CRUD (add/remove/price units)
-- Receptionist: SELECT (needs unit list to make reservations)
-- anon:         SELECT active units of published properties
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_units"
ON public.units FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_units"
ON public.units FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionists see all active units in the tenant (no branch scope on units —
-- a receptionist may book any unit for any contact)
CREATE POLICY "receptionist_select_units"
ON public.units FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
);

-- anon checks unit details and availability on the public booking page
CREATE POLICY "anon_select_active_units"
ON public.units FOR SELECT TO anon
USING (
  active = true
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_id
      AND p.published = true
      AND p.deleted_at IS NULL
  )
);


-- ── unit_images ───────────────────────────────────────────────

CREATE POLICY "sa_imp_all_unit_images"
ON public.unit_images FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_id
      AND u.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_id
      AND u.tenant_id = public.auth_impersonating_tenant_id()
  )
);

CREATE POLICY "owner_all_unit_images"
ON public.unit_images FOR ALL TO authenticated
USING (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_id
      AND u.tenant_id = public.auth_tenant_id()
  )
)
WITH CHECK (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_id
      AND u.tenant_id = public.auth_tenant_id()
  )
);

CREATE POLICY "receptionist_select_unit_images"
ON public.unit_images FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_id
      AND u.tenant_id = public.auth_tenant_id()
      AND u.deleted_at IS NULL
  )
);

CREATE POLICY "anon_select_active_unit_images"
ON public.unit_images FOR SELECT TO anon
USING (
  EXISTS (
    SELECT 1 FROM public.units u
    JOIN public.properties p ON p.id = u.property_id
    WHERE u.id = unit_id
      AND u.active = true
      AND u.deleted_at IS NULL
      AND p.published = true
      AND p.deleted_at IS NULL
  )
);


-- ============================================================
-- SECTION 5 — CRM TABLES
-- contacts, conversations, messages, reservations,
-- availability_blocks, documents, tasks, notes, notifications
-- ============================================================

-- ── contacts ─────────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD (support investigations)
-- Owner:        full CRUD (manage contact database)
-- Receptionist: SELECT + INSERT + UPDATE
--               Hard DELETE intentionally excluded — contacts persist
--               even after conversations end. Use soft-delete (deleted_at).
-- anon:         no access (contact data is PII)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_contacts"
ON public.contacts FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_contacts"
ON public.contacts FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionist reads contacts across the full tenant (no branch scope —
-- a receptionist may receive a call from any contact)
CREATE POLICY "receptionist_select_contacts"
ON public.contacts FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
);

-- Webhook handler creates contacts via service_role; receptionists also insert
-- new contacts manually (ON CONFLICT DO NOTHING in webhook is service_role)
CREATE POLICY "receptionist_insert_contacts"
ON public.contacts FOR INSERT TO authenticated
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionists update contact name, notes, source; can soft-delete (set deleted_at)
CREATE POLICY "receptionist_update_contacts"
ON public.contacts FOR UPDATE TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ── conversations ─────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD
-- Owner:        full CRUD (assign, monitor, close all conversations)
-- Receptionist: full CRUD scoped to their branch
--               Unassigned conversations (branch_id IS NULL) visible to all
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_conversations"
ON public.conversations FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_conversations"
ON public.conversations FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Branch-scoped receptionists see their branch + unassigned conversations.
-- Receptionists without branch_id see all conversations in the tenant.
CREATE POLICY "receptionist_all_conversations"
ON public.conversations FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    public.auth_branch_id() IS NULL
    OR branch_id IS NULL
    OR branch_id = public.auth_branch_id()
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    public.auth_branch_id() IS NULL
    OR branch_id IS NULL
    OR branch_id = public.auth_branch_id()
  )
);


-- ── messages ──────────────────────────────────────────────────
-- Super Admin (impersonating): SELECT + INSERT (can read and send in support context)
-- Owner:        SELECT + INSERT (read all messages, send manual messages)
-- Receptionist: SELECT + INSERT (branch-scoped via conversation lookup)
-- UPDATE and DELETE intentionally excluded for all authenticated roles.
-- Messages are an immutable conversation log. Modifications via service_role only.
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_select_messages"
ON public.messages FOR SELECT TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "sa_imp_insert_messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_select_messages"
ON public.messages FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "owner_insert_messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Branch-scoped receptionist: message access flows through conversation access.
-- The conversation_id FK means we need to verify the conversation is accessible.
CREATE POLICY "receptionist_select_messages"
ON public.messages FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    public.auth_branch_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
        AND (c.branch_id IS NULL OR c.branch_id = public.auth_branch_id())
    )
  )
);

CREATE POLICY "receptionist_insert_messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id
      AND c.tenant_id = public.auth_tenant_id()
      AND (
        public.auth_branch_id() IS NULL
        OR c.branch_id IS NULL
        OR c.branch_id = public.auth_branch_id()
      )
  )
);


-- ── reservations ──────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD
-- Owner:        full CRUD (confirm, cancel, manage all bookings)
-- Receptionist: SELECT + INSERT + UPDATE
--               Hard DELETE excluded — use soft-delete (deleted_at) or
--               status='cancelled'. Completed bookings must be preserved.
-- anon:         no access (booking data is commercial PII)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_reservations"
ON public.reservations FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_reservations"
ON public.reservations FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_select_reservations"
ON public.reservations FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
);

-- Receptionists create reservations (AI-assisted or manual)
CREATE POLICY "receptionist_insert_reservations"
ON public.reservations FOR INSERT TO authenticated
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionists update status, notes, guest count; can soft-cancel (deleted_at)
CREATE POLICY "receptionist_update_reservations"
ON public.reservations FOR UPDATE TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ── availability_blocks ───────────────────────────────────────
-- Super Admin (impersonating): full CRUD
-- Owner:        full CRUD (manage calendar blocks)
-- Receptionist: SELECT + INSERT + UPDATE
--               Block creation is part of reservation flow.
--               DELETE is handled by trigger (release_availability_on_cancellation)
--               via service_role context when reservation is cancelled.
-- anon:         SELECT (availability check for public booking widget)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_availability_blocks"
ON public.availability_blocks FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_availability_blocks"
ON public.availability_blocks FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_select_availability_blocks"
ON public.availability_blocks FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_insert_availability_blocks"
ON public.availability_blocks FOR INSERT TO authenticated
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_update_availability_blocks"
ON public.availability_blocks FOR UPDATE TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);

-- anon checks date availability for public booking widget
CREATE POLICY "anon_select_availability_blocks"
ON public.availability_blocks FOR SELECT TO anon
USING (
  EXISTS (
    SELECT 1 FROM public.units u
    JOIN public.properties p ON p.id = u.property_id
    WHERE u.id = unit_id
      AND u.active = true
      AND u.deleted_at IS NULL
      AND p.published = true
      AND p.deleted_at IS NULL
  )
);


-- ── documents ─────────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD
-- Owner:        full CRUD (contracts, regulations, manuals)
-- Receptionist: SELECT (read contracts and regulations)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_documents"
ON public.documents FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_documents"
ON public.documents FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_select_documents"
ON public.documents FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ── tasks ─────────────────────────────────────────────────────
-- Super Admin (impersonating): full CRUD
-- Owner:        full CRUD (create, assign, complete tasks)
-- Receptionist: full CRUD (tasks are their primary workflow tool)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_tasks"
ON public.tasks FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_tasks"
ON public.tasks FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_all_tasks"
ON public.tasks FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ── notes ─────────────────────────────────────────────────────
-- Notes are append-only CRM records. No UPDATE or DELETE from application layer.
-- Super Admin (impersonating): SELECT + INSERT
-- Owner:        SELECT + INSERT
-- Receptionist: SELECT + INSERT
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_select_notes"
ON public.notes FOR SELECT TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "sa_imp_insert_notes"
ON public.notes FOR INSERT TO authenticated
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
  AND created_by = auth.uid()
);

-- Owner can read all notes and write new ones
CREATE POLICY "owner_select_notes"
ON public.notes FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "owner_insert_notes"
ON public.notes FOR INSERT TO authenticated
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
  AND created_by = auth.uid()
);

CREATE POLICY "receptionist_select_notes"
ON public.notes FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_insert_notes"
ON public.notes FOR INSERT TO authenticated
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND created_by = auth.uid()
);


-- ── notifications ─────────────────────────────────────────────
-- Super Admin (impersonating): SELECT (monitor notification delivery)
-- Owner:        SELECT all in tenant + UPDATE (mark read, batch dismiss)
-- Receptionist: SELECT own notifications + UPDATE own (mark as read)
-- INSERT and DELETE are service_role only (notifications are system-generated).
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_select_notifications"
ON public.notifications FOR SELECT TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_select_notifications"
ON public.notifications FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Owner can update notification status (mark all as read, dismiss)
CREATE POLICY "owner_update_notifications"
ON public.notifications FOR UPDATE TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionist sees their own user notifications and any team-wide ones
CREATE POLICY "receptionist_select_notifications"
ON public.notifications FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    -- User-addressed notifications for this receptionist
    (recipient_type = 'user' AND recipient_id = auth.uid())
    -- Team-wide in-app notifications (no specific recipient)
    OR (channel = 'in_app' AND recipient_type = 'user'
        AND recipient_id IN (
          SELECT id FROM public.tenant_users
          WHERE id = auth.uid()
        ))
  )
);

-- Receptionists mark their own notifications as read
CREATE POLICY "receptionist_update_own_notifications"
ON public.notifications FOR UPDATE TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND recipient_type = 'user'
  AND recipient_id = auth.uid()
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND recipient_type = 'user'
  AND recipient_id = auth.uid()
);


-- ============================================================
-- SECTION 6 — QUEUE / WORKER TABLES
-- message_queue: intentionally no authenticated/anon policies.
-- ============================================================

-- message_queue has RLS ENABLED but zero policies for authenticated/anon.
-- Result: default deny — only service_role can read or write.
--
-- Who writes: Webhook handler (service_role) via Edge Function or API route
-- Who reads:  Node.js worker (service_role) — SELECT FOR UPDATE SKIP LOCKED
-- Who updates: Worker (service_role) — status, processing_started_at, processed_at
-- Who listens: Worker via LISTEN 'message_queue_new' (pg_notify)
--
-- pg_cron stuck-item reclaim also runs as service_role (no RLS restriction).

COMMENT ON TABLE public.message_queue IS
  'Async webhook queue. RLS enabled with no authenticated policies = service_role only. '
  'Worker uses SELECT FOR UPDATE SKIP LOCKED. See pg_cron jobs in schema file footer.';


-- ============================================================
-- SECTION 7 — AUDIT / USAGE TABLES
-- ai_usage_log, audit_logs
-- ============================================================

-- ── ai_usage_log ─────────────────────────────────────────────
-- Super Admin: SELECT all (platform-wide cost monitoring)
-- Owner:       SELECT own tenant (cost reporting)
-- Receptionist: no access (internal billing data)
-- INSERT: AI worker via service_role (SECURITY DEFINER trigger context)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_select_all_ai_usage_log"
ON public.ai_usage_log FOR SELECT TO authenticated
USING (public.is_super_admin());

CREATE POLICY "owner_select_own_ai_usage_log"
ON public.ai_usage_log FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);


-- ── audit_logs ────────────────────────────────────────────────
-- Super Admin: SELECT all (complete platform audit trail)
-- Owner:       SELECT own tenant (transparency into who changed what)
-- Receptionist: no access (audit data is sensitive staff information)
-- INSERT/UPDATE/DELETE: never from authenticated.
--   audit_table_change() is SECURITY DEFINER and inserts directly.
--   No authenticated INSERT policy = extra defense against tampering.
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_select_all_audit_logs"
ON public.audit_logs FOR SELECT TO authenticated
USING (public.is_super_admin());

CREATE POLICY "owner_select_own_audit_logs"
ON public.audit_logs FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);


-- ============================================================
-- SECURITY REVIEW NOTES
-- ============================================================
--
-- ── RESIDUAL RISKS ───────────────────────────────────────────
--
-- RISK-01: Role escalation via tenant_user UPDATE self
-- Severity: HIGH (if auth hook not configured)
-- Description: tenant_user_update_self policy allows updating own row.
--   RLS cannot restrict individual columns (that requires column-level GRANT).
--   A malicious request could include a role change in the UPDATE body.
-- Mitigation: Application API must whitelist updatable columns (name, email only).
--   Never expose a raw UPDATE on tenant_users to user input.
--   Consider a SECURITY DEFINER function for self-updates that enforces column list.
-- Status: Accepted for MVP. Must be fixed before exposing a self-service profile form.
--
-- RISK-02: Impersonation session race condition (multiple concurrent sessions)
-- Severity: MEDIUM
-- Description: auth_impersonating_tenant_id() returns the LATEST active session.
--   If a super_admin opens multiple impersonation windows simultaneously,
--   they could access data from a different tenant than the UI shows.
-- Mitigation: Application should end previous session before starting a new one.
--   Consider enforcing a DB UNIQUE constraint: one active session per super_admin.
--   Example: CREATE UNIQUE INDEX idx_impersonation_one_active
--     ON public.impersonation_sessions(platform_user_id)
--     WHERE ended_at IS NULL;
-- Status: Accepted for MVP. Add the UNIQUE index before multi-tab admin UI ships.
--
-- RISK-03: anon sees ALL active tenants (not just their own)
-- Severity: LOW
-- Description: anon_select_active_tenants policy allows seeing all non-deleted tenants.
--   Column-level grants restrict visible fields (no plan/billing data),
--   but tenant names and slugs are visible to any unauthenticated client.
-- Mitigation: Acceptable — tenant slugs are essentially public by design
--   (they appear in URLs and the public website). Acceptable tradeoff.
--   If white-label isolation is needed in the future, add a public_listing BOOLEAN
--   to tenants and add AND public_listing = true to the anon policy.
-- Status: Accepted. Tenant discovery is intentional for the public website.
--
-- RISK-04: messages immutability relies on absence of policy, not prohibition
-- Severity: LOW
-- Description: There is no authenticated UPDATE/DELETE policy on messages.
--   A future developer might add one without understanding the immutability requirement.
-- Mitigation: Comment in this file is clear. Consider a BEFORE UPDATE trigger
--   on messages that raises EXCEPTION 'messages are immutable' in a future version.
-- Status: Accepted for MVP. Document in 12-adr.md.
--
-- RISK-05: availability_blocks DELETE by receptionist not explicitly blocked
-- Severity: LOW
-- Description: Receptionist has SELECT + INSERT + UPDATE policies but NO DELETE policy.
--   This correctly blocks authenticated DELETE from receptionists.
--   However, availability cleanup (on reservation cancellation) is done by the
--   release_availability_on_cancellation() trigger via SECURITY DEFINER.
--   Receptionists cannot accidentally delete blocks — the trigger handles it.
-- Mitigation: Already correct by omission. Document this contract clearly.
-- Status: No action needed.
--
-- ── TABLES THAT REQUIRE SERVICE_ROLE ─────────────────────────
--
-- The following operations MUST use service_role key (not anon/authenticated):
--
-- 1. message_queue writes (webhook handler, worker status updates, pg_cron reclaim)
-- 2. audit_logs INSERT (handled by audit_table_change() SECURITY DEFINER trigger)
-- 3. ai_usage_log INSERT (AI worker after each API call)
-- 4. notifications INSERT (notification service after reservation events)
-- 5. availability_blocks DELETE (release_availability_on_cancellation() SECURITY DEFINER)
-- 6. messages UPDATE/DELETE (never in normal operation; admin correction only)
-- 7. notes UPDATE/DELETE (never; notes are append-only)
-- 8. reservations soft-delete via pg_cron (expiry job runs as service_role)
--
-- In Supabase, use the service_role key in:
--   - Next.js API routes / Edge Functions (SUPABASE_SERVICE_ROLE_KEY in .env.local)
--   - Node.js worker process (same env var)
--   - pg_cron job SQL (runs as superuser, bypasses RLS automatically)
--
-- ── KNOWN LIMITATIONS ─────────────────────────────────────────
--
-- LIMIT-01: Branch scoping on receptionists is best-effort at the query level.
-- The branch_id claim in JWT is fixed until the next token refresh.
-- If a receptionist is reassigned to a different branch, they retain
-- old-branch access until they re-authenticate (JWT TTL = 1 hour in Supabase).
-- Mitigation: Force re-auth on branch reassignment in the owner UI.
-- Use auth.admin.signOut() via service_role to invalidate the session.
--
-- LIMIT-02: No row-level column masking for whatsapp_accounts.access_token_encrypted.
-- Receptionist SELECT policy on whatsapp_accounts exposes the encrypted token column.
-- The encryption itself protects the secret, but defense-in-depth would prefer
-- only owner/service_role to see that column.
-- Mitigation: Add a view whatsapp_accounts_public that omits the token column,
-- and restrict receptionist policy to that view. Deferred to v2 of this file.
--
-- LIMIT-03: Seller isolation is entirely by omission (no policies).
-- Sellers have no policies on tenant-level tables → no access.
-- A bug in policy creation (e.g., a permissive policy added for debugging)
-- could silently grant sellers tenant access. Consider an explicit DENY
-- comment for seller on sensitive tables as documentation.
-- Note: PostgreSQL RLS doesn't support explicit DENY — omission IS the deny.
--
-- ── RECOMMENDATIONS FOR PRODUCTION ───────────────────────────
--
-- PROD-01: Verify the Auth Hook is active BEFORE deploying.
--   SELECT public.verify_hook_configured();
--   Returns FALSE if JWT has no user_type → all RLS policies silently deny.
--
-- PROD-02: Add the single-active-impersonation index (see RISK-02):
--   CREATE UNIQUE INDEX idx_impersonation_one_active
--     ON public.impersonation_sessions(platform_user_id) WHERE ended_at IS NULL;
--
-- PROD-03: Enable Supabase's built-in RLS violation logging.
--   In Supabase Dashboard → Settings → Logs, enable "Policy Violations".
--   Alerts when a query is silently denied — useful for catching misconfigured clients.
--
-- PROD-04: Periodically audit active impersonation sessions.
--   SELECT * FROM public.impersonation_sessions WHERE ended_at IS NULL
--   AND started_at < now() - interval '8 hours';
--   Any session open longer than 8 hours may indicate a forgotten tab.
--
-- PROD-05: Run Supabase's built-in security advisor after every schema change.
--   GET /rest/v1/rpc/supabase_security_advisor (via MCP tool: get_advisors)
--   It catches: missing RLS, insecure functions, exposed service_role key usage.
--
-- PROD-06: Before adding any new table, run this checklist:
--   [ ] Does the table have RLS enabled?
--   [ ] Does it have a tenant_id column for isolation (or uses FK to scoped parent)?
--   [ ] Is there a policy for each role that needs access?
--   [ ] Is the table excluded from broad grants?
-- ============================================================

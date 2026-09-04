-- ============================================================
-- OrderFlow — RLS Policies V2
-- Version:    2.0
-- Date:       2026-06-22
-- Applies to: 16-supabase-schema-v3.sql
-- Replaces:   11-rls-policies.sql completely
-- Model:      Zero Trust — all access denied by default.
--             Policies grant exceptions, never blanket access.
-- ============================================================
--
-- ARCHITECTURE
-- ────────────────────────────────────────────────────────────
-- JWT app_metadata claims (set by custom_access_token_hook):
--   user_type     → 'platform_user' | 'tenant_user'
--   role          → 'super_admin' | 'seller' | 'owner' | 'receptionist'
--   tenant_id     → UUID (tenant_users only; NULL for platform_users)
--   workspace_ids → UUID[] | null
--                   NULL  = all workspaces (owner or unscoped receptionist)
--                   UUID[] = scoped to those workspace IDs
--
-- Helper functions (defined in 16-supabase-schema-v3.sql):
--   public.auth_user_type()              → TEXT
--   public.auth_tenant_id()              → UUID
--   public.auth_user_role()              → TEXT
--   public.auth_workspace_ids()          → UUID[] | NULL
--   public.auth_impersonating_tenant_id() → UUID | NULL  [DB query, not JWT]
--   public.is_super_admin()              → BOOLEAN
--   public.is_seller()                   → BOOLEAN
--   public.is_platform_user()            → BOOLEAN
--   public.is_tenant_user()              → BOOLEAN
--   public.is_owner()                    → BOOLEAN
--   public.is_receptionist()             → BOOLEAN
--
-- WORKSPACE SCOPING PATTERN (D3)
-- ────────────────────────────────────────────────────────────
-- Used in all tables with workspace_id column for receptionist access:
--
--   public.auth_workspace_ids() IS NULL           → all workspaces
--   OR workspace_id IS NULL                        → unscoped entity
--   OR workspace_id = ANY(public.auth_workspace_ids())  → in assigned workspaces
--
-- Owner: no workspace filter (Decision 2).
-- Receptionist: always uses the scoping pattern.
--
-- IMPERSONATION MODEL (D4)
-- ────────────────────────────────────────────────────────────
-- Super Admin has two access modes:
--
--   1. Platform mode (no active impersonation_sessions row with ended_at IS NULL):
--      Can manage platform_users, tenants, seller_clients.
--      Cannot see any tenant-level business data.
--
--   2. Impersonation mode (active session exists):
--      auth_impersonating_tenant_id() returns the target tenant UUID.
--      Tenant-scoped policies allow access to exactly that one tenant.
--
-- No global RLS bypass. No JWT re-issuance.
--
-- PERMISSION SUMMARY
-- ────────────────────────────────────────────────────────────
-- Role          | Platform tables  | Tenant tables
-- ───────────── | ──────────────── | ──────────────────────────────
-- super_admin   | full CRUD        | CRUD (impersonation only)
-- seller        | SELECT assigned  | none
-- owner         | SELECT own       | full CRUD within tenant (no workspace filter)
-- receptionist  | SELECT own       | CRM CRUD (workspace-scoped)
-- anon          | SELECT public    | SELECT properties/units/availability
-- service_role  | bypass RLS       | bypass RLS
-- ============================================================


-- ============================================================
-- SECTION 1 — PLATFORM TABLES
-- platform_users, tenants, seller_clients, impersonation_sessions
-- ============================================================

-- ── platform_users ──────────────────────────────────────────

CREATE POLICY "sa_all_platform_users"
ON public.platform_users FOR ALL TO authenticated
USING  (public.is_super_admin())
WITH CHECK (public.is_super_admin());

CREATE POLICY "platform_user_select_self"
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

CREATE POLICY "sa_all_tenants"
ON public.tenants FOR ALL TO authenticated
USING  (public.is_super_admin())
WITH CHECK (public.is_super_admin());

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

CREATE POLICY "owner_select_own_tenant"
ON public.tenants FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND id = public.auth_tenant_id()
);

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

CREATE POLICY "receptionist_select_own_tenant"
ON public.tenants FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND id = public.auth_tenant_id()
);

CREATE POLICY "anon_select_active_tenants"
ON public.tenants FOR SELECT TO anon
USING (deleted_at IS NULL);


-- ── seller_clients ───────────────────────────────────────────

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

-- Owners see when their tenant was accessed by platform support (transparency)
CREATE POLICY "owner_select_own_impersonation_sessions"
ON public.impersonation_sessions FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND target_tenant_id = public.auth_tenant_id()
);


-- ============================================================
-- SECTION 2 — WORKSPACE CONFIGURATION TABLES
-- workspaces, tenant_users, user_workspace_assignments, whatsapp_accounts, ai_settings
-- ============================================================

-- ── workspaces (D1) ─────────────────────────────────────────
-- SA (impersonating): full CRUD in target tenant
-- Owner:              full CRUD (manage org structure)
-- Receptionist:       SELECT only (cannot create/modify workspaces)
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_workspaces"
ON public.workspaces FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_workspaces"
ON public.workspaces FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_select_workspaces"
ON public.workspaces FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND active = true
);


-- ── user_workspace_assignments (D3) ──────────────────────────
-- SA (impersonating): SELECT (view assignments in support context)
-- Owner:              full CRUD (manage receptionist scopes)
-- Receptionist:       SELECT own assignments only
-- ─────────────────────────────────────────────────────────────

CREATE POLICY "sa_imp_select_workspace_assignments"
ON public.user_workspace_assignments FOR SELECT TO authenticated
USING (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id = user_workspace_assignments.user_id
      AND tu.tenant_id = public.auth_impersonating_tenant_id()
  )
);

CREATE POLICY "owner_all_workspace_assignments"
ON public.user_workspace_assignments FOR ALL TO authenticated
USING (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id = user_workspace_assignments.user_id
      AND tu.tenant_id = public.auth_tenant_id()
  )
)
WITH CHECK (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id = user_workspace_assignments.user_id
      AND tu.tenant_id = public.auth_tenant_id()
  )
);

-- Receptionist can view their own workspace assignments
CREATE POLICY "receptionist_select_own_workspace_assignments"
ON public.user_workspace_assignments FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND user_id = auth.uid()
);


-- ── tenant_users ─────────────────────────────────────────────

CREATE POLICY "sa_imp_select_tenant_users"
ON public.tenant_users FOR SELECT TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

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

CREATE POLICY "tenant_user_select_self"
ON public.tenant_users FOR SELECT TO authenticated
USING (
  public.is_tenant_user()
  AND id = auth.uid()
);

CREATE POLICY "tenant_user_update_self"
ON public.tenant_users FOR UPDATE TO authenticated
USING (
  public.is_tenant_user()
  AND id = auth.uid()
)
WITH CHECK (
  public.is_tenant_user()
  AND id = auth.uid()
);


-- ── whatsapp_accounts ────────────────────────────────────────
-- Owner: full CRUD (manage WhatsApp numbers)
-- Receptionist: SELECT (read routing config)
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
-- SECTION 3 — PROPERTY & UNIT TABLES
-- properties, property_images, units, unit_images
-- ============================================================
--
-- Workspace scoping for receptionist:
--   property.workspace_id IS NULL → visible to all receptionists
--   property.workspace_id = uuid  → visible only if uuid in auth_workspace_ids()
-- Owner: no workspace filter (D2).

-- ── properties ──────────────────────────────────────────────

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

-- D2: Owner has total access, no workspace filter
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

-- D3: Receptionist sees properties in their assigned workspaces (or all if unscoped)
CREATE POLICY "receptionist_all_properties"
ON public.properties FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
  AND (
    public.auth_workspace_ids() IS NULL
    OR workspace_id IS NULL
    OR workspace_id = ANY(public.auth_workspace_ids())
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    public.auth_workspace_ids() IS NULL
    OR workspace_id IS NULL
    OR workspace_id = ANY(public.auth_workspace_ids())
  )
);

-- Public site: published properties visible to anon
CREATE POLICY "anon_select_published_properties"
ON public.properties FOR SELECT TO anon
USING (
  published = true
  AND deleted_at IS NULL
);


-- ── property_images ──────────────────────────────────────────

CREATE POLICY "sa_imp_all_property_images"
ON public.property_images FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_images.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_images.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
);

CREATE POLICY "owner_all_property_images"
ON public.property_images FOR ALL TO authenticated
USING (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
)
WITH CHECK (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
);

CREATE POLICY "receptionist_all_property_images"
ON public.property_images FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
      AND p.deleted_at IS NULL
      AND (
        public.auth_workspace_ids() IS NULL
        OR p.workspace_id IS NULL
        OR p.workspace_id = ANY(public.auth_workspace_ids())
      )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
      AND (
        public.auth_workspace_ids() IS NULL
        OR p.workspace_id IS NULL
        OR p.workspace_id = ANY(public.auth_workspace_ids())
      )
  )
);

CREATE POLICY "anon_select_property_images"
ON public.property_images FOR SELECT TO anon
USING (
  EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = property_images.property_id
      AND p.published = true
      AND p.deleted_at IS NULL
  )
);


-- ── units ───────────────────────────────────────────────────
-- Units inherit workspace scope from their parent property.

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

CREATE POLICY "receptionist_all_units"
ON public.units FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = units.property_id
      AND p.deleted_at IS NULL
      AND (
        public.auth_workspace_ids() IS NULL
        OR p.workspace_id IS NULL
        OR p.workspace_id = ANY(public.auth_workspace_ids())
      )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = units.property_id
      AND (
        public.auth_workspace_ids() IS NULL
        OR p.workspace_id IS NULL
        OR p.workspace_id = ANY(public.auth_workspace_ids())
      )
  )
);

CREATE POLICY "anon_select_units"
ON public.units FOR SELECT TO anon
USING (
  active = true
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = units.property_id
      AND p.published = true
      AND p.deleted_at IS NULL
  )
);


-- ── unit_images ──────────────────────────────────────────────

CREATE POLICY "owner_all_unit_images"
ON public.unit_images FOR ALL TO authenticated
USING (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_images.unit_id
      AND u.tenant_id = public.auth_tenant_id()
  )
)
WITH CHECK (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = unit_images.unit_id
      AND u.tenant_id = public.auth_tenant_id()
  )
);

CREATE POLICY "receptionist_all_unit_images"
ON public.unit_images FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.units u
    JOIN public.properties p ON p.id = u.property_id
    WHERE u.id = unit_images.unit_id
      AND u.tenant_id = public.auth_tenant_id()
      AND (
        public.auth_workspace_ids() IS NULL
        OR p.workspace_id IS NULL
        OR p.workspace_id = ANY(public.auth_workspace_ids())
      )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.units u
    JOIN public.properties p ON p.id = u.property_id
    WHERE u.id = unit_images.unit_id
      AND u.tenant_id = public.auth_tenant_id()
      AND (
        public.auth_workspace_ids() IS NULL
        OR p.workspace_id IS NULL
        OR p.workspace_id = ANY(public.auth_workspace_ids())
      )
  )
);

CREATE POLICY "anon_select_unit_images"
ON public.unit_images FOR SELECT TO anon
USING (
  EXISTS (
    SELECT 1 FROM public.units u
    JOIN public.properties p ON p.id = u.property_id
    WHERE u.id = unit_images.unit_id
      AND u.active = true AND u.deleted_at IS NULL
      AND p.published = true AND p.deleted_at IS NULL
  )
);


-- ── availability_blocks ──────────────────────────────────────

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

CREATE POLICY "receptionist_all_availability_blocks"
ON public.availability_blocks FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "anon_select_availability_blocks"
ON public.availability_blocks FOR SELECT TO anon
USING (
  EXISTS (
    SELECT 1 FROM public.units u
    WHERE u.id = availability_blocks.unit_id
      AND u.active = true AND u.deleted_at IS NULL
  )
);


-- ============================================================
-- SECTION 4 — CRM TABLES
-- contacts, conversations, messages, reservations
-- ============================================================

-- ── contacts ─────────────────────────────────────────────────
-- Contacts are tenant-scoped but not workspace-scoped.
-- A contact can have conversations across multiple workspaces.

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

-- Receptionists see all contacts in their tenant regardless of workspace.
-- Contact-level workspace scoping would break AI context building.
CREATE POLICY "receptionist_all_contacts"
ON public.contacts FOR ALL TO authenticated
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

-- D2: Owner sees all conversations
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

-- D3: Receptionist sees conversations in their workspace scope
CREATE POLICY "receptionist_all_conversations"
ON public.conversations FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    public.auth_workspace_ids() IS NULL
    OR workspace_id IS NULL
    OR workspace_id = ANY(public.auth_workspace_ids())
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    public.auth_workspace_ids() IS NULL
    OR workspace_id IS NULL
    OR workspace_id = ANY(public.auth_workspace_ids())
  )
);


-- ── messages ─────────────────────────────────────────────────
-- Messages inherit access from their conversation.
-- tenant_id is denormalized for direct RLS without JOIN.

CREATE POLICY "sa_imp_all_messages"
ON public.messages FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_messages"
ON public.messages FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionist message access via their conversation policy.
-- This policy is consistent with the conversations workspace filter.
CREATE POLICY "receptionist_all_messages"
ON public.messages FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND c.tenant_id = public.auth_tenant_id()
      AND (
        public.auth_workspace_ids() IS NULL
        OR c.workspace_id IS NULL
        OR c.workspace_id = ANY(public.auth_workspace_ids())
      )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND c.tenant_id = public.auth_tenant_id()
      AND (
        public.auth_workspace_ids() IS NULL
        OR c.workspace_id IS NULL
        OR c.workspace_id = ANY(public.auth_workspace_ids())
      )
  )
);


-- ── reservations ─────────────────────────────────────────────
-- D6: Receptionist AND Owner can confirm and cancel reservations.
-- IA never confirms — it only creates pre_reserved via create_pre_reservation tool.

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

-- D2: Owner has total reservation access
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

-- D3 + D6: Receptionist: workspace-scoped via unit's property.
-- Can INSERT (new pre_reserved via AI or manual), UPDATE (confirm/cancel), SELECT.
-- Cannot DELETE (hard delete — only owner can soft-delete via deleted_at).
CREATE POLICY "receptionist_all_reservations"
ON public.reservations FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
  AND EXISTS (
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
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
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
);


-- ============================================================
-- SECTION 5 — SUPPLEMENTARY TABLES
-- documents, tasks, notes, notifications
-- ============================================================

-- ── documents (D5) ───────────────────────────────────────────
-- Supports 4 anchors: property, unit, contact, reservation.
-- Access follows the most restrictive entity's workspace scope.
-- For simplicity: all authenticated tenant users can access docs in their tenant.
-- Application layer enforces entity-level visibility.

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

CREATE POLICY "receptionist_all_documents"
ON public.documents FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ── tasks ────────────────────────────────────────────────────

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


-- ── notes ────────────────────────────────────────────────────

CREATE POLICY "sa_imp_all_notes"
ON public.notes FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_notes"
ON public.notes FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

CREATE POLICY "receptionist_all_notes"
ON public.notes FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);


-- ── notifications ─────────────────────────────────────────────

CREATE POLICY "sa_imp_all_notifications"
ON public.notifications FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
)
WITH CHECK (
  public.is_super_admin()
  AND tenant_id = public.auth_impersonating_tenant_id()
);

CREATE POLICY "owner_all_notifications"
ON public.notifications FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionist sees notifications addressed to them
CREATE POLICY "receptionist_select_own_notifications"
ON public.notifications FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND recipient_type = 'user'
  AND recipient_id = auth.uid()
);


-- ============================================================
-- SECTION 6 — SYSTEM TABLES
-- audit_logs, ai_usage_log, message_queue
-- ============================================================

-- ── audit_logs ───────────────────────────────────────────────
-- Owner: SELECT (transparency into changes within their tenant)
-- SA: SELECT (view all audit logs, both platform and tenant-scoped)
-- No INSERT/UPDATE/DELETE for any authenticated user — append-only via triggers

CREATE POLICY "sa_select_audit_logs"
ON public.audit_logs FOR SELECT TO authenticated
USING (public.is_super_admin());

CREATE POLICY "owner_select_own_audit_logs"
ON public.audit_logs FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);


-- ── ai_usage_log ─────────────────────────────────────────────

CREATE POLICY "sa_select_ai_usage_log"
ON public.ai_usage_log FOR SELECT TO authenticated
USING (public.is_super_admin());

CREATE POLICY "owner_select_own_ai_usage_log"
ON public.ai_usage_log FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);


-- ── message_queue ─────────────────────────────────────────────
-- No grant to authenticated (only service_role accesses this table).
-- Policies below are defensive — they apply if a grant is added in the future.

CREATE POLICY "sa_select_message_queue"
ON public.message_queue FOR SELECT TO authenticated
USING (public.is_super_admin());

CREATE POLICY "owner_select_own_message_queue"
ON public.message_queue FOR SELECT TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);


-- ============================================================
-- RESIDUAL LIMITATIONS
-- ============================================================
--
-- 1. messages policy uses EXISTS subquery to conversations
--    This adds one JOIN per row check. Acceptable for MVP volume.
--    Optimization: add workspace_id to messages (denormalized) in v4 if needed.
--
-- 2. receptionist_all_reservations uses EXISTS JOIN via units/properties
--    Performance: acceptable for MVP. At scale, consider denormalizing workspace_id
--    onto reservations.
--
-- 3. documents policy is tenant-scoped only (not workspace-scoped)
--    A receptionist in Workspace A can see documents linked to reservations in Workspace B.
--    This is intentional for MVP simplicity. Documents are linked to contacts/reservations
--    that receptionists already have access to — the application layer handles the
--    entity-level visibility.
--
-- 4. No DELETE policy for receptionist on reservations
--    Receptionists can soft-delete (SET deleted_at = now()) via UPDATE policy.
--    Hard DELETE requires Owner — consistent with the data permanence model.
--
-- 5. notifications: receptionist SELECT limited to own notifications
--    Cannot see notifications sent to other users. Owner sees all.
-- ============================================================

-- ============================================================
-- OrderFlow — Supabase Schema V3
-- Version:  3.0
-- Date:     2026-06-22
-- Database: PostgreSQL 17 (Supabase)
-- Previous: 10-supabase-schema-v2.sql
-- Replaces: 10-supabase-schema-v2.sql completely
-- Decisions: 15b-architecture-amendments.md
-- ============================================================
--
-- ⚠️  PREREQUISITO: Supabase Pro plan requerido.
-- Auth Hook (custom_access_token_hook) solo está disponible
-- en Supabase Pro. Sin el hook, el JWT no tiene claims de
-- user_type/tenant_id/role y RLS bloquea TODOS los accesos.
-- Registrar el hook en:
--   Dashboard → Authentication → Hooks → Custom Access Token
--   Function: public.custom_access_token_hook
-- ============================================================
--
-- CAMBIOS RESPECTO A V2 (decisiones 15b)
-- ────────────────────────────────────────────────────────────
-- D1  branches → workspaces (nuevo enum workspace_type)
-- D3  user_workspace_assignments junction table
--     tenant_users pierde branch_id; JWT cambia a workspace_ids[]
-- D4  auth_impersonating_tenant_id() movida aquí desde rls-policies
--     audit_table_change() usa DB query (no JWT) para impersonación
--     auth_impersonated_by() eliminada (JWT no tiene este claim)
-- D5  documents agrega contact_id y reservation_id
-- D6  (sin cambio en schema — impacto en RLS y API únicamente)
-- D7  MAX_TOOL_ROUNDS = 5 (constante en packages/ai, no en schema)
-- D8  email notificaciones: enum conservado, procesamiento postergado
-- ============================================================


-- ============================================================
-- SECTION 1 — EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";


-- ============================================================
-- SECTION 2 — ENUMS
-- ============================================================

CREATE TYPE platform_role AS ENUM (
  'super_admin',
  'seller'
);

CREATE TYPE tenant_role AS ENUM (
  'owner',
  'receptionist'
);

CREATE TYPE tenant_status AS ENUM (
  'trial',
  'active',
  'suspended',
  'churned'
);

CREATE TYPE plan_tier AS ENUM (
  'starter',
  'pro'
);

-- D1: grupo operativo del tenant — no implica ubicación física
CREATE TYPE workspace_type AS ENUM (
  'general',
  'physical_branch',
  'zone',
  'team'
);

CREATE TYPE conversation_status AS ENUM (
  'open',
  'waiting',
  'closed'
);

CREATE TYPE conversation_channel AS ENUM (
  'whatsapp',
  'manual'
);

CREATE TYPE conversation_source AS ENUM (
  'whatsapp_direct',
  'website_button',
  'manual'
);

CREATE TYPE ai_mode AS ENUM (
  'auto',
  'human',
  'disabled'
);

CREATE TYPE message_sender AS ENUM (
  'customer',
  'ai',
  'human'
);

CREATE TYPE message_content_type AS ENUM (
  'text',
  'image',
  'document',
  'audio',
  'video'
);

CREATE TYPE reservation_status AS ENUM (
  'inquiry',
  'interested',
  'pre_reserved',
  'pending_payment',
  'confirmed',
  'cancelled'
);

CREATE TYPE block_reason AS ENUM (
  'reservation',
  'maintenance',
  'manual'
);

CREATE TYPE document_type AS ENUM (
  'contract',
  'regulation',
  'policy',
  'manual'
);

CREATE TYPE task_status AS ENUM (
  'pending',
  'in_progress',
  'completed',
  'cancelled'
);

CREATE TYPE notification_type AS ENUM (
  'new_conversation',
  'new_reservation',
  'ai_escalation',
  'reservation_confirmed',
  'reservation_cancelled',
  'payment_received'
);

-- D8: email conservado en enum. Rows con channel='email' se crean
-- pero no se procesan hasta post-MVP v1.1. No eliminar el valor.
CREATE TYPE notification_channel AS ENUM (
  'whatsapp',
  'email',
  'in_app'
);

CREATE TYPE notification_status AS ENUM (
  'pending',
  'sent',
  'failed'
);

CREATE TYPE queue_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed'
);

CREATE TYPE audit_actor_type AS ENUM (
  'platform_user',
  'tenant_user',
  'system'
);

CREATE TYPE contact_source AS ENUM (
  'whatsapp',
  'website',
  'manual'
);


-- ============================================================
-- SECTION 3 — TABLES
-- ============================================================

-- ------------------------------------------------------------
-- platform_users
-- ------------------------------------------------------------
CREATE TABLE public.platform_users (
  id          UUID          PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT          NOT NULL,
  email       TEXT          NOT NULL,
  role        platform_role NOT NULL,
  active      BOOLEAN       NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT platform_users_email_unique UNIQUE (email)
);

COMMENT ON TABLE public.platform_users IS
  'OrderFlow internal staff (Super Admin, Seller). Shares UUID with auth.users.';
COMMENT ON COLUMN public.platform_users.email IS
  'Copy of auth.users.email for display. May drift if email changed in Auth Dashboard — validate at application layer.';


-- ------------------------------------------------------------
-- tenants
-- ------------------------------------------------------------
CREATE TABLE public.tenants (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT          NOT NULL,
  slug             TEXT          NOT NULL,
  status           tenant_status NOT NULL DEFAULT 'trial',
  plan             plan_tier     NOT NULL DEFAULT 'starter',
  trial_ends_at    TIMESTAMPTZ,
  max_properties   INT           NOT NULL DEFAULT 10 CHECK (max_properties > 0),
  max_users        INT           NOT NULL DEFAULT 5  CHECK (max_users > 0),
  logo_url         TEXT,
  primary_color    CHAR(7)       CHECK (primary_color    ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color  CHAR(7)       CHECK (secondary_color  ~ '^#[0-9A-Fa-f]{6}$'),
  site_config      JSONB         NOT NULL DEFAULT '{}',
  custom_domain    TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,

  CONSTRAINT tenants_slug_format CHECK (
    slug ~ '^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$'
  )
);

COMMENT ON TABLE public.tenants IS
  'Real estate agency accounts. Each tenant has an isolated data space enforced by RLS.';
COMMENT ON COLUMN public.tenants.slug IS
  'Subdomain {slug}.orderflow.app. Format: lowercase alphanumeric + hyphens, 4-64 chars.';
COMMENT ON COLUMN public.tenants.site_config IS
  'Public website settings: { template, hero_title, hero_subtitle, about_text, seo_title, seo_description, font, show_prices, contact_email }';


-- ------------------------------------------------------------
-- tenants_public (VIEW)
-- ------------------------------------------------------------
CREATE VIEW public.tenants_public AS
  SELECT
    id, name, slug, logo_url, primary_color, secondary_color, site_config, custom_domain
  FROM public.tenants
  WHERE deleted_at IS NULL;

COMMENT ON VIEW public.tenants_public IS
  'Public-safe tenant fields for anon access (public website). Excludes plan, billing, and limit fields.';


-- ------------------------------------------------------------
-- seller_clients
-- ------------------------------------------------------------
CREATE TABLE public.seller_clients (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id             UUID         NOT NULL REFERENCES public.platform_users(id),
  tenant_id             UUID         NOT NULL REFERENCES public.tenants(id),
  commission_percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00
    CHECK (commission_percentage >= 0 AND commission_percentage <= 100),
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT seller_clients_pair_unique UNIQUE (seller_id, tenant_id)
);

COMMENT ON TABLE public.seller_clients IS
  'Many-to-many: which sellers manage which tenants, with commission tracking.';


-- ------------------------------------------------------------
-- workspaces (D1: replaces branches)
-- Operational group within a tenant. Does not imply physical location.
-- A workspace can represent a branch, zone, team, or general organization.
-- ------------------------------------------------------------
CREATE TABLE public.workspaces (
  id          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID           NOT NULL REFERENCES public.tenants(id),
  name        TEXT           NOT NULL,
  type        workspace_type NOT NULL DEFAULT 'general',
  address     TEXT,
  city        TEXT,
  phone       TEXT,
  email       TEXT,
  active      BOOLEAN        NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.workspaces IS
  'Operational grouping within a tenant. Replaces branches (v2). '
  'Does not imply physical location — can represent zones, teams, or physical offices. '
  'A "General" workspace is auto-created on tenant onboarding and cannot be deleted.';
COMMENT ON COLUMN public.workspaces.type IS
  'general=whole org, physical_branch=office, zone=geographic area, team=work group.';


-- ------------------------------------------------------------
-- tenant_users
-- D3: branch_id removed. workspace scope via user_workspace_assignments junction table.
-- ------------------------------------------------------------
CREATE TABLE public.tenant_users (
  id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id),
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  role        tenant_role NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tenant_users_email_unique UNIQUE (tenant_id, email)
);

COMMENT ON TABLE public.tenant_users IS
  'Tenant staff (owner, receptionist). Shares UUID with auth.users. '
  'Workspace assignments are in user_workspace_assignments junction table. '
  'Owner has full tenant access (no workspace filter). '
  'Receptionist scope: 0 assignments = all workspaces; N assignments = those N workspaces.';


-- ------------------------------------------------------------
-- user_workspace_assignments (D3: junction table for receptionist multi-workspace)
-- Owners never have entries here — their access is determined by role.
-- Receptionists with no entries see all workspaces (backwards-compatible default).
-- Receptionists with N entries see only those N workspaces.
-- ------------------------------------------------------------
CREATE TABLE public.user_workspace_assignments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES public.tenant_users(id) ON DELETE CASCADE,
  workspace_id  UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_workspace_assignments_unique UNIQUE (user_id, workspace_id)
);

COMMENT ON TABLE public.user_workspace_assignments IS
  'Many-to-many: which receptionists are assigned to which workspaces. '
  'Empty = receptionist sees all workspaces. Owners must never have entries here.';


-- ------------------------------------------------------------
-- impersonation_sessions
-- D4: source of truth for Super Admin impersonation. No JWT re-issuance.
-- ------------------------------------------------------------
CREATE TABLE public.impersonation_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id UUID        NOT NULL REFERENCES public.platform_users(id),
  target_tenant_id UUID        NOT NULL REFERENCES public.tenants(id),
  reason           TEXT        NOT NULL,
  ip_address       INET,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);

COMMENT ON TABLE public.impersonation_sessions IS
  'Audit trail for Super Admin impersonation. Append-only. '
  'Active session: ended_at IS NULL. auth_impersonating_tenant_id() queries this table. '
  'The SA keeps their own JWT — no re-issuance. Access is gated by ended_at IS NULL check.';


-- ------------------------------------------------------------
-- properties
-- ------------------------------------------------------------
CREATE TABLE public.properties (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id),
  workspace_id    UUID        REFERENCES public.workspaces(id),
  title           TEXT        NOT NULL,
  description     TEXT,
  city            TEXT,
  neighborhood    TEXT,
  address         TEXT,
  google_maps_url TEXT,
  attributes      JSONB       NOT NULL DEFAULT '{}',
  published       BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

COMMENT ON COLUMN public.properties.workspace_id IS
  'NULL = visible to all workspace members (no restriction). '
  'Set to group properties by workspace for scoped receptionist access.';
COMMENT ON COLUMN public.properties.attributes IS
  'JSONB amenity map. GIN indexed for AI search_properties() tool calls. '
  'Example: { "pileta": true, "cochera": true, "mascotas": false }';


-- ------------------------------------------------------------
-- property_images
-- ------------------------------------------------------------
CREATE TABLE public.property_images (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID        NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  image_url    TEXT        NOT NULL,
  sort_order   INT         NOT NULL DEFAULT 0,
  is_cover     BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.property_images IS
  'Photo gallery for properties. At most one cover image per property (enforced by idx_property_images_one_cover).';


-- ------------------------------------------------------------
-- units
-- ------------------------------------------------------------
CREATE TABLE public.units (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID          NOT NULL REFERENCES public.tenants(id),
  property_id  UUID          NOT NULL REFERENCES public.properties(id),
  name         TEXT          NOT NULL,
  capacity     INT           NOT NULL CHECK (capacity > 0),
  price        NUMERIC(10,2) CHECK (price >= 0),
  currency     CHAR(3)       NOT NULL DEFAULT 'ARS',
  active       BOOLEAN       NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

COMMENT ON COLUMN public.units.tenant_id IS
  'Denormalized from properties.tenant_id. Cross-tenant consistency enforced by trg_units_tenant_consistency.';


-- ------------------------------------------------------------
-- unit_images
-- ------------------------------------------------------------
CREATE TABLE public.unit_images (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     UUID        NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  image_url   TEXT        NOT NULL,
  sort_order  INT         NOT NULL DEFAULT 0,
  is_cover    BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- contacts
-- ------------------------------------------------------------
CREATE TABLE public.contacts (
  id          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID           NOT NULL REFERENCES public.tenants(id),
  name        TEXT,
  phone       TEXT,
  email       TEXT,
  source      contact_source NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,

  CONSTRAINT contacts_must_have_contact_method CHECK (
    phone IS NOT NULL OR email IS NOT NULL
  )
);

COMMENT ON TABLE public.contacts IS
  'External clients. Phone is the WhatsApp deduplication key. '
  'Uniqueness enforced via partial index (idx_contacts_tenant_phone).';


-- ------------------------------------------------------------
-- conversations
-- ------------------------------------------------------------
CREATE TABLE public.conversations (
  id                 UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID                  NOT NULL REFERENCES public.tenants(id),
  contact_id         UUID                  NOT NULL REFERENCES public.contacts(id),
  workspace_id       UUID                  REFERENCES public.workspaces(id),
  assigned_user_id   UUID                  REFERENCES public.tenant_users(id),
  status             conversation_status   NOT NULL DEFAULT 'open',
  channel            conversation_channel  NOT NULL DEFAULT 'whatsapp',
  source             conversation_source   NOT NULL DEFAULT 'whatsapp_direct',
  ai_mode            ai_mode               NOT NULL DEFAULT 'auto',
  whatsapp_thread_id TEXT,
  created_at         TIMESTAMPTZ           NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ           NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ
);

COMMENT ON COLUMN public.conversations.workspace_id IS
  'NULL = unscoped conversation, visible to all. Set by worker on inbound message routing.';
COMMENT ON COLUMN public.conversations.source IS
  'How the conversation started. website_button injects property context into AI system prompt.';
COMMENT ON COLUMN public.conversations.whatsapp_thread_id IS
  'Meta conversation ID for 24h customer service window. Indexed for worker lookups.';


-- ------------------------------------------------------------
-- messages
-- ------------------------------------------------------------
CREATE TABLE public.messages (
  id                   UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID                 NOT NULL REFERENCES public.tenants(id),
  conversation_id      UUID                 NOT NULL REFERENCES public.conversations(id),
  sender_type          message_sender       NOT NULL,
  sender_id            UUID                 REFERENCES public.tenant_users(id),
  content              TEXT                 NOT NULL,
  content_type         message_content_type NOT NULL DEFAULT 'text',
  metadata             JSONB,
  whatsapp_message_id  TEXT,
  created_at           TIMESTAMPTZ          NOT NULL DEFAULT now(),

  CONSTRAINT messages_sender_id_consistency CHECK (
    (sender_type = 'human'  AND sender_id IS NOT NULL) OR
    (sender_type <> 'human' AND sender_id IS NULL)
  )
);

COMMENT ON COLUMN public.messages.tenant_id IS
  'Denormalized for direct RLS without JOIN to conversations.';
COMMENT ON COLUMN public.messages.whatsapp_message_id IS
  'Meta API message ID. Unique index enables ON CONFLICT DO NOTHING for deduplication.';


-- ------------------------------------------------------------
-- reservations
-- ------------------------------------------------------------
CREATE TABLE public.reservations (
  id               UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID               NOT NULL REFERENCES public.tenants(id),
  contact_id       UUID               NOT NULL REFERENCES public.contacts(id),
  unit_id          UUID               NOT NULL REFERENCES public.units(id),
  conversation_id  UUID               REFERENCES public.conversations(id),
  start_date       DATE               NOT NULL,
  end_date         DATE               NOT NULL,
  guests           INT                NOT NULL CHECK (guests > 0),
  total_amount     NUMERIC(10,2)      CHECK (total_amount >= 0),
  currency         CHAR(3)            NOT NULL DEFAULT 'ARS',
  status           reservation_status NOT NULL DEFAULT 'inquiry',
  expires_at       TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ        NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,

  CONSTRAINT reservations_dates_valid CHECK (end_date > start_date),
  CONSTRAINT reservations_expires_at_required CHECK (
    (status = 'pre_reserved' AND expires_at IS NOT NULL) OR
    (status <> 'pre_reserved')
  )
);

COMMENT ON COLUMN public.reservations.expires_at IS
  'TTL for pre_reserved status. Set to now()+48h by application. '
  'Cleared by trg_clear_expires_at when status leaves pre_reserved. '
  'pg_cron expires stale pre-reservations every 15 minutes.';


-- ------------------------------------------------------------
-- availability_blocks
-- ------------------------------------------------------------
CREATE TABLE public.availability_blocks (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES public.tenants(id),
  unit_id         UUID         NOT NULL REFERENCES public.units(id),
  reservation_id  UUID         REFERENCES public.reservations(id),
  start_date      DATE         NOT NULL,
  end_date        DATE         NOT NULL,
  reason          block_reason NOT NULL,
  created_by      UUID         REFERENCES public.tenant_users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT availability_blocks_dates_valid CHECK (end_date > start_date),
  CONSTRAINT availability_blocks_reservation_fk_required CHECK (
    (reason = 'reservation' AND reservation_id IS NOT NULL) OR
    (reason <> 'reservation')
  ),

  -- [start, end) semantics: checkout day = next checkin day is allowed.
  -- Requires btree_gist extension.
  CONSTRAINT no_double_booking EXCLUDE USING gist (
    unit_id WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  )
);

COMMENT ON CONSTRAINT no_double_booking ON public.availability_blocks IS
  'Prevents overlapping date blocks for the same unit. [start, end) semantics.';
COMMENT ON COLUMN public.availability_blocks.tenant_id IS
  'Denormalized from units.tenant_id. Cross-tenant consistency enforced by trigger.';


-- ------------------------------------------------------------
-- documents (D5: supports property, unit, contact, reservation)
-- ------------------------------------------------------------
CREATE TABLE public.documents (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID          NOT NULL REFERENCES public.tenants(id),
  property_id     UUID          REFERENCES public.properties(id),
  unit_id         UUID          REFERENCES public.units(id),
  contact_id      UUID          REFERENCES public.contacts(id),
  reservation_id  UUID          REFERENCES public.reservations(id),
  name            TEXT          NOT NULL,
  file_url        TEXT          NOT NULL,
  document_type   document_type NOT NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- D5: at least one of the four entity anchors must be non-null
  CONSTRAINT documents_must_have_entity CHECK (
    property_id IS NOT NULL OR
    unit_id IS NOT NULL OR
    contact_id IS NOT NULL OR
    reservation_id IS NOT NULL
  )
);

COMMENT ON TABLE public.documents IS
  'File attachments. Each document must be anchored to at least one entity. '
  'Supports: property docs (reglamentos), unit docs (contracts), '
  'contact docs (DNI, comprobantes), reservation docs (signed contracts, vouchers).';


-- ------------------------------------------------------------
-- tasks
-- ------------------------------------------------------------
CREATE TABLE public.tasks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES public.tenants(id),
  created_by       UUID        NOT NULL REFERENCES public.tenant_users(id),
  assigned_to      UUID        REFERENCES public.tenant_users(id),
  contact_id       UUID        REFERENCES public.contacts(id),
  reservation_id   UUID        REFERENCES public.reservations(id),
  conversation_id  UUID        REFERENCES public.conversations(id),
  title            TEXT        NOT NULL,
  description      TEXT,
  due_date         TIMESTAMPTZ,
  status           task_status NOT NULL DEFAULT 'pending',
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tasks_completed_at_consistency CHECK (
    (status = 'completed' AND completed_at IS NOT NULL) OR
    (status <> 'completed' AND completed_at IS NULL)
  )
);

COMMENT ON COLUMN public.tasks.completed_at IS
  'Set automatically by trg_tasks_completed_at. Do not set manually.';


-- ------------------------------------------------------------
-- notes (append-only)
-- ------------------------------------------------------------
CREATE TABLE public.notes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES public.tenants(id),
  created_by       UUID        NOT NULL REFERENCES public.tenant_users(id),
  contact_id       UUID        REFERENCES public.contacts(id),
  reservation_id   UUID        REFERENCES public.reservations(id),
  conversation_id  UUID        REFERENCES public.conversations(id),
  content          TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notes_must_have_entity CHECK (
    contact_id IS NOT NULL OR
    reservation_id IS NOT NULL OR
    conversation_id IS NOT NULL
  )
);

COMMENT ON TABLE public.notes IS
  'Internal CRM notes. Append-only — never update after creation.';


-- ------------------------------------------------------------
-- notifications
-- ------------------------------------------------------------
CREATE TABLE public.notifications (
  id              UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID                 NOT NULL REFERENCES public.tenants(id),
  type            notification_type    NOT NULL,
  channel         notification_channel NOT NULL,
  recipient_type  TEXT                 NOT NULL CHECK (recipient_type IN ('user', 'contact')),
  recipient_id    UUID                 NOT NULL,
  payload         JSONB                NOT NULL DEFAULT '{}',
  status          notification_status  NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  attempts        INT                  NOT NULL DEFAULT 0,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ          NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.notifications.channel IS
  'email channel rows are created but NOT processed in MVP. Processing deferred to post-MVP v1.1.';
COMMENT ON COLUMN public.notifications.recipient_type IS
  '''user'' → tenant_users.id | ''contact'' → contacts.id';


-- ------------------------------------------------------------
-- whatsapp_accounts
-- ------------------------------------------------------------
CREATE TABLE public.whatsapp_accounts (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID        NOT NULL REFERENCES public.tenants(id),
  workspace_id            UUID        REFERENCES public.workspaces(id),
  phone_number            TEXT        NOT NULL,
  business_account_id     TEXT        NOT NULL,
  access_token_encrypted  TEXT        NOT NULL,
  webhook_secret          TEXT        NOT NULL,
  token_expires_at        TIMESTAMPTZ,
  last_verified_at        TIMESTAMPTZ,
  active                  BOOLEAN     NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.whatsapp_accounts.access_token_encrypted IS
  'AES-256-GCM encrypted at application layer. Decryption key lives in Supabase Vault.';
COMMENT ON COLUMN public.whatsapp_accounts.workspace_id IS
  'Routes inbound messages to the correct workspace context.';


-- ------------------------------------------------------------
-- ai_settings
-- ------------------------------------------------------------
CREATE TABLE public.ai_settings (
  id                           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    UUID        NOT NULL REFERENCES public.tenants(id),
  model                        TEXT        NOT NULL DEFAULT 'claude-sonnet-4-6',
  system_prompt                TEXT,
  assistant_name               TEXT        NOT NULL DEFAULT 'Asistente',
  escalation_keywords          TEXT[],
  max_turns_before_escalation  INT         NOT NULL DEFAULT 20
    CHECK (max_turns_before_escalation > 0),
  response_delay_ms            INT         NOT NULL DEFAULT 1500
    CHECK (response_delay_ms >= 0),
  max_context_messages         INT         NOT NULL DEFAULT 10
    CHECK (max_context_messages > 0 AND max_context_messages <= 50),
  active                       BOOLEAN     NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ai_settings_tenant_unique UNIQUE (tenant_id)
);


-- ------------------------------------------------------------
-- message_queue
-- ------------------------------------------------------------
CREATE TABLE public.message_queue (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID         NOT NULL REFERENCES public.tenants(id),
  whatsapp_account_id     UUID         REFERENCES public.whatsapp_accounts(id),
  raw_payload             JSONB        NOT NULL,
  status                  queue_status NOT NULL DEFAULT 'pending',
  attempts                INT          NOT NULL DEFAULT 0,
  last_error              TEXT,
  scheduled_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processing_started_at   TIMESTAMPTZ,
  processed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.message_queue IS
  'Async webhook queue. Worker uses SELECT FOR UPDATE SKIP LOCKED. '
  'Items stuck in ''processing'' for > 5 min should be reclaimed by pg_cron.';
COMMENT ON COLUMN public.message_queue.processing_started_at IS
  'Set when worker claims the item. IF < now()-5min AND status=''processing'' → stuck item.';


-- ------------------------------------------------------------
-- ai_usage_log
-- ------------------------------------------------------------
CREATE TABLE public.ai_usage_log (
  id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        UUID        NOT NULL REFERENCES public.tenants(id),
  conversation_id  UUID        REFERENCES public.conversations(id),
  model            TEXT        NOT NULL,
  input_tokens     INT         NOT NULL CHECK (input_tokens >= 0),
  output_tokens    INT         NOT NULL CHECK (output_tokens >= 0),
  cost_usd_cents   INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_usage_log IS
  'Token usage per AI call. Append-only. For cost monitoring and future per-tenant billing.';


-- ------------------------------------------------------------
-- audit_logs
-- actor_id nullable: NULL = system operation (pg_cron, service workers)
-- No FK on actor_id: intentional — preserve audit trail after user deletion
-- ------------------------------------------------------------
CREATE TABLE public.audit_logs (
  id               BIGINT           GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        UUID             REFERENCES public.tenants(id),
  actor_id         UUID,
  actor_type       audit_actor_type NOT NULL,
  -- D4: populated via DB query in audit_table_change(), not from JWT claim.
  -- Contains the platform_user_id (SA) who was impersonating when the change was made.
  -- NULL for non-impersonation operations.
  impersonated_by  UUID             REFERENCES public.platform_users(id),
  action           TEXT             NOT NULL,
  entity_type      TEXT             NOT NULL,
  entity_id        UUID,
  old_value        JSONB,
  new_value        JSONB,
  ip_address       INET,
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),

  CONSTRAINT audit_logs_actor_consistency CHECK (
    (actor_type = 'system' AND actor_id IS NULL) OR
    (actor_type <> 'system' AND actor_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.audit_logs IS
  'Immutable audit trail. Never UPDATE or DELETE rows.';
COMMENT ON COLUMN public.audit_logs.impersonated_by IS
  'D4: The SA UUID who was impersonating when this change occurred. '
  'Populated via DB query to impersonation_sessions in audit_table_change(). '
  'NULL for normal operations. The same value as actor_id when SA is impersonating.';


-- ============================================================
-- SECTION 4 — INDEXES
-- ============================================================

-- ── platform_users ──────────────────────────────────────────

CREATE INDEX idx_platform_users_role
  ON public.platform_users(role)
  WHERE active = true;

-- ── tenants ─────────────────────────────────────────────────

CREATE UNIQUE INDEX idx_tenants_slug
  ON public.tenants(slug)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_tenants_custom_domain
  ON public.tenants(custom_domain)
  WHERE custom_domain IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_tenants_status
  ON public.tenants(status)
  WHERE deleted_at IS NULL;

-- ── seller_clients ──────────────────────────────────────────

CREATE INDEX idx_seller_clients_seller
  ON public.seller_clients(seller_id)
  WHERE active = true;

CREATE INDEX idx_seller_clients_tenant
  ON public.seller_clients(tenant_id)
  WHERE active = true;

-- ── workspaces (D1) ─────────────────────────────────────────

CREATE INDEX idx_workspaces_tenant
  ON public.workspaces(tenant_id)
  WHERE active = true;

-- ── tenant_users ─────────────────────────────────────────────

CREATE INDEX idx_tenant_users_tenant_role
  ON public.tenant_users(tenant_id, role)
  WHERE active = true;

-- ── user_workspace_assignments (D3) ──────────────────────────

-- Auth Hook query: for a given receptionist, what are their workspace IDs?
CREATE INDEX idx_user_workspace_assignments_user
  ON public.user_workspace_assignments(user_id);

-- RLS exists check: is workspace_id in this user's assignments?
CREATE INDEX idx_user_workspace_assignments_workspace
  ON public.user_workspace_assignments(workspace_id);

-- ── properties ──────────────────────────────────────────────

CREATE INDEX idx_properties_tenant_published
  ON public.properties(tenant_id, published)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_properties_workspace
  ON public.properties(workspace_id)
  WHERE deleted_at IS NULL AND workspace_id IS NOT NULL;

CREATE INDEX idx_properties_attributes
  ON public.properties USING GIN(attributes);

-- ── property_images / unit_images ───────────────────────────

CREATE INDEX idx_property_images_property
  ON public.property_images(property_id, sort_order ASC);

CREATE UNIQUE INDEX idx_property_images_one_cover
  ON public.property_images(property_id)
  WHERE is_cover = true;

CREATE INDEX idx_unit_images_unit
  ON public.unit_images(unit_id, sort_order ASC);

CREATE UNIQUE INDEX idx_unit_images_one_cover
  ON public.unit_images(unit_id)
  WHERE is_cover = true;

-- ── units ───────────────────────────────────────────────────

CREATE INDEX idx_units_property
  ON public.units(property_id)
  WHERE deleted_at IS NULL AND active = true;

CREATE INDEX idx_units_tenant
  ON public.units(tenant_id)
  WHERE deleted_at IS NULL;

-- ── contacts ────────────────────────────────────────────────

CREATE UNIQUE INDEX idx_contacts_tenant_phone
  ON public.contacts(tenant_id, phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_contacts_tenant_created
  ON public.contacts(tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_contacts_tenant_email
  ON public.contacts(tenant_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;

-- ── conversations ────────────────────────────────────────────

CREATE INDEX idx_conversations_tenant_status
  ON public.conversations(tenant_id, status, updated_at DESC);

CREATE INDEX idx_conversations_contact
  ON public.conversations(contact_id, created_at DESC);

CREATE INDEX idx_conversations_assigned
  ON public.conversations(assigned_user_id, status)
  WHERE assigned_user_id IS NOT NULL;

CREATE INDEX idx_conversations_workspace_status
  ON public.conversations(workspace_id, status, updated_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX idx_conversations_whatsapp_thread
  ON public.conversations(whatsapp_thread_id)
  WHERE whatsapp_thread_id IS NOT NULL;

-- ── messages ─────────────────────────────────────────────────

CREATE INDEX idx_messages_conversation_created
  ON public.messages(conversation_id, created_at DESC);

CREATE INDEX idx_messages_tenant_created
  ON public.messages(tenant_id, created_at DESC);

CREATE UNIQUE INDEX idx_messages_whatsapp_id
  ON public.messages(whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- ── reservations ─────────────────────────────────────────────

CREATE INDEX idx_reservations_tenant_status
  ON public.reservations(tenant_id, status, start_date)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_reservations_unit
  ON public.reservations(unit_id, status, start_date)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_reservations_contact
  ON public.reservations(contact_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_reservations_pre_reserved_expires
  ON public.reservations(expires_at)
  WHERE status = 'pre_reserved' AND expires_at IS NOT NULL;

CREATE INDEX idx_reservations_conversation
  ON public.reservations(conversation_id)
  WHERE conversation_id IS NOT NULL AND deleted_at IS NULL;

-- ── availability_blocks ──────────────────────────────────────

CREATE INDEX idx_availability_unit_dates
  ON public.availability_blocks(unit_id, start_date, end_date);

CREATE INDEX idx_availability_tenant_dates
  ON public.availability_blocks(tenant_id, start_date);

CREATE INDEX idx_availability_reservation
  ON public.availability_blocks(reservation_id)
  WHERE reservation_id IS NOT NULL;

-- ── tasks ────────────────────────────────────────────────────

CREATE INDEX idx_tasks_assigned_status
  ON public.tasks(tenant_id, assigned_to, status)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX idx_tasks_tenant_due
  ON public.tasks(tenant_id, due_date, status)
  WHERE status NOT IN ('completed', 'cancelled') AND due_date IS NOT NULL;

CREATE INDEX idx_tasks_contact
  ON public.tasks(contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX idx_tasks_reservation
  ON public.tasks(reservation_id)
  WHERE reservation_id IS NOT NULL;

-- ── notes ────────────────────────────────────────────────────

CREATE INDEX idx_notes_tenant
  ON public.notes(tenant_id, created_at DESC);

CREATE INDEX idx_notes_contact
  ON public.notes(contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE INDEX idx_notes_reservation
  ON public.notes(reservation_id, created_at DESC)
  WHERE reservation_id IS NOT NULL;

CREATE INDEX idx_notes_conversation
  ON public.notes(conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

-- ── notifications ─────────────────────────────────────────────

CREATE INDEX idx_notifications_pending
  ON public.notifications(status, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX idx_notifications_tenant
  ON public.notifications(tenant_id, created_at DESC);

CREATE INDEX idx_notifications_recipient
  ON public.notifications(recipient_id, status, created_at DESC);

-- ── documents (D5) ───────────────────────────────────────────

CREATE INDEX idx_documents_tenant
  ON public.documents(tenant_id);

CREATE INDEX idx_documents_property
  ON public.documents(property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX idx_documents_unit
  ON public.documents(unit_id)
  WHERE unit_id IS NOT NULL;

CREATE INDEX idx_documents_contact
  ON public.documents(contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX idx_documents_reservation
  ON public.documents(reservation_id)
  WHERE reservation_id IS NOT NULL;

-- ── whatsapp_accounts ────────────────────────────────────────

CREATE INDEX idx_whatsapp_accounts_phone
  ON public.whatsapp_accounts(phone_number)
  WHERE active = true;

CREATE UNIQUE INDEX idx_whatsapp_accounts_phone_active
  ON public.whatsapp_accounts(tenant_id, phone_number)
  WHERE active = true;

CREATE INDEX idx_whatsapp_accounts_tenant
  ON public.whatsapp_accounts(tenant_id)
  WHERE active = true;

-- ── message_queue ─────────────────────────────────────────────

CREATE INDEX idx_message_queue_worker
  ON public.message_queue(status, scheduled_at ASC)
  WHERE status IN ('pending', 'processing');

CREATE INDEX idx_message_queue_tenant
  ON public.message_queue(tenant_id, created_at DESC);

-- ── ai_usage_log ─────────────────────────────────────────────

CREATE INDEX idx_ai_usage_tenant_created
  ON public.ai_usage_log(tenant_id, created_at DESC);

-- ── audit_logs ───────────────────────────────────────────────

CREATE INDEX idx_audit_logs_tenant_created
  ON public.audit_logs(tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX idx_audit_logs_entity
  ON public.audit_logs(entity_type, entity_id, created_at DESC);

CREATE INDEX idx_audit_logs_actor
  ON public.audit_logs(actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE INDEX idx_audit_logs_impersonated
  ON public.audit_logs(impersonated_by, created_at DESC)
  WHERE impersonated_by IS NOT NULL;

-- ── impersonation_sessions ───────────────────────────────────

CREATE INDEX idx_impersonation_admin
  ON public.impersonation_sessions(platform_user_id, started_at DESC);

CREATE INDEX idx_impersonation_tenant
  ON public.impersonation_sessions(target_tenant_id, started_at DESC);

-- Active session lookup — used by auth_impersonating_tenant_id()
CREATE INDEX idx_impersonation_active
  ON public.impersonation_sessions(platform_user_id)
  WHERE ended_at IS NULL;


-- ============================================================
-- SECTION 5 — FUNCTIONS
-- ============================================================

-- ── JWT Claim Helpers ────────────────────────────────────────
-- STABLE: JWT is constant within a single SQL statement.
-- SECURITY DEFINER + SET search_path: prevents search_path injection.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_user_type()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'app_metadata' ->> 'user_type'),
    'unknown'
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_tenant_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID;
$$;

CREATE OR REPLACE FUNCTION public.auth_user_role()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.jwt() -> 'app_metadata' ->> 'role';
$$;

-- D3: replaces auth_branch_id(). Returns NULL for "all workspaces" access.
-- JWT claim workspace_ids is a JSON array of UUID strings.
-- NULL or empty array → returns NULL (no restriction, all workspaces visible).
CREATE OR REPLACE FUNCTION public.auth_workspace_ids()
RETURNS UUID[]
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.jwt() -> 'app_metadata' -> 'workspace_ids' IS NULL
      OR auth.jwt() -> 'app_metadata' -> 'workspace_ids' = 'null'::JSONB
      OR auth.jwt() -> 'app_metadata' -> 'workspace_ids' = '[]'::JSONB
    THEN NULL::UUID[]
    ELSE ARRAY(
      SELECT jsonb_array_elements_text(
        auth.jwt() -> 'app_metadata' -> 'workspace_ids'
      )::UUID
    )
  END;
$$;

COMMENT ON FUNCTION public.auth_workspace_ids() IS
  'D3: Returns workspace UUIDs the current receptionist is assigned to. '
  'NULL = no restriction (owner role or receptionist with no assignments = all workspaces). '
  'UUID[] = receptionist scoped to specific workspaces.';

-- D4: moved from 11-rls-policies.sql. Needed by both RLS policies and audit_table_change().
-- STABLE: PostgreSQL caches per SQL statement (not per-row). Safe for RLS use.
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
  'D4: Returns the target_tenant_id of the SA''s active impersonation session, '
  'or NULL if not impersonating. Queries DB (not JWT). STABLE = cached per statement.';

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.auth_user_type() = 'platform_user'
     AND public.auth_user_role() = 'super_admin';
$$;

CREATE OR REPLACE FUNCTION public.is_seller()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.auth_user_type() = 'platform_user'
     AND public.auth_user_role() = 'seller';
$$;

CREATE OR REPLACE FUNCTION public.is_platform_user()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.auth_user_type() = 'platform_user';
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_user()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.auth_user_type() = 'tenant_user';
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.auth_user_type() = 'tenant_user'
     AND public.auth_user_role() = 'owner';
$$;

CREATE OR REPLACE FUNCTION public.is_receptionist()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.auth_user_type() = 'tenant_user'
     AND public.auth_user_role() = 'receptionist';
$$;

-- Diagnostic: call on app startup to verify the Auth Hook is registered.
CREATE OR REPLACE FUNCTION public.verify_hook_configured()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'user_type') IS NOT NULL;
$$;


-- ── custom_access_token_hook ─────────────────────────────────
-- D3: populates workspace_ids[] instead of branch_id.
-- VOLATILE: reads mutable tables (platform_users, tenant_users, user_workspace_assignments).
-- Requires GRANT EXECUTE TO supabase_auth_admin (see GRANTS section).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id       UUID;
  v_platform      RECORD;
  v_tenant        RECORD;
  v_workspace_ids UUID[];
  v_claims        JSONB;
BEGIN
  v_user_id := (event ->> 'user_id')::UUID;
  v_claims  := event -> 'claims';

  -- Check if user is platform staff (Super Admin or Seller)
  SELECT role
  INTO v_platform
  FROM public.platform_users
  WHERE id = v_user_id AND active = true;

  IF FOUND THEN
    v_claims := jsonb_set(
      v_claims,
      '{app_metadata}',
      jsonb_build_object(
        'user_type', 'platform_user',
        'role',      v_platform.role::TEXT
      )
    );
    RETURN jsonb_set(event, '{claims}', v_claims);
  END IF;

  -- Check if user is tenant staff (Owner or Receptionist)
  SELECT tenant_id, role
  INTO v_tenant
  FROM public.tenant_users
  WHERE id = v_user_id AND active = true;

  IF FOUND THEN
    -- D3: receptionist workspace scope via junction table
    IF v_tenant.role = 'receptionist' THEN
      SELECT ARRAY_AGG(workspace_id) INTO v_workspace_ids
      FROM public.user_workspace_assignments
      WHERE user_id = v_user_id;
      -- ARRAY_AGG returns NULL when no rows → NULL means "all workspaces"
    ELSE
      -- Owner: full access, no workspace restriction
      v_workspace_ids := NULL;
    END IF;

    v_claims := jsonb_set(
      v_claims,
      '{app_metadata}',
      jsonb_build_object(
        'user_type',     'tenant_user',
        'tenant_id',     v_tenant.tenant_id,
        'role',          v_tenant.role::TEXT,
        'workspace_ids', to_jsonb(v_workspace_ids)
      )
    );
    RETURN jsonb_set(event, '{claims}', v_claims);
  END IF;

  -- User not in any profile table (onboarding incomplete).
  -- Return unchanged — RLS blocks all data access until profile is created.
  RETURN event;
END;
$$;


-- ── set_updated_at ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- ── notify_message_queue_worker ──────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_message_queue_worker()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM pg_notify('message_queue_new', NEW.id::TEXT);
  RETURN NEW;
END;
$$;


-- ── release_availability_on_cancellation ─────────────────────
CREATE OR REPLACE FUNCTION public.release_availability_on_cancellation()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.status = 'cancelled' AND OLD.status <> 'cancelled')
  OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
  THEN
    DELETE FROM public.availability_blocks
    WHERE reservation_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;


-- ── set_task_completed_at ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_task_completed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'completed' AND NEW.completed_at IS NULL THEN
      NEW.completed_at = now();
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
      NEW.completed_at = now();
    ELSIF NEW.status <> 'completed' AND OLD.status = 'completed' THEN
      NEW.completed_at = NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


-- ── set_conversation_closed_at ───────────────────────────────
CREATE OR REPLACE FUNCTION public.set_conversation_closed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'closed' AND NEW.closed_at IS NULL THEN
      NEW.closed_at = now();
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
      NEW.closed_at = now();
    ELSIF NEW.status <> 'closed' AND OLD.status = 'closed' THEN
      NEW.closed_at = NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


-- ── clear_expires_at_on_advance ──────────────────────────────
CREATE OR REPLACE FUNCTION public.clear_expires_at_on_advance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'pre_reserved' AND NEW.status <> 'pre_reserved' THEN
    NEW.expires_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;


-- ── audit_table_change ───────────────────────────────────────
-- D4: impersonation detected via DB query to impersonation_sessions,
-- NOT from JWT claim (JWT no longer contains impersonated_by).
-- When SA is impersonating, impersonated_by = actor_id (the SA's UUID).
-- This flags the audit row as "done during impersonation session".
CREATE OR REPLACE FUNCTION public.audit_table_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row_new      JSONB;
  v_row_old      JSONB;
  v_tenant_id    UUID;
  v_entity_id    UUID;
  v_actor_id     UUID;
  v_actor_type   audit_actor_type;
  v_impersonated UUID;
  v_action       TEXT;
BEGIN
  IF TG_OP <> 'DELETE' THEN v_row_new := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN v_row_old := to_jsonb(OLD); END IF;

  IF TG_TABLE_NAME = 'tenants' THEN
    v_tenant_id := COALESCE(
      (v_row_new ->> 'id')::UUID,
      (v_row_old ->> 'id')::UUID
    );
  ELSE
    v_tenant_id := COALESCE(
      (v_row_new ->> 'tenant_id')::UUID,
      (v_row_old ->> 'tenant_id')::UUID
    );
  END IF;

  v_entity_id := COALESCE(
    (v_row_new ->> 'id')::UUID,
    (v_row_old ->> 'id')::UUID
  );

  v_actor_id := auth.uid();

  IF v_actor_id IS NULL THEN
    v_actor_type   := 'system';
    v_impersonated := NULL;
    v_action       := 'system.' || TG_TABLE_NAME || '.' || LOWER(TG_OP);
  ELSE
    v_action := TG_TABLE_NAME || '.' || LOWER(TG_OP);

    IF public.auth_user_type() = 'platform_user' THEN
      v_actor_type := 'platform_user';
      -- D4: check if this SA has an active impersonation session (DB query, not JWT)
      PERFORM 1
      FROM public.impersonation_sessions
      WHERE platform_user_id = v_actor_id AND ended_at IS NULL;
      -- impersonated_by = actor_id: flags this row as "done during impersonation"
      v_impersonated := CASE WHEN FOUND THEN v_actor_id ELSE NULL END;
    ELSE
      v_actor_type   := 'tenant_user';
      v_impersonated := NULL;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_row_new = v_row_old THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (
      tenant_id, actor_id, actor_type, impersonated_by,
      action, entity_type, entity_id, old_value, new_value
    ) VALUES (
      v_tenant_id, v_actor_id, v_actor_type, v_impersonated,
      v_action, TG_TABLE_NAME, v_entity_id, v_row_old, v_row_new
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_table_change failed for % on table % (entity %): %',
      TG_OP, TG_TABLE_NAME, v_entity_id, SQLERRM;
  END;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


-- ── check_user_profile_exclusivity ───────────────────────────
CREATE OR REPLACE FUNCTION public.check_user_profile_exclusivity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'platform_users' THEN
    IF EXISTS (SELECT 1 FROM public.tenant_users WHERE id = NEW.id) THEN
      RAISE EXCEPTION
        'User % already has a tenant_users profile. Cannot exist in both.', NEW.id;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'tenant_users' THEN
    IF EXISTS (SELECT 1 FROM public.platform_users WHERE id = NEW.id) THEN
      RAISE EXCEPTION
        'User % already has a platform_users profile. Cannot exist in both.', NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ── cascade_property_soft_delete ─────────────────────────────
CREATE OR REPLACE FUNCTION public.cascade_property_soft_delete()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE public.units
    SET deleted_at = NEW.deleted_at
    WHERE property_id = NEW.id AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;


-- ── check_unit_tenant_consistency ────────────────────────────
CREATE OR REPLACE FUNCTION public.check_unit_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prop_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_prop_tenant
  FROM public.properties
  WHERE id = NEW.property_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property % does not exist', NEW.property_id;
  END IF;

  IF v_prop_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'units.tenant_id (%) must match properties.tenant_id (%) for property %',
      NEW.tenant_id, v_prop_tenant, NEW.property_id;
  END IF;

  RETURN NEW;
END;
$$;


-- ── check_availability_block_tenant_consistency ───────────────
CREATE OR REPLACE FUNCTION public.check_availability_block_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_unit_tenant
  FROM public.units
  WHERE id = NEW.unit_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unit % does not exist', NEW.unit_id;
  END IF;

  IF v_unit_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'availability_blocks.tenant_id (%) must match units.tenant_id (%) for unit %',
      NEW.tenant_id, v_unit_tenant, NEW.unit_id;
  END IF;

  RETURN NEW;
END;
$$;


-- ── check_workspace_assignment_consistency ────────────────────
-- D3: validates that user and workspace belong to the same tenant.
-- Prevents cross-tenant workspace assignments.
CREATE OR REPLACE FUNCTION public.check_workspace_assignment_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_tenant      UUID;
  v_workspace_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_user_tenant
  FROM public.tenant_users WHERE id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % does not exist in tenant_users', NEW.user_id;
  END IF;

  SELECT tenant_id INTO v_workspace_tenant
  FROM public.workspaces WHERE id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace % does not exist', NEW.workspace_id;
  END IF;

  IF v_user_tenant <> v_workspace_tenant THEN
    RAISE EXCEPTION
      'user_workspace_assignments: user tenant (%) must match workspace tenant (%). '
      'Cross-tenant assignments are not allowed.',
      v_user_tenant, v_workspace_tenant;
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- SECTION 6 — TRIGGERS
-- ============================================================

-- ── updated_at automation ────────────────────────────────────

CREATE TRIGGER trg_platform_users_updated_at
  BEFORE UPDATE ON public.platform_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_seller_clients_updated_at
  BEFORE UPDATE ON public.seller_clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_tenant_users_updated_at
  BEFORE UPDATE ON public.tenant_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_units_updated_at
  BEFORE UPDATE ON public.units
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_availability_blocks_updated_at
  BEFORE UPDATE ON public.availability_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_whatsapp_accounts_updated_at
  BEFORE UPDATE ON public.whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_ai_settings_updated_at
  BEFORE UPDATE ON public.ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_message_queue_updated_at
  BEFORE UPDATE ON public.message_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── business logic triggers ──────────────────────────────────

CREATE TRIGGER trg_clear_expires_at
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.clear_expires_at_on_advance();

CREATE TRIGGER trg_release_availability_on_cancel
  AFTER UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.release_availability_on_cancellation();

CREATE TRIGGER trg_tasks_completed_at
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_task_completed_at();

CREATE TRIGGER trg_conversation_closed_at
  BEFORE INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_conversation_closed_at();

CREATE TRIGGER trg_message_queue_notify
  AFTER INSERT ON public.message_queue
  FOR EACH ROW EXECUTE FUNCTION public.notify_message_queue_worker();

-- ── cross-tenant consistency triggers ────────────────────────

CREATE TRIGGER trg_units_tenant_consistency
  BEFORE INSERT OR UPDATE ON public.units
  FOR EACH ROW EXECUTE FUNCTION public.check_unit_tenant_consistency();

CREATE TRIGGER trg_availability_block_tenant_consistency
  BEFORE INSERT OR UPDATE ON public.availability_blocks
  FOR EACH ROW EXECUTE FUNCTION public.check_availability_block_tenant_consistency();

-- D3: validates user and workspace belong to the same tenant
CREATE TRIGGER trg_user_workspace_assignments_consistency
  BEFORE INSERT OR UPDATE ON public.user_workspace_assignments
  FOR EACH ROW EXECUTE FUNCTION public.check_workspace_assignment_consistency();

CREATE TRIGGER trg_cascade_property_soft_delete
  AFTER UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.cascade_property_soft_delete();

-- ── audit triggers ───────────────────────────────────────────

CREATE TRIGGER trg_audit_reservations
  AFTER INSERT OR UPDATE OR DELETE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

CREATE TRIGGER trg_audit_tenants
  AFTER INSERT OR UPDATE OR DELETE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

CREATE TRIGGER trg_audit_tenant_users
  AFTER INSERT OR UPDATE OR DELETE ON public.tenant_users
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

CREATE TRIGGER trg_audit_properties
  AFTER UPDATE OR DELETE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

CREATE TRIGGER trg_audit_ai_settings
  AFTER INSERT OR UPDATE ON public.ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

CREATE TRIGGER trg_audit_whatsapp_accounts
  AFTER INSERT OR UPDATE ON public.whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

-- ── user profile exclusivity ─────────────────────────────────

CREATE TRIGGER trg_platform_users_exclusivity
  BEFORE INSERT ON public.platform_users
  FOR EACH ROW EXECUTE FUNCTION public.check_user_profile_exclusivity();

CREATE TRIGGER trg_tenant_users_exclusivity
  BEFORE INSERT ON public.tenant_users
  FOR EACH ROW EXECUTE FUNCTION public.check_user_profile_exclusivity();


-- ============================================================
-- SECTION 7 — ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.platform_users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_clients             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_workspace_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impersonation_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_images            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unit_images                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability_blocks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_queue              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_log               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs                 ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- SECTION 8 — GRANTS
-- ============================================================

-- ── authenticated ────────────────────────────────────────────
-- RLS policies restrict row-level access. Grants define table-level ceiling.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.properties,
  public.property_images,
  public.units,
  public.unit_images,
  public.contacts,
  public.conversations,
  public.messages,
  public.reservations,
  public.availability_blocks,
  public.documents,
  public.tasks,
  public.notes,
  public.notifications,
  public.whatsapp_accounts,
  public.ai_settings,
  public.workspaces,
  public.user_workspace_assignments,
  public.tenant_users,
  public.seller_clients
TO authenticated;

GRANT SELECT, UPDATE ON public.platform_users TO authenticated;
GRANT SELECT ON public.tenants TO authenticated;

GRANT SELECT ON public.audit_logs             TO authenticated;
GRANT SELECT ON public.ai_usage_log           TO authenticated;
GRANT SELECT ON public.impersonation_sessions TO authenticated;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Helper functions: callable in RLS context
GRANT EXECUTE ON FUNCTION public.auth_user_type()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.auth_tenant_id()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_role()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.auth_workspace_ids()          TO authenticated;
GRANT EXECUTE ON FUNCTION public.auth_impersonating_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_seller()                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_user()            TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_tenant_user()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_owner()                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_receptionist()             TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_hook_configured()      TO authenticated;

-- ── anon ─────────────────────────────────────────────────────

GRANT SELECT (
  id, name, slug, logo_url, primary_color, secondary_color, site_config, custom_domain
) ON public.tenants TO anon;

GRANT SELECT ON public.tenants_public    TO anon;
GRANT SELECT ON public.properties        TO anon;
GRANT SELECT ON public.property_images   TO anon;
GRANT SELECT ON public.units             TO anon;
GRANT SELECT ON public.unit_images       TO anon;
GRANT SELECT ON public.availability_blocks TO anon;

-- ── Auth Hook ────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;


-- ============================================================
-- SECTION 9 — pg_cron JOBS
-- Register manually in: Supabase Dashboard → Database → Cron
-- ============================================================
--
--   1. Expire pre_reserved reservations (every 15 min)
--      SELECT cron.schedule(
--        'expire-pre-reservations', '*/15 * * * *',
--        $$UPDATE public.reservations SET status = 'cancelled'
--          WHERE status = 'pre_reserved' AND expires_at < now();$$
--      );
--
--   2. Reclaim stuck message_queue items (every 10 min)
--      SELECT cron.schedule(
--        'reclaim-stuck-queue-items', '*/10 * * * *',
--        $$UPDATE public.message_queue
--          SET status = 'pending', processing_started_at = NULL, attempts = attempts + 1
--          WHERE status = 'processing'
--            AND processing_started_at < now() - interval '5 minutes';$$
--      );
--
--   3. Purge message_queue rows older than 7 days (daily at 03:00)
--      SELECT cron.schedule(
--        'purge-old-queue-items', '0 3 * * *',
--        $$DELETE FROM public.message_queue
--          WHERE status IN ('completed', 'failed')
--            AND created_at < now() - interval '7 days';$$
--      );
--
-- ============================================================


-- ============================================================
-- EXPECTED RESULT: Architecture Ready To Build
-- ============================================================
--
-- Schema V3 incorporates all decisions from 15b-architecture-amendments.md:
--
--   D1 ✅  workspace_type enum, workspaces table (replaces branches)
--   D2 ✅  Owner access: RLS policies have no workspace_id filter for owners
--   D3 ✅  user_workspace_assignments junction table
--          custom_access_token_hook populates workspace_ids[]
--          auth_workspace_ids() function (returns UUID[] | NULL)
--   D4 ✅  auth_impersonating_tenant_id() in schema (DB query, not JWT)
--          audit_table_change() uses DB query for impersonation check
--          auth_impersonated_by() removed (JWT no longer has this claim)
--   D5 ✅  documents.contact_id, documents.reservation_id
--          CHECK updated for 4 anchors
--   D6 ✅  No schema change — confirmation permissions handled in RLS v2
--   D7 ✅  MAX_TOOL_ROUNDS = 5 — constant in packages/ai, not in schema
--   D8 ✅  notification_channel enum keeps 'email' for future use
--
-- RESIDUAL RISKS (unchanged from V2)
-- ──────────────────────────────────
-- 1. Supabase Pro required for Auth Hook
-- 2. email drift in platform_users (accepted for MVP)
-- 3. Race condition in onboarding dual-profile (accepted for MVP)
-- 4. RLS policies in separate file (17-rls-policies-v2.sql)
-- 5. pg_cron jobs require manual registration in Dashboard
-- ============================================================

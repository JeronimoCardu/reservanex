-- ============================================================
-- OrderFlow — Supabase Schema
-- Version:  1.0
-- Date:     2026-06-22
-- Database: PostgreSQL 17 (Supabase)
-- ============================================================
--
-- SOURCE DOCUMENTS
--   06-architecture.md      System architecture
--   07-database-v2.md       Data model V2
--   08-permissions-and-rls.md  Permissions & RLS strategy
--   09-ai-architecture.md   AI pipeline & tool definitions
--
-- RESOLVED INCONSISTENCIES
--   1. conversations.source + conversation_source enum added
--      (defined in 09-ai-architecture.md, absent in 07-database-v2.md)
--   2. Helper functions placed in public schema (not auth schema)
--      (auth schema creation requires elevated Supabase permissions)
--   3. message_queue.updated_at added for status transition monitoring
--   4. contacts(tenant_id, phone) UNIQUE implemented as partial index,
--      not table constraint (table UNIQUE cannot be partial)
--   5. audit_logs actor field named actor_id per prompt requirements
--      (07-database-v2.md used user_id)
--   6. ai_usage_log included per 09-ai-architecture.md + prompt requirements
--
-- SECTIONS
--   1. Extensions
--   2. Enums
--   3. Tables (dependency order)
--   4. Indexes
--   5. Functions
--   6. Triggers
--   7. RLS + Grants
-- ============================================================


-- ============================================================
-- SECTION 1 — EXTENSIONS
-- ============================================================

-- uuid-ossp: gen_random_uuid() is built-in in PG 13+, but pgcrypto
-- provides gen_random_bytes() used in token generation utilities.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- pg_net: needed if Supabase Edge Functions call external APIs
-- from triggers (e.g., webhook fan-out). Not required for MVP core.
-- CREATE EXTENSION IF NOT EXISTS "pg_net";


-- ============================================================
-- SECTION 2 — ENUMS
-- ============================================================
-- All state fields use enums, never plain TEXT.
-- Rationale: enums are type-safe, self-documenting, and slightly
-- faster to compare than text. Adding values later requires
-- ALTER TYPE ... ADD VALUE which is non-blocking in PG 12+.
-- ============================================================

-- Internal OrderFlow employee roles
CREATE TYPE platform_role AS ENUM (
  'super_admin',
  'seller'
);

-- Roles within a tenant (real estate agency)
CREATE TYPE tenant_role AS ENUM (
  'owner',
  'receptionist'
);

-- Tenant account lifecycle
CREATE TYPE tenant_status AS ENUM (
  'trial',
  'active',
  'suspended',
  'churned'
);

-- Feature/price tiers (used to enforce property/user limits)
CREATE TYPE plan_tier AS ENUM (
  'starter',
  'pro'
);

-- Conversation thread states
CREATE TYPE conversation_status AS ENUM (
  'open',       -- actively handled or waiting for client
  'waiting',    -- escalated to human, pending response
  'closed'      -- resolved, no further action expected
);

-- How the conversation was initiated
CREATE TYPE conversation_channel AS ENUM (
  'whatsapp',
  'manual'
);

-- Source of the conversation (used by AI to inject property context)
-- whatsapp_direct: client wrote to the number directly
-- website_button:  client clicked "Consultar por WhatsApp" on the public site
-- manual:          created by a team member from the dashboard
CREATE TYPE conversation_source AS ENUM (
  'whatsapp_direct',
  'website_button',
  'manual'
);

-- Whether the AI is handling this conversation
CREATE TYPE ai_mode AS ENUM (
  'auto',      -- AI responds automatically
  'human',     -- human agent has taken over
  'disabled'   -- AI permanently off for this conversation
);

-- Who sent a message in a conversation
CREATE TYPE message_sender AS ENUM (
  'customer',  -- external client
  'ai',        -- the AI assistant
  'human'      -- a tenant team member
);

-- Full booking funnel state machine
CREATE TYPE reservation_status AS ENUM (
  'inquiry',          -- initial contact, no commitment
  'interested',       -- client expressed interest
  'pre_reserved',     -- dates blocked, awaiting payment (expires_at is active)
  'pending_payment',  -- payment sent, awaiting confirmation
  'confirmed',        -- payment verified, booking locked
  'cancelled'         -- booking cancelled by any party
);

-- Why a calendar block exists
CREATE TYPE block_reason AS ENUM (
  'reservation',   -- linked to a reservation row
  'maintenance',   -- property/unit unavailable for maintenance
  'manual'         -- manually blocked by a team member
);

-- Document classification
CREATE TYPE document_type AS ENUM (
  'contract',
  'regulation',
  'policy',
  'manual'
);

-- Task lifecycle
CREATE TYPE task_status AS ENUM (
  'pending',
  'in_progress',
  'completed',
  'cancelled'
);

-- Events that can trigger a notification
CREATE TYPE notification_type AS ENUM (
  'new_conversation',
  'new_reservation',
  'ai_escalation',
  'reservation_confirmed',
  'reservation_cancelled',
  'payment_received'
);

-- Delivery channel for notifications
CREATE TYPE notification_channel AS ENUM (
  'whatsapp',
  'email',
  'in_app'
);

-- Notification delivery lifecycle
CREATE TYPE notification_status AS ENUM (
  'pending',
  'sent',
  'failed'
);

-- Async message queue processing state
CREATE TYPE queue_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed'
);

-- Who performed an audited action
CREATE TYPE audit_actor_type AS ENUM (
  'platform_user',
  'tenant_user'
);

-- How a contact entered the system
CREATE TYPE contact_source AS ENUM (
  'whatsapp',  -- arrived via WhatsApp message
  'website',   -- created from public site lead form
  'manual'     -- manually added by team member
);


-- ============================================================
-- SECTION 3 — TABLES
-- ============================================================
-- Creation order respects FK dependencies.
-- Dependency chain:
--   platform_users → tenants → seller_clients
--   tenants → branches → tenant_users
--   tenants + branches → properties → property_images
--   tenants + properties → units → unit_images
--   tenants → contacts
--   tenants + contacts + branches + tenant_users → conversations
--   tenants + conversations + tenant_users → messages
--   tenants + contacts + units + conversations → reservations
--   tenants + units + reservations + tenant_users → availability_blocks
--   tenants + properties + units → documents
--   tenants + tenant_users + contacts + reservations + conversations → tasks, notes
--   tenants → notifications, whatsapp_accounts, ai_settings
--   tenants + whatsapp_accounts → message_queue
--   tenants + conversations → ai_usage_log
--   tenants + platform_users → impersonation_sessions, audit_logs
-- ============================================================


-- ------------------------------------------------------------
-- platform_users
-- Internal OrderFlow users: Super Admin and Seller.
-- id is the same UUID as auth.users.id (Supabase Auth).
-- ON DELETE CASCADE: removing the auth user removes the profile.
-- ------------------------------------------------------------
CREATE TABLE public.platform_users (
  id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  role        platform_role NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT platform_users_email_unique UNIQUE (email)
);

COMMENT ON TABLE public.platform_users IS
  'OrderFlow internal staff (Super Admin, Seller). Shares UUID with auth.users.';
COMMENT ON COLUMN public.platform_users.id IS
  'Same UUID as auth.users.id. No explicit FK to avoid schema coupling with auth schema.';


-- ------------------------------------------------------------
-- tenants
-- Each row is one real estate agency — a paying customer of OrderFlow.
-- slug: used as subdomain {slug}.orderflow.app.
-- site_config: flexible JSONB for public website appearance.
--   Expected keys: template, hero_title, hero_subtitle, about_text,
--                  seo_title, seo_description, font, show_prices, contact_email
-- ------------------------------------------------------------
CREATE TABLE public.tenants (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  slug             TEXT        NOT NULL,
  status           tenant_status NOT NULL DEFAULT 'trial',
  plan             plan_tier   NOT NULL DEFAULT 'starter',
  trial_ends_at    TIMESTAMPTZ,
  max_properties   INT         NOT NULL DEFAULT 10 CHECK (max_properties > 0),
  max_users        INT         NOT NULL DEFAULT 5  CHECK (max_users > 0),
  logo_url         TEXT,
  primary_color    CHAR(7)     CHECK (primary_color    ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color  CHAR(7)     CHECK (secondary_color  ~ '^#[0-9A-Fa-f]{6}$'),
  site_config      JSONB       NOT NULL DEFAULT '{}',
  custom_domain    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);

COMMENT ON TABLE public.tenants IS
  'Real estate agency accounts. Each tenant has an isolated data space enforced by RLS.';
COMMENT ON COLUMN public.tenants.slug IS
  'Subdomain identifier. Must be globally unique across active tenants.';
COMMENT ON COLUMN public.tenants.site_config IS
  'Public website settings. Schema: { template, hero_title, hero_subtitle, '
  'about_text, seo_title, seo_description, font, show_prices, contact_email }';


-- ------------------------------------------------------------
-- seller_clients
-- Assignment of OrderFlow Sellers to Tenants they manage.
-- A seller can manage multiple tenants; a tenant can have multiple sellers
-- (co-management or handoffs). commission_percentage tracks earnings.
-- ------------------------------------------------------------
CREATE TABLE public.seller_clients (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id             UUID        NOT NULL REFERENCES public.platform_users(id),
  tenant_id             UUID        NOT NULL REFERENCES public.tenants(id),
  commission_percentage NUMERIC(5,2) CHECK (
    commission_percentage >= 0 AND commission_percentage <= 100
  ),
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT seller_clients_pair_unique UNIQUE (seller_id, tenant_id)
);

COMMENT ON TABLE public.seller_clients IS
  'Many-to-many: which sellers manage which tenants, with commission tracking.';


-- ------------------------------------------------------------
-- branches
-- Physical offices or locations of a tenant.
-- A receptionist can be scoped to one branch via tenant_users.branch_id.
-- ------------------------------------------------------------
CREATE TABLE public.branches (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id),
  name        TEXT        NOT NULL,
  address     TEXT,
  city        TEXT,
  phone       TEXT,
  email       TEXT,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.branches IS
  'Physical offices of a tenant. Receptionists and WhatsApp numbers can be scoped per branch.';


-- ------------------------------------------------------------
-- tenant_users
-- Users of a real estate agency: Owner and Receptionist.
-- id mirrors auth.users.id.
-- branch_id: NULL → access all branches (mandatory for owner role).
-- CONSTRAINT owner_no_branch: owners must never be limited to one branch.
-- CONSTRAINT tenant_users_email_unique: one email per tenant.
-- ------------------------------------------------------------
CREATE TABLE public.tenant_users (
  id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id),
  branch_id   UUID        REFERENCES public.branches(id),
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  role        tenant_role NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tenant_users_email_unique UNIQUE (tenant_id, email),
  CONSTRAINT owner_no_branch CHECK (
    NOT (role = 'owner' AND branch_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.tenant_users IS
  'Tenant staff (owner, receptionist). Shares UUID with auth.users.';
COMMENT ON COLUMN public.tenant_users.branch_id IS
  'NULL = access all branches. Must be NULL for owners. '
  'For receptionists: scopes their visible conversations/properties to this branch.';


-- ------------------------------------------------------------
-- impersonation_sessions
-- Every time a Super Admin accesses a tenant on behalf of support,
-- a session record is created here. All actions under impersonation
-- link back to this via audit_logs.impersonated_by.
-- Append-only: no updated_at.
-- ------------------------------------------------------------
CREATE TABLE public.impersonation_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id UUID        NOT NULL REFERENCES public.platform_users(id),
  target_tenant_id UUID        NOT NULL REFERENCES public.tenants(id),
  reason           TEXT        NOT NULL,
  ip_address       INET,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.impersonation_sessions IS
  'Audit trail for Super Admin impersonation of tenant accounts. Append-only.';


-- ------------------------------------------------------------
-- properties
-- A property, complex or building that groups one or more units.
--
-- CRITICAL CHANGE from V1:
--   property_attributes (EAV table) replaced by attributes JSONB.
--   Reason: EAV has no type system and cannot be indexed for
--   AI queries like "properties with pileta AND cochera".
--   With GIN index: attributes @> ''{"pileta": true}'' uses the index.
-- ------------------------------------------------------------
CREATE TABLE public.properties (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id),
  branch_id       UUID        REFERENCES public.branches(id),
  title           TEXT        NOT NULL,
  description     TEXT,
  city            TEXT,
  neighborhood    TEXT,
  address         TEXT,
  google_maps_url TEXT,
  -- Structured amenities. Example:
  --   { "pileta": true, "cochera": true, "mascotas": false,
  --     "wifi": true, "parrilla": true, "tipo": "cabaña" }
  attributes      JSONB       NOT NULL DEFAULT '{}',
  published       BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

COMMENT ON TABLE public.properties IS
  'Buildings or complexes grouping rentable units. attributes JSONB replaces EAV.';
COMMENT ON COLUMN public.properties.attributes IS
  'JSONB amenity map. Indexed with GIN for AI search_properties() tool calls.';


-- ------------------------------------------------------------
-- property_images
-- Gallery images for a property (cover, banner, slideshow).
-- ON DELETE CASCADE: images are meaningless without their property.
-- Justify cascade: deleting a property is a soft-delete on properties
-- but if the property row is hard-deleted (admin action), orphan image
-- rows with broken URLs serve no purpose and waste storage.
-- In practice: soft-delete on properties means cascade rarely fires.
-- ------------------------------------------------------------
CREATE TABLE public.property_images (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID        NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  image_url    TEXT        NOT NULL,
  sort_order   INT         NOT NULL DEFAULT 0,
  is_cover     BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No updated_at: images are replaced (delete + insert), not edited.
);

COMMENT ON TABLE public.property_images IS
  'Photo gallery for properties. Images are immutable — replace via delete+insert.';


-- ------------------------------------------------------------
-- units
-- Individual bookable rooms, cabins or apartments within a property.
-- tenant_id is denormalized here for two reasons:
--   1. RLS policies can filter directly without a JOIN to properties.
--   2. The availability query (unit_id, start_date, end_date) stays
--      within this table's index space.
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
  'Denormalized from properties.tenant_id for direct RLS filtering and index efficiency.';


-- ------------------------------------------------------------
-- unit_images
-- Gallery images for individual units.
-- ON DELETE CASCADE: same rationale as property_images.
-- ------------------------------------------------------------
CREATE TABLE public.unit_images (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     UUID        NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  image_url   TEXT        NOT NULL,
  sort_order  INT         NOT NULL DEFAULT 0,
  is_cover    BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No updated_at: images are replaced, not edited.
);


-- ------------------------------------------------------------
-- contacts
-- External clients who interact with the tenant.
-- phone is the primary identifier for WhatsApp deduplication.
-- Uniqueness on (tenant_id, phone) is a PARTIAL UNIQUE INDEX
-- (not a table constraint) to allow soft-deleted duplicates.
-- See INDEXES section for: idx_contacts_tenant_phone.
-- ------------------------------------------------------------
CREATE TABLE public.contacts (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID          NOT NULL REFERENCES public.tenants(id),
  name        TEXT,
  phone       TEXT,
  email       TEXT,
  source      contact_source NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

COMMENT ON TABLE public.contacts IS
  'External clients. Phone is the WhatsApp identifier. '
  'Uniqueness enforced via partial index, not table constraint.';


-- ------------------------------------------------------------
-- conversations
-- A communication thread between a contact and a tenant.
--
-- ai_mode: controls whether the AI assistant handles responses.
--   auto   → AI responds to every incoming message
--   human  → human agent has taken over; AI is paused
--   disabled → AI permanently off for this conversation
--
-- source: how the thread started.
--   website_button → client clicked "Consultar por WhatsApp" on public site;
--   the first message contains [property_id:...][unit_id:...] context.
--
-- whatsapp_thread_id: Meta's conversation identifier, used to
--   maintain thread context within the 24h customer service window.
-- ------------------------------------------------------------
CREATE TABLE public.conversations (
  id                 UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID                  NOT NULL REFERENCES public.tenants(id),
  contact_id         UUID                  NOT NULL REFERENCES public.contacts(id),
  branch_id          UUID                  REFERENCES public.branches(id),
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

COMMENT ON COLUMN public.conversations.source IS
  'How the conversation started. website_button injects property context into AI.';
COMMENT ON COLUMN public.conversations.assigned_user_id IS
  'FK to tenant_users. Application layer must verify the user belongs to the same tenant.';


-- ------------------------------------------------------------
-- messages
-- Individual messages within a conversation.
-- Immutable: no updated_at, no deleted_at, no soft delete.
-- Append-only design enables safe archival after 12 months.
--
-- tenant_id denormalized: avoids a JOIN to conversations in
--   every RLS policy check and message-listing query.
--
-- whatsapp_message_id: Meta's unique message ID.
--   Used with ON CONFLICT DO NOTHING for idempotent webhook handling.
--   Meta retries webhooks on timeout — without this, duplicates occur.
--
-- sender_id: only set when sender_type = 'human'.
--   CHECK constraint enforces this at the DB level.
-- ------------------------------------------------------------
CREATE TABLE public.messages (
  id                   UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID           NOT NULL REFERENCES public.tenants(id),
  conversation_id      UUID           NOT NULL REFERENCES public.conversations(id),
  sender_type          message_sender NOT NULL,
  sender_id            UUID           REFERENCES public.tenant_users(id),
  content              TEXT           NOT NULL,
  -- MVP uses 'text' only. Prepared for future: image, document, audio.
  content_type         TEXT           NOT NULL DEFAULT 'text',
  -- Additional metadata: WhatsApp message details, media URLs, etc.
  metadata             JSONB,
  whatsapp_message_id  TEXT,
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT messages_sender_id_consistency CHECK (
    (sender_type = 'human'  AND sender_id IS NOT NULL) OR
    (sender_type <> 'human' AND sender_id IS NULL)
  )
);

COMMENT ON COLUMN public.messages.tenant_id IS
  'Denormalized for direct RLS without JOIN. Maintained by application insert logic.';
COMMENT ON COLUMN public.messages.whatsapp_message_id IS
  'Unique ID from Meta API. Enables ON CONFLICT DO NOTHING for webhook deduplication.';


-- ------------------------------------------------------------
-- reservations
-- A booking request from a contact for a specific unit.
--
-- conversation_id: links back to the WhatsApp conversation that
--   originated the reservation. Enables CRM traceability:
--   "this booking came from this chat thread."
--
-- expires_at: Time-to-live for pre_reserved status.
--   Set to now() + 48h when status becomes 'pre_reserved'.
--   A background job (pg_cron) periodically runs:
--     UPDATE reservations SET status='cancelled' WHERE status='pre_reserved'
--       AND expires_at < now();
--   which triggers the release_availability_on_cancellation trigger.
--
-- CHECK reservations_expires_at: enforces that expires_at is always
--   set for pre_reserved and always NULL for other statuses.
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
  -- Enforce TTL semantics: pre_reserved must always have an expiry.
  CONSTRAINT reservations_expires_at_required CHECK (
    (status = 'pre_reserved' AND expires_at IS NOT NULL) OR
    (status <> 'pre_reserved')
  )
);

COMMENT ON COLUMN public.reservations.expires_at IS
  'TTL for pre_reserved status. Set to now()+48h by application. '
  'A pg_cron job expires and cancels stale pre-reservations.';
COMMENT ON COLUMN public.reservations.conversation_id IS
  'Origin conversation. Links CRM chat history to this booking.';


-- ------------------------------------------------------------
-- availability_blocks
-- Calendar entries that prevent double-booking on a unit.
--
-- tenant_id denormalized: the most frequent query in the system is
--   "is unit X available between A and B?". Direct tenant_id enables
--   the combined (unit_id, start_date, end_date) index to also serve
--   RLS without an additional join to units → properties → tenants.
--
-- The CHECK constraint ensures that blocks with reason='reservation'
--   always reference a valid reservation row. Without this, cancelled
--   reservations could leave orphan blocks permanently locking dates.
--
-- created_by: NULL allowed. System-generated blocks (from AI tool
--   create_pre_reservation) have no human author.
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
  )
);

COMMENT ON COLUMN public.availability_blocks.tenant_id IS
  'Denormalized for O(1) RLS check and efficient (unit_id, dates) index lookups.';
COMMENT ON COLUMN public.availability_blocks.reservation_id IS
  'Required when reason=''reservation''. Enforced by CHECK constraint.';


-- ------------------------------------------------------------
-- documents
-- Business documents attached to a property or specific unit.
-- unit_id allows regulation docs specific to one cabin ("Cabaña 1 - Rules").
-- property_id and unit_id are both nullable; at least one context is
-- implied by the application but not enforced here (flexible).
-- ------------------------------------------------------------
CREATE TABLE public.documents (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID          NOT NULL REFERENCES public.tenants(id),
  property_id    UUID          REFERENCES public.properties(id),
  unit_id        UUID          REFERENCES public.units(id),
  name           TEXT          NOT NULL,
  file_url       TEXT          NOT NULL,
  document_type  document_type NOT NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
  -- No updated_at: documents are replaced (delete + insert), not edited.
);


-- ------------------------------------------------------------
-- tasks
-- Operational to-dos for the team: call client, verify payment, etc.
--
-- completed_at is managed by the trg_tasks_completed_at trigger:
--   - Set automatically to now() when status changes TO 'completed'.
--   - Cleared when status transitions AWAY from 'completed'.
--
-- The CHECK constraint mirrors this invariant at the DB level.
-- conversation_id: set when a task is auto-created by the AI
--   escalation flow (tool call create_task()).
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
-- notes
-- Internal team notes about contacts, reservations, or conversations.
-- Append-only: notes are never edited once written (no updated_at).
-- This preserves the integrity of the CRM audit trail.
-- At least one of contact_id, reservation_id, conversation_id must be set.
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
  'Internal CRM notes. Append-only — no updates permitted after creation.';


-- ------------------------------------------------------------
-- notifications
-- Outbound notifications sent to users or external contacts.
-- Redesigned from V1 to support retry logic:
--   - status tracks delivery lifecycle
--   - attempts counts retries for backoff logic
--   - error_message captures failure reason for debugging
--
-- recipient_type + recipient_id: polymorphic reference.
--   'user'    → tenant_users.id (internal notification)
--   'contact' → contacts.id     (external, e.g., WhatsApp to client)
-- ------------------------------------------------------------
CREATE TABLE public.notifications (
  id              UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID                 NOT NULL REFERENCES public.tenants(id),
  type            notification_type    NOT NULL,
  channel         notification_channel NOT NULL,
  recipient_type  TEXT                 NOT NULL CHECK (recipient_type IN ('user', 'contact')),
  recipient_id    UUID                 NOT NULL,
  -- Flexible event payload: reservation details, message excerpts, etc.
  payload         JSONB                NOT NULL DEFAULT '{}',
  status          notification_status  NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  attempts        INT                  NOT NULL DEFAULT 0,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ          NOT NULL DEFAULT now()
  -- No updated_at: lifecycle tracked via sent_at and error_message.
);

COMMENT ON COLUMN public.notifications.recipient_type IS
  '''user'' → tenant_users.id | ''contact'' → contacts.id';


-- ------------------------------------------------------------
-- whatsapp_accounts
-- WhatsApp Business API credentials per tenant (optionally per branch).
-- access_token_encrypted: encrypted at application level with
--   AES-256-GCM. Key stored in Supabase Vault. Never plain text.
-- token_expires_at: enables proactive token rotation before expiry.
-- last_verified_at: last successful API health check timestamp.
-- ------------------------------------------------------------
CREATE TABLE public.whatsapp_accounts (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID        NOT NULL REFERENCES public.tenants(id),
  branch_id               UUID        REFERENCES public.branches(id),
  phone_number            TEXT        NOT NULL,
  business_account_id     TEXT        NOT NULL,
  -- Application-level AES-256-GCM encryption. Key in Supabase Vault.
  access_token_encrypted  TEXT        NOT NULL,
  webhook_secret          TEXT        NOT NULL,
  token_expires_at        TIMESTAMPTZ,
  last_verified_at        TIMESTAMPTZ,
  active                  BOOLEAN     NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_accounts_phone_unique UNIQUE (tenant_id, phone_number)
);

COMMENT ON COLUMN public.whatsapp_accounts.access_token_encrypted IS
  'AES-256-GCM encrypted at application layer. Decryption key lives in Supabase Vault.';


-- ------------------------------------------------------------
-- ai_settings
-- AI assistant configuration per tenant.
-- One row per tenant (enforced by UNIQUE on tenant_id).
--
-- escalation_keywords: array of trigger words for immediate
--   human escalation without AI processing (saves tokens, faster).
-- max_context_messages: controls the sliding window of messages
--   sent to the AI per call (directly impacts token cost).
-- response_delay_ms: artificial delay before sending AI response
--   to simulate human typing (UX improvement).
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
  -- How many recent messages are included in the AI context window.
  -- Higher = more context, higher token cost. Max 50 to prevent runaway spend.
  max_context_messages         INT         NOT NULL DEFAULT 10
    CHECK (max_context_messages > 0 AND max_context_messages <= 50),
  active                       BOOLEAN     NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ai_settings_tenant_unique UNIQUE (tenant_id)
);


-- ------------------------------------------------------------
-- message_queue
-- Async processing queue for incoming WhatsApp webhooks.
--
-- WHY THIS TABLE EXISTS:
--   Meta requires HTTP 200 within 20 seconds or retries the webhook.
--   AI calls can take 5-15 seconds. Processing synchronously risks
--   timeout + duplicate messages. The webhook handler inserts here
--   and returns 200 immediately. A Node.js worker processes async.
--
-- Implementation: pg_notify on INSERT (trg_message_queue_notify)
--   wakes the worker process instantly instead of polling every 500ms.
--
-- Worker query:
--   SELECT ... FOR UPDATE SKIP LOCKED
--   WHERE status = 'pending' AND scheduled_at <= now()
--   ORDER BY scheduled_at ASC LIMIT 1
--
-- scheduled_at supports exponential backoff on failure:
--   worker sets scheduled_at = now() + interval for next retry.
--
-- Retention: completed/failed rows purged after 7 days via pg_cron.
-- ------------------------------------------------------------
CREATE TABLE public.message_queue (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL REFERENCES public.tenants(id),
  whatsapp_account_id  UUID         REFERENCES public.whatsapp_accounts(id),
  -- Full raw payload from Meta webhook. Stored for debugging and replay.
  raw_payload          JSONB        NOT NULL,
  status               queue_status NOT NULL DEFAULT 'pending',
  attempts             INT          NOT NULL DEFAULT 0,
  last_error           TEXT,
  -- Supports exponential backoff: set to now() + delay before retry.
  scheduled_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.message_queue IS
  'Async webhook queue. Worker uses SELECT FOR UPDATE SKIP LOCKED for concurrency safety.';


-- ------------------------------------------------------------
-- ai_usage_log
-- Token usage per AI model call. Enables per-tenant cost monitoring
-- and future billing of AI costs to tenants.
-- Uses BIGINT IDENTITY for sequential write performance (not UUID).
-- Append-only: no updated_at.
-- ------------------------------------------------------------
CREATE TABLE public.ai_usage_log (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        UUID          NOT NULL REFERENCES public.tenants(id),
  conversation_id  UUID          REFERENCES public.conversations(id),
  model            TEXT          NOT NULL,
  input_tokens     INT           NOT NULL CHECK (input_tokens >= 0),
  output_tokens    INT           NOT NULL CHECK (output_tokens >= 0),
  -- Precomputed cost in USD cents for dashboard queries (avoids repeated math).
  cost_usd_cents   INT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_usage_log IS
  'Token usage per AI call. Append-only. Used for cost monitoring and future per-tenant billing.';


-- ------------------------------------------------------------
-- audit_logs
-- Immutable record of all significant system changes.
--
-- actor_id: UUID of the user who performed the action.
--   Can be platform_users.id or tenant_users.id (see actor_type).
-- actor_type: distinguishes which profile table actor_id references.
-- impersonated_by: set when a Super Admin performed the action
--   while impersonating a tenant. Links to platform_users.id.
-- old_value / new_value: changed fields only, not full row snapshots.
--   Smaller storage footprint; easier to read in audit UIs.
--
-- BIGINT IDENTITY instead of UUID:
--   audit_logs is an append-only table with potentially millions of rows.
--   Sequential BIGINT primary keys are faster to index and compress
--   compared to random UUIDs.
--
-- NEVER UPDATE or DELETE rows in this table.
-- ------------------------------------------------------------
CREATE TABLE public.audit_logs (
  id               BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL for platform-level actions (e.g., creating a new tenant)
  tenant_id        UUID            REFERENCES public.tenants(id),
  actor_id         UUID            NOT NULL,
  actor_type       audit_actor_type NOT NULL,
  -- Set when action occurred during Super Admin impersonation session
  impersonated_by  UUID            REFERENCES public.platform_users(id),
  -- Dot-notation: 'reservation.confirmed', 'property.deleted', 'user.created'
  action           TEXT            NOT NULL,
  entity_type      TEXT            NOT NULL,
  entity_id        UUID,
  -- Only changed fields, not full row snapshots
  old_value        JSONB,
  new_value        JSONB,
  ip_address       INET,
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_logs IS
  'Immutable audit trail. Never UPDATE or DELETE. '
  'actor_id can be platform_users.id or tenant_users.id per actor_type.';


-- ============================================================
-- SECTION 4 — INDEXES
-- ============================================================
-- Each index is preceded by a comment explaining:
--   - which query it optimizes
--   - why it is necessary
-- ============================================================

-- ── platform_users ──────────────────────────────────────────

-- Login lookup and admin panel role filtering
CREATE INDEX idx_platform_users_email
  ON public.platform_users(email)
  WHERE active = true;

CREATE INDEX idx_platform_users_role
  ON public.platform_users(role)
  WHERE active = true;

-- ── tenants ─────────────────────────────────────────────────

-- Every public web request resolves the tenant from the subdomain slug.
-- This is the hottest read in the system for the public site.
CREATE UNIQUE INDEX idx_tenants_slug
  ON public.tenants(slug)
  WHERE deleted_at IS NULL;

-- Custom domain resolution (less frequent than slug, but same path)
CREATE UNIQUE INDEX idx_tenants_custom_domain
  ON public.tenants(custom_domain)
  WHERE custom_domain IS NOT NULL AND deleted_at IS NULL;

-- Super Admin / Seller dashboard: filter by status
CREATE INDEX idx_tenants_status
  ON public.tenants(status)
  WHERE deleted_at IS NULL;

-- ── seller_clients ──────────────────────────────────────────

-- Seller scope check: "which tenants can I see/manage?"
-- Used in every seller dashboard load and RLS seller policies.
CREATE INDEX idx_seller_clients_seller
  ON public.seller_clients(seller_id)
  WHERE active = true;

-- Reverse lookup: "which sellers manage tenant X?" (admin view)
CREATE INDEX idx_seller_clients_tenant
  ON public.seller_clients(tenant_id)
  WHERE active = true;

-- ── branches ────────────────────────────────────────────────

-- Branch list for a tenant (settings page, receptionist assignment)
CREATE INDEX idx_branches_tenant
  ON public.branches(tenant_id)
  WHERE active = true;

-- ── tenant_users ─────────────────────────────────────────────

-- Tenant member list (admin panel, conversation assignment dropdown)
CREATE INDEX idx_tenant_users_tenant
  ON public.tenant_users(tenant_id)
  WHERE active = true;

-- Role filter: "give me the owners of tenant X" (used in Auth Hook)
CREATE INDEX idx_tenant_users_tenant_role
  ON public.tenant_users(tenant_id, role)
  WHERE active = true;

-- Branch filter: "which receptionists belong to branch X?"
CREATE INDEX idx_tenant_users_branch
  ON public.tenant_users(branch_id)
  WHERE branch_id IS NOT NULL AND active = true;

-- ── properties ──────────────────────────────────────────────

-- Public site listing: "published properties for tenant X"
-- Most frequent read on the public website.
CREATE INDEX idx_properties_tenant_published
  ON public.properties(tenant_id, published)
  WHERE deleted_at IS NULL;

-- Branch-scoped property lists (branch dashboard view)
CREATE INDEX idx_properties_branch
  ON public.properties(branch_id)
  WHERE deleted_at IS NULL AND branch_id IS NOT NULL;

-- AI search_properties() tool call:
--   WHERE attributes @> '{"pileta": true, "cochera": true}'
-- GIN index is required for efficient JSONB containment queries.
-- Without this, every search_properties() call is a full table scan.
CREATE INDEX idx_properties_attributes
  ON public.properties USING GIN(attributes);

-- ── property_images / unit_images ───────────────────────────

-- Property detail page: ordered gallery load
CREATE INDEX idx_property_images_property
  ON public.property_images(property_id, sort_order ASC);

-- Unit detail page: ordered gallery load
CREATE INDEX idx_unit_images_unit
  ON public.unit_images(unit_id, sort_order ASC);

-- ── units ───────────────────────────────────────────────────

-- Property detail page: "active units for property X"
-- Also used by search_properties() to join units to properties
CREATE INDEX idx_units_property
  ON public.units(property_id)
  WHERE deleted_at IS NULL AND active = true;

-- RLS direct filter: tenant isolation without joining to properties
CREATE INDEX idx_units_tenant
  ON public.units(tenant_id)
  WHERE deleted_at IS NULL;

-- ── contacts ────────────────────────────────────────────────

-- CRITICAL: WhatsApp deduplication.
-- On every incoming webhook: UPSERT contacts WHERE tenant_id AND phone.
-- Must be a PARTIAL UNIQUE INDEX (not table constraint) so that
-- soft-deleted contacts with the same phone can coexist historically.
CREATE UNIQUE INDEX idx_contacts_tenant_phone
  ON public.contacts(tenant_id, phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;

-- Contact list (CRM main view, sorted by most recent)
CREATE INDEX idx_contacts_tenant_created
  ON public.contacts(tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Email deduplication (less frequent than phone but needed for manual creation)
CREATE UNIQUE INDEX idx_contacts_tenant_email
  ON public.contacts(tenant_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;

-- ── conversations ────────────────────────────────────────────

-- CRITICAL: The CRM inbox.
-- Query: conversations for tenant X with status Y, sorted by last activity.
-- This is loaded on every dashboard page open and every new message.
CREATE INDEX idx_conversations_tenant_status
  ON public.conversations(tenant_id, status, updated_at DESC);

-- Contact detail view: conversation history for a specific contact
CREATE INDEX idx_conversations_contact
  ON public.conversations(contact_id, created_at DESC);

-- "My conversations" view: assigned to me, filtered by status
CREATE INDEX idx_conversations_assigned
  ON public.conversations(assigned_user_id, status)
  WHERE assigned_user_id IS NOT NULL;

-- Branch-scoped inbox (receptionist with branch_id set)
CREATE INDEX idx_conversations_branch_status
  ON public.conversations(branch_id, status, updated_at DESC)
  WHERE branch_id IS NOT NULL;

-- ── messages ─────────────────────────────────────────────────

-- CRITICAL: highest volume table in the system.
-- Every conversation open loads messages ordered by time.
CREATE INDEX idx_messages_conversation_created
  ON public.messages(conversation_id, created_at DESC);

-- RLS check: "does this message belong to tenant T?"
-- Without this, every SELECT on messages requires a JOIN to conversations.
CREATE INDEX idx_messages_tenant_created
  ON public.messages(tenant_id, created_at DESC);

-- Deduplication: Meta retries can deliver the same webhook multiple times.
-- ON CONFLICT (whatsapp_message_id) DO NOTHING requires this unique index.
CREATE UNIQUE INDEX idx_messages_whatsapp_id
  ON public.messages(whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- ── reservations ─────────────────────────────────────────────

-- Reservations board: "all reservations for tenant X with status Y"
CREATE INDEX idx_reservations_tenant_status
  ON public.reservations(tenant_id, status, start_date)
  WHERE deleted_at IS NULL;

-- Unit calendar: "which bookings block unit X?" (availability display)
CREATE INDEX idx_reservations_unit
  ON public.reservations(unit_id, status, start_date)
  WHERE deleted_at IS NULL;

-- Contact history in CRM: "all reservations for contact X"
CREATE INDEX idx_reservations_contact
  ON public.reservations(contact_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- CRITICAL for expiry cleanup job (pg_cron runs every 15 minutes):
--   UPDATE reservations SET status='cancelled'
--   WHERE status='pre_reserved' AND expires_at < now()
-- Partial index covers only the relevant subset of rows.
CREATE INDEX idx_reservations_pre_reserved_expires
  ON public.reservations(expires_at)
  WHERE status = 'pre_reserved' AND expires_at IS NOT NULL;

-- Conversation → reservation link (CRM: "bookings from this chat")
CREATE INDEX idx_reservations_conversation
  ON public.reservations(conversation_id)
  WHERE conversation_id IS NOT NULL AND deleted_at IS NULL;

-- ── availability_blocks ──────────────────────────────────────

-- CRITICAL: the most performance-sensitive query in the system.
-- Availability overlap check:
--   SELECT EXISTS (
--     SELECT 1 FROM availability_blocks
--     WHERE unit_id = $1
--       AND start_date < $end_date
--       AND end_date   > $start_date
--   )
-- This composite index allows Postgres to use an index range scan
-- instead of a sequential scan. Required for real-time availability.
CREATE INDEX idx_availability_unit_dates
  ON public.availability_blocks(unit_id, start_date, end_date);

-- Tenant calendar view: all blocked ranges for a tenant's properties
CREATE INDEX idx_availability_tenant_dates
  ON public.availability_blocks(tenant_id, start_date);

-- Cleanup on reservation cancellation:
--   DELETE FROM availability_blocks WHERE reservation_id = $1
CREATE INDEX idx_availability_reservation
  ON public.availability_blocks(reservation_id)
  WHERE reservation_id IS NOT NULL;

-- ── tasks ────────────────────────────────────────────────────

-- "My pending tasks" (dashboard task panel)
CREATE INDEX idx_tasks_assigned_status
  ON public.tasks(tenant_id, assigned_to, status)
  WHERE assigned_to IS NOT NULL;

-- Overdue task alert (dashboard badge):
--   WHERE status NOT IN ('completed', 'cancelled') AND due_date < now()
CREATE INDEX idx_tasks_tenant_due
  ON public.tasks(tenant_id, due_date, status)
  WHERE status NOT IN ('completed', 'cancelled') AND due_date IS NOT NULL;

-- Contact detail page: tasks related to this contact
CREATE INDEX idx_tasks_contact
  ON public.tasks(contact_id)
  WHERE contact_id IS NOT NULL;

-- Reservation detail page: tasks related to this reservation
CREATE INDEX idx_tasks_reservation
  ON public.tasks(reservation_id)
  WHERE reservation_id IS NOT NULL;

-- ── notes ────────────────────────────────────────────────────

-- CRM timeline: notes for a contact, newest first
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

-- Retry worker: "find pending or failed notifications to process"
CREATE INDEX idx_notifications_pending
  ON public.notifications(status, created_at)
  WHERE status IN ('pending', 'failed');

-- Tenant notification feed
CREATE INDEX idx_notifications_tenant
  ON public.notifications(tenant_id, created_at DESC);

-- User's notification inbox (in_app channel)
CREATE INDEX idx_notifications_recipient
  ON public.notifications(recipient_id, status, created_at DESC);

-- ── whatsapp_accounts ────────────────────────────────────────

-- Webhook routing: "given incoming phone number, which tenant owns it?"
-- Called on every incoming WhatsApp webhook.
CREATE INDEX idx_whatsapp_accounts_phone
  ON public.whatsapp_accounts(phone_number)
  WHERE active = true;

CREATE INDEX idx_whatsapp_accounts_tenant
  ON public.whatsapp_accounts(tenant_id)
  WHERE active = true;

-- ── message_queue ─────────────────────────────────────────────

-- CRITICAL: worker polling query.
--   SELECT ... FOR UPDATE SKIP LOCKED
--   WHERE status IN ('pending') AND scheduled_at <= now()
--   ORDER BY scheduled_at ASC
-- This index is hit every 500ms by the worker process.
CREATE INDEX idx_message_queue_worker
  ON public.message_queue(status, scheduled_at ASC)
  WHERE status IN ('pending', 'processing');

-- Debugging: find all queue items for a tenant
CREATE INDEX idx_message_queue_tenant
  ON public.message_queue(tenant_id, created_at DESC);

-- ── ai_usage_log ─────────────────────────────────────────────

-- Cost dashboard: "How many tokens did tenant X use this month?"
CREATE INDEX idx_ai_usage_tenant_created
  ON public.ai_usage_log(tenant_id, created_at DESC);

-- ── audit_logs ───────────────────────────────────────────────

-- Tenant audit trail (owner-visible in settings)
CREATE INDEX idx_audit_logs_tenant_created
  ON public.audit_logs(tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

-- Entity history: "all changes to reservation R"
CREATE INDEX idx_audit_logs_entity
  ON public.audit_logs(entity_type, entity_id, created_at DESC);

-- Actor history: "all actions by user Y"
CREATE INDEX idx_audit_logs_actor
  ON public.audit_logs(actor_id, created_at DESC);

-- Impersonation audit: "which actions did Super Admin X take while impersonating?"
CREATE INDEX idx_audit_logs_impersonated
  ON public.audit_logs(impersonated_by, created_at DESC)
  WHERE impersonated_by IS NOT NULL;

-- ── impersonation_sessions ───────────────────────────────────

-- Admin review: "which tenants did Super Admin X access?"
CREATE INDEX idx_impersonation_admin
  ON public.impersonation_sessions(platform_user_id, started_at DESC);

-- Tenant review: "who accessed my account, and when?"
CREATE INDEX idx_impersonation_tenant
  ON public.impersonation_sessions(target_tenant_id, started_at DESC);


-- ============================================================
-- SECTION 5 — FUNCTIONS
-- ============================================================

-- ------------------------------------------------------------
-- JWT Claim Helpers
-- These functions read claims from the in-memory JWT.
-- Zero latency: no database query, no network call.
-- Used in all RLS policies to extract identity without table JOINs.
--
-- NOTE: Functions are in public schema (not auth schema).
-- Reason: Supabase does not allow user-created functions in the
-- auth schema without special elevated project configuration.
-- Policies reference them as: public.auth_user_type(), etc.
--
-- SECURITY DEFINER + SET search_path: prevents search_path injection.
-- STABLE: tells the query planner the function has no side effects
--   and can be called once per query, not once per row.
-- ------------------------------------------------------------

-- Returns 'platform_user' | 'tenant_user' | 'unknown'
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

-- Returns the tenant UUID for tenant_users; NULL for platform_users
CREATE OR REPLACE FUNCTION public.auth_tenant_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID;
$$;

-- Returns 'super_admin' | 'seller' | 'owner' | 'receptionist'
CREATE OR REPLACE FUNCTION public.auth_user_role()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.jwt() -> 'app_metadata' ->> 'role';
$$;

-- Returns the branch UUID if the receptionist is scoped to a branch; else NULL
CREATE OR REPLACE FUNCTION public.auth_branch_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'branch_id')::UUID;
$$;

-- Returns the platform_users.id of the Super Admin doing the impersonation;
-- NULL if the session is not an impersonation.
CREATE OR REPLACE FUNCTION public.auth_impersonated_by()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'impersonated_by')::UUID;
$$;

-- Convenience predicates ──────────────────────────────────────

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


-- ------------------------------------------------------------
-- custom_access_token_hook
-- Called by Supabase Auth on every token generation (login + refresh).
-- Embeds role and tenant_id into JWT app_metadata so RLS policies
-- read them without touching the database on every query.
--
-- REGISTRATION (Supabase Dashboard):
--   Authentication > Hooks > Custom Access Token Hook
--   Function: public.custom_access_token_hook
--   Requires: Supabase Pro plan.
--
-- The hook checks platform_users first, then tenant_users.
-- If found in neither (incomplete onboarding), returns unchanged claims.
-- RLS will block all data access for unclaimed users.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    UUID;
  v_platform   RECORD;
  v_tenant     RECORD;
  v_claims     JSONB;
BEGIN
  v_user_id := (event ->> 'user_id')::UUID;
  v_claims  := event -> 'claims';

  -- 1. Check if this is a platform user (Super Admin or Seller)
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

  -- 2. Check if this is a tenant user (Owner or Receptionist)
  SELECT tenant_id, role, branch_id
  INTO v_tenant
  FROM public.tenant_users
  WHERE id = v_user_id AND active = true;

  IF FOUND THEN
    v_claims := jsonb_set(
      v_claims,
      '{app_metadata}',
      jsonb_build_object(
        'user_type',  'tenant_user',
        'tenant_id',  v_tenant.tenant_id,
        'role',       v_tenant.role::TEXT,
        'branch_id',  v_tenant.branch_id
      )
    );
    RETURN jsonb_set(event, '{claims}', v_claims);
  END IF;

  -- 3. User not found in any profile table (onboarding incomplete).
  -- Return unchanged; RLS will block all data access.
  RETURN event;
END;
$$;


-- ------------------------------------------------------------
-- set_updated_at
-- Generic BEFORE UPDATE trigger function. Sets updated_at = now()
-- on any table that has the updated_at column.
-- Applied to all mutable tables via individual trigger declarations.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- ------------------------------------------------------------
-- notify_message_queue_worker
-- AFTER INSERT trigger on message_queue.
-- Sends a pg_notify signal so the worker process wakes up immediately
-- instead of waiting for its next polling cycle (default 500ms).
-- The payload is the new queue item's UUID for targeted processing.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_message_queue_worker()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  PERFORM pg_notify('message_queue_new', NEW.id::TEXT);
  RETURN NEW;
END;
$$;


-- ------------------------------------------------------------
-- release_availability_on_cancellation
-- AFTER UPDATE on reservations.
-- When a reservation is cancelled (status → 'cancelled') or
-- soft-deleted (deleted_at set), removes the linked availability_block.
-- WITHOUT this trigger: cancelled reservations permanently block dates.
-- This is the most business-critical trigger in the system.
-- ------------------------------------------------------------
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


-- ------------------------------------------------------------
-- set_task_completed_at
-- BEFORE INSERT OR UPDATE on tasks.
-- Automatically manages completed_at to maintain the CHECK constraint:
--   - status → 'completed': set completed_at = now()
--   - status ← 'completed': clear completed_at = NULL
-- Applied on INSERT too: handles the edge case where a task is
-- created already in 'completed' status (e.g., data import).
-- ------------------------------------------------------------
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


-- ------------------------------------------------------------
-- set_conversation_closed_at
-- BEFORE UPDATE on conversations.
-- Maintains closed_at when status transitions to/from 'closed'.
-- Used for SLA metrics: "average time to close a conversation".
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_conversation_closed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    NEW.closed_at = now();
  ELSIF NEW.status <> 'closed' AND OLD.status = 'closed' THEN
    NEW.closed_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;


-- ------------------------------------------------------------
-- audit_table_change
-- AFTER INSERT/UPDATE/DELETE trigger function.
-- Records a row in audit_logs for every significant change.
-- Actor identity is extracted from the JWT in-memory (no DB query).
-- Uses JSONB column access to work generically across tables.
--
-- IMPORTANT: The tenants table does NOT have a tenant_id column.
-- For the tenants trigger, v_tenant_id is set from the row's own id.
-- This is handled dynamically via to_jsonb(NEW/OLD).
--
-- Tables that have this trigger:
--   reservations, tenants, tenant_users, properties,
--   ai_settings, whatsapp_accounts
--
-- Tables WITHOUT this trigger (by design):
--   messages: too high volume; would cause audit_logs to grow faster
--   than the messages table itself.
-- ------------------------------------------------------------
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
  -- Serialize rows to JSONB for dynamic column access
  -- (necessary because the trigger is reused across tables with
  -- different structures, e.g., tenants has no tenant_id column)
  IF TG_OP <> 'DELETE' THEN v_row_new := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN v_row_old := to_jsonb(OLD); END IF;

  -- Resolve tenant_id dynamically:
  -- Most tables have tenant_id column.
  -- The tenants table uses its own id as the tenant reference.
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

  -- Actor from JWT claims
  v_actor_id     := auth.uid();
  v_impersonated := public.auth_impersonated_by();

  IF public.auth_user_type() = 'platform_user' THEN
    v_actor_type := 'platform_user';
  ELSE
    v_actor_type := 'tenant_user';
  END IF;

  v_action := TG_TABLE_NAME || '.' || LOWER(TG_OP);

  -- Skip if nothing actually changed (UPDATE with identical data)
  IF TG_OP = 'UPDATE' AND v_row_new = v_row_old THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_logs (
    tenant_id,
    actor_id,
    actor_type,
    impersonated_by,
    action,
    entity_type,
    entity_id,
    old_value,
    new_value
  ) VALUES (
    v_tenant_id,
    v_actor_id,
    v_actor_type,
    v_impersonated,
    v_action,
    TG_TABLE_NAME,
    v_entity_id,
    v_row_old,
    v_row_new
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


-- ------------------------------------------------------------
-- check_user_profile_exclusivity
-- BEFORE INSERT on platform_users and tenant_users.
-- Enforces the invariant: a user must exist in exactly ONE of
-- these two tables (never both, never neither after onboarding).
-- Prevents accidental dual-profile bugs from having silent
-- security implications on role resolution.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_user_profile_exclusivity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'platform_users' THEN
    IF EXISTS (SELECT 1 FROM public.tenant_users WHERE id = NEW.id) THEN
      RAISE EXCEPTION
        'User % already has a tenant_users profile. '
        'A user cannot exist in both platform_users and tenant_users.',
        NEW.id;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'tenant_users' THEN
    IF EXISTS (SELECT 1 FROM public.platform_users WHERE id = NEW.id) THEN
      RAISE EXCEPTION
        'User % already has a platform_users profile. '
        'A user cannot exist in both tenant_users and platform_users.',
        NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- SECTION 6 — TRIGGERS
-- ============================================================

-- ── updated_at automation ────────────────────────────────────
-- Applied to all tables with updated_at column.
-- Tables WITHOUT updated_at (immutable/append-only) are not listed:
--   property_images, unit_images, messages, notes, documents,
--   notifications, impersonation_sessions, audit_logs, ai_usage_log

CREATE TRIGGER trg_platform_users_updated_at
  BEFORE UPDATE ON public.platform_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_seller_clients_updated_at
  BEFORE UPDATE ON public.seller_clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_branches_updated_at
  BEFORE UPDATE ON public.branches
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

-- Release calendar blocks when a reservation is cancelled or soft-deleted
CREATE TRIGGER trg_release_availability_on_cancel
  AFTER UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.release_availability_on_cancellation();

-- Auto-manage completed_at on task status changes
CREATE TRIGGER trg_tasks_completed_at
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_task_completed_at();

-- Auto-manage closed_at on conversation status changes
CREATE TRIGGER trg_conversation_closed_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_conversation_closed_at();

-- Wake up the message worker immediately on new queue item
CREATE TRIGGER trg_message_queue_notify
  AFTER INSERT ON public.message_queue
  FOR EACH ROW EXECUTE FUNCTION public.notify_message_queue_worker();

-- ── audit triggers ───────────────────────────────────────────
-- Applied to high-value tables only.
-- messages excluded: volume too high; would cause audit_logs to
-- grow faster than messages itself. Messages are append-only and
-- have whatsapp_message_id for deduplication; no audit needed.

CREATE TRIGGER trg_audit_reservations
  AFTER INSERT OR UPDATE OR DELETE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

CREATE TRIGGER trg_audit_tenants
  AFTER INSERT OR UPDATE OR DELETE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

CREATE TRIGGER trg_audit_tenant_users
  AFTER INSERT OR UPDATE OR DELETE ON public.tenant_users
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

-- INSERT excluded: property creation is high-frequency (bulk onboarding).
-- UPDATE and DELETE audited: publish/unpublish and soft-delete are significant.
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
-- SECTION 7 — ROW LEVEL SECURITY + GRANTS
-- ============================================================
-- RLS is enabled on ALL tables.
-- With RLS enabled and NO policies, zero rows are accessible
-- to any authenticated/anon user. Policies are added separately
-- in 11-rls-policies.sql.
-- The service_role key (used by backend workers and Edge Functions)
-- bypasses RLS and is the only way to access data before policies exist.
-- ============================================================

ALTER TABLE public.platform_users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_clients        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_images       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unit_images           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability_blocks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_queue         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs            ENABLE ROW LEVEL SECURITY;

-- ── Grants ───────────────────────────────────────────────────
-- Grant maximum permissions to role buckets.
-- Actual access is controlled by RLS policies (defined separately).
-- Grants define the ceiling; policies define the floor.

-- authenticated: full CRUD on all tables (RLS restricts what they see)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- anon: read-only on public-facing tables only
-- (public site: properties, units, images, availability)
GRANT SELECT ON public.tenants               TO anon;
GRANT SELECT ON public.properties            TO anon;
GRANT SELECT ON public.property_images       TO anon;
GRANT SELECT ON public.units                 TO anon;
GRANT SELECT ON public.unit_images           TO anon;
GRANT SELECT ON public.availability_blocks   TO anon;

-- Grant USAGE on sequences for BIGINT IDENTITY columns
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ============================================================
-- END OF SCHEMA
-- ============================================================
--
-- NEXT STEPS
--   11-rls-policies.sql    — Full RLS policies per table and role
--   12-seed-data.sql       — Initial data (plans, default ai_settings, etc.)
--   pg_cron jobs to schedule:
--     - Expire pre_reserved reservations every 15 minutes
--     - Archive messages older than 12 months on 1st of each month
--     - Purge message_queue completed/failed rows older than 7 days
--     - Purge notifications older than 3 months
-- ============================================================

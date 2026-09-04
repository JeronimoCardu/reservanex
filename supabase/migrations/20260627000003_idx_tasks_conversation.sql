
-- =============================================================
-- Migration: 20260627000003_idx_tasks_conversation
-- =============================================================
--
-- Implements audit finding A-05.
--
-- Problem:
--   tasks.conversation_id had no index. Queries that load all tasks
--   for a conversation (e.g. the task panel in the conversation detail
--   view) required a Seq Scan over the full tasks table for the tenant.
--
-- Index chosen: (tenant_id, conversation_id) — composite, partial
-- ---------------------------------------------------------------
-- All repository queries that filter by conversation_id also filter
-- by tenant_id (listTasks always calls .eq('tenant_id', tenantId)
-- before any optional filter). A composite index is therefore strictly
-- more selective than a simple (conversation_id) index:
--
--   Simple  (conversation_id):           scans all rows with that UUID,
--                                        then filters by tenant_id.
--   Composite (tenant_id, conversation_id): scans only rows that match
--                                        both columns simultaneously.
--
-- This follows the pattern of the most recently added tasks index:
--   idx_tasks_workspace  →  (tenant_id, workspace_id)  (20260625000001)
--
-- Note: idx_tasks_contact(contact_id) and idx_tasks_reservation(reservation_id)
-- in the base schema are simple indexes predating this pattern.
-- Those are not changed here (out of scope).
--
-- Idempotency: CREATE INDEX IF NOT EXISTS — safe to re-apply.
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_tasks_conversation
  ON public.tasks (tenant_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

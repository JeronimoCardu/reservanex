-- Migration: 20260710000005_conversation_last_message_snapshot
--
-- Problem:
--   Preview data in the inbox is sourced from a nested messages join (messages[0])
--   which is fragile: missed Realtime messages INSERT events (during CHANNEL_ERROR
--   windows) leave the preview permanently stale. No recovery path exists because
--   the conversations UPDATE event carries no message data.
--
-- Solution:
--   Add five scalar snapshot columns to conversations so every conversations UPDATE
--   Realtime event carries the latest message data. The client reads directly from
--   the conversations payload — no nested join, no INSERT-event dependency.
--
--   The existing trigger function (update_conversation_on_message, created in
--   migration 20260709000001) is extended via CREATE OR REPLACE to write
--   last_message_* fields atomically alongside updated_at and
--   needs_human_attention in the same AFTER INSERT transaction.
--
-- Scope:
--   - Adds last_message_id, last_message_content, last_message_sender_type,
--     last_message_content_type, last_message_at to public.conversations
--   - Creates an index on (tenant_id, last_message_at DESC NULLS LAST) for inbox ordering
--   - Backfills last_message_* from existing messages (DISTINCT ON latest)
--   - Replaces trigger function via CREATE OR REPLACE (idempotent)
--   - Recreates trigger via DROP IF EXISTS + CREATE
--   - No RLS changes

BEGIN;

-- ── 1. Add scalar snapshot columns ────────────────────────────────────────────
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_message_id           uuid        REFERENCES public.messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_message_content      text,
  ADD COLUMN IF NOT EXISTS last_message_sender_type  text,
  ADD COLUMN IF NOT EXISTS last_message_content_type text,
  ADD COLUMN IF NOT EXISTS last_message_at           timestamptz;

-- ── 2. Index for inbox ordering ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS conversations_tenant_last_message_at_idx
  ON public.conversations (tenant_id, last_message_at DESC NULLS LAST);

-- ── 3. Backfill from existing messages ────────────────────────────────────────
-- DISTINCT ON picks the most recent message per conversation.
-- Conversations without messages are left with NULL last_message_* (correct).
UPDATE public.conversations c
SET
  last_message_id           = m.id,
  last_message_content      = m.content,
  last_message_sender_type  = m.sender_type,
  last_message_content_type = m.content_type,
  last_message_at           = m.created_at
FROM (
  SELECT DISTINCT ON (conversation_id)
    id,
    conversation_id,
    content,
    sender_type::text  AS sender_type,
    content_type::text AS content_type,
    created_at
  FROM public.messages
  ORDER BY conversation_id, created_at DESC
) m
WHERE c.id = m.conversation_id;

-- ── 4. Replace trigger function ────────────────────────────────────────────────
-- Drop the trigger first so the function can be replaced without a dependency error.
-- The function is then recreated idempotently via CREATE OR REPLACE.
-- All five last_message_* columns are written atomically with updated_at and
-- needs_human_attention in a single UPDATE, so the Realtime event emitted by
-- this trigger carries a complete preview snapshot.
DROP TRIGGER IF EXISTS trg_conversation_on_message ON public.messages;

CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET
    updated_at                = now(),
    last_message_id           = NEW.id,
    last_message_content      = NEW.content,
    last_message_sender_type  = NEW.sender_type::text,
    last_message_content_type = NEW.content_type::text,
    last_message_at           = NEW.created_at,
    needs_human_attention = CASE
      -- Customer in a manually-managed or assisted conversation
      WHEN NEW.sender_type = 'customer'
       AND ai_mode IN ('manual', 'assisted')
        THEN true
      -- Human agent replied — clear the flag
      WHEN NEW.sender_type = 'human'
        THEN false
      -- AI or customer in autonomous mode — preserve current flag
      ELSE needs_human_attention
    END
  WHERE id        = NEW.conversation_id
    AND tenant_id = NEW.tenant_id;   -- multi-tenant safety

  RETURN NEW;
END;
$$;

-- ── 5. Recreate trigger ────────────────────────────────────────────────────────
CREATE TRIGGER trg_conversation_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_on_message();

COMMIT;

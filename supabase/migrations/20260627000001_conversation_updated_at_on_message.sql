-- =============================================================
-- Migration: 20260627000001_conversation_updated_at_on_message
-- =============================================================
--
-- Implements audit finding A-01.
--
-- Problem:
--   conversations.updated_at was not updated automatically when a
--   new message was inserted. The application layer worked around
--   this with a manual UPDATE in messages.repository.ts immediately
--   after the INSERT — a two-round-trip pattern that breaks any
--   message insertions that bypass the application (webhooks,
--   direct DB access, the message_queue worker).
--
-- Solution:
--   A single AFTER INSERT trigger on public.messages that updates
--   conversations.updated_at for the parent conversation. This
--   covers every insertion path, not just the web application.
--
-- Scope:
--   - 1 trigger function created (or replaced)
--   - 1 trigger created (dropped first for idempotency)
--   - No other columns touched (no last_message, no unread_count,
--     no status, no workspace)
--   - No data modified, no indexes modified, no RLS modified
--
-- After this migration the manual UPDATE in messages.repository.ts
-- is removed (see git diff for that change).
-- =============================================================

BEGIN;

-- ============================================================
-- FUNCTION: update_conversation_updated_at_on_message()
-- ============================================================
-- Fires AFTER INSERT ON public.messages.
-- Updates only updated_at on the parent conversation.
-- SECURITY DEFINER so the trigger runs with owner privileges
-- regardless of the calling role.
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_conversation_updated_at_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET updated_at = now()
  WHERE id = NEW.conversation_id;

  RETURN NEW;
END;
$$;

-- ============================================================
-- TRIGGER: trg_conversation_updated_at_on_message
-- ============================================================
-- Drop first to make the migration idempotent.
-- Recreating with the same definition is a no-op in effect
-- but avoids "trigger already exists" errors on re-apply.
-- ============================================================

DROP TRIGGER IF EXISTS trg_conversation_updated_at_on_message
  ON public.messages;

CREATE TRIGGER trg_conversation_updated_at_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_updated_at_on_message();

COMMIT;

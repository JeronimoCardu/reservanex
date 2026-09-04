-- Migration: 20260710000006_conversation_last_message_delete_sync
--
-- Problem:
--   The trigger added in migration 20260710000005 only fires on messages INSERT.
--   When the most-recent message for a conversation is DELETEd (e.g. during testing
--   or cleanup), conversations.last_message_* keeps pointing at the deleted row:
--   the inbox preview stays permanently stale until the next INSERT.
--
-- Solution:
--   1. Create helper function refresh_conversation_last_message() that looks up
--      the current latest message and atomically updates all last_message_* columns
--      (or NULLs them if no messages remain).
--   2. Create AFTER DELETE trigger on messages that calls the helper.
--   3. Create AFTER UPDATE trigger on messages that calls the helper when any
--      of the snapshot-relevant columns change (defensive; messages are not edited
--      in the app today, but guards against direct SQL mutations during testing).
--   4. Backfill all existing conversations via the helper to fix any stale snapshots
--      that accumulated before this migration was applied.
--
-- Scope:
--   - No schema changes (all five last_message_* columns exist from migration 005)
--   - No RLS changes
--   - Does not touch worker, webhook, OpenRouter, dedupe, reservas, workspaces

BEGIN;

-- ── 1. Helper: recompute last_message_* for one conversation ──────────────────
-- SECURITY DEFINER + search_path guard so the function runs with owner privileges
-- and cannot be hijacked by a search_path injection. Called by both the DELETE
-- and UPDATE trigger functions to avoid duplicating the lookup logic.
CREATE OR REPLACE FUNCTION public.refresh_conversation_last_message(
  p_conversation_id uuid,
  p_tenant_id       uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg record;
BEGIN
  -- Find the current latest message for this conversation.
  -- Tie-break by id (UUID v4 has enough entropy that this is deterministic).
  SELECT id, content, sender_type, content_type, created_at
  INTO   msg
  FROM   public.messages
  WHERE  conversation_id = p_conversation_id
  ORDER  BY created_at DESC, id DESC
  LIMIT  1;

  IF FOUND THEN
    UPDATE public.conversations
    SET
      last_message_id           = msg.id,
      last_message_content      = msg.content,
      last_message_sender_type  = msg.sender_type::text,
      last_message_content_type = msg.content_type::text,
      last_message_at           = msg.created_at,
      updated_at                = now()
    WHERE id        = p_conversation_id
      AND tenant_id = p_tenant_id;
  ELSE
    -- No messages remain — clear the snapshot entirely.
    UPDATE public.conversations
    SET
      last_message_id           = null,
      last_message_content      = null,
      last_message_sender_type  = null,
      last_message_content_type = null,
      last_message_at           = null,
      updated_at                = now()
    WHERE id        = p_conversation_id
      AND tenant_id = p_tenant_id;
  END IF;
END;
$$;

-- ── 2. DELETE trigger function ─────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_conversation_on_message_delete ON public.messages;

CREATE OR REPLACE FUNCTION public.update_conversation_on_message_delete()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.refresh_conversation_last_message(OLD.conversation_id, OLD.tenant_id);
  RETURN OLD;
END;
$$;

-- ── 3. DELETE trigger ──────────────────────────────────────────────────────────
CREATE TRIGGER trg_conversation_on_message_delete
  AFTER DELETE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_on_message_delete();

-- ── 4. UPDATE trigger (defensive — messages not editable in the app today) ────
-- Guards against direct SQL edits to message content/sender/type/timestamp during
-- testing or migrations. Deuda técnica: remove if messages become immutable by policy.
DROP TRIGGER IF EXISTS trg_conversation_on_message_update ON public.messages;

CREATE OR REPLACE FUNCTION public.update_conversation_on_message_update()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.refresh_conversation_last_message(NEW.conversation_id, NEW.tenant_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_conversation_on_message_update
  AFTER UPDATE OF content, sender_type, content_type, created_at ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_on_message_update();

-- ── 5. Backfill: fix all stale snapshots from deleted messages ─────────────────
-- Iterates every conversation and recomputes last_message_* from the current
-- messages table. Fixes any conversations whose snapshot pointed at a deleted row.
-- Safe to re-run: the helper always produces the correct final state.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id, tenant_id FROM public.conversations
  LOOP
    PERFORM public.refresh_conversation_last_message(r.id, r.tenant_id);
  END LOOP;
END $$;

COMMIT;

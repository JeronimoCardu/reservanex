-- Migration: 20260709000001_trigger_needs_human_attention_on_message
--
-- Problem:
--   The existing trigger (20260627000001) only updated conversations.updated_at
--   on message INSERT. This caused a Realtime race condition in the inbox:
--
--     1. messages INSERT fires → client sets needs_human_attention = true optimistically.
--     2. Trigger fires → conversations UPDATE event carries needs_human_attention = false
--        (the unchanged DB value for manual conversations).
--     3. The UPDATE handler overwrites the optimistic true with false.
--     4. React 18 batches both setState calls → single render with false → badge never appears.
--
-- Solution:
--   Replace the trigger function so the conversations UPDATE event now carries the
--   correct needs_human_attention value. The DB becomes the source of truth for badge
--   state, eliminating the client-side race condition.
--
--   Badge rules (mirror the inbox UI logic):
--     customer in manual/assisted → needs_human_attention = true
--     human reply                 → needs_human_attention = false
--     ai or any other sender      → preserve current value (no change)
--     autonomous conv + customer  → preserve current value (AI handles it)
--
-- Scope:
--   - Drops the old trigger trg_conversation_updated_at_on_message
--   - Drops the old (now-orphaned) function update_conversation_updated_at_on_message
--   - Creates new function update_conversation_on_message
--   - Creates new trigger trg_conversation_on_message
--   - No data modified (trigger fires only on future INSERTs)
--   - No backfill of needs_human_attention on existing conversations

BEGIN;

-- ── 1. Drop old trigger ────────────────────────────────────────────────────────
-- The trigger from 20260627000001. Must be dropped before the function it uses.
DROP TRIGGER IF EXISTS trg_conversation_updated_at_on_message ON public.messages;

-- ── 2. Drop old function (now orphaned) ───────────────────────────────────────
-- No trigger will call this after step 1. Drop for cleanliness.
DROP FUNCTION IF EXISTS public.update_conversation_updated_at_on_message();

-- ── 3. Drop new trigger (idempotency for re-runs) ─────────────────────────────
DROP TRIGGER IF EXISTS trg_conversation_on_message ON public.messages;

-- ── 4. Create new trigger function ────────────────────────────────────────────
-- SECURITY DEFINER: runs with owner privileges so the UPDATE succeeds regardless
-- of the calling role's RLS policy on conversations.
-- The AND tenant_id = NEW.tenant_id guard ensures that even if a SECURITY DEFINER
-- caller inserts a message with a mismatched conversation_id, this trigger can
-- never touch a conversation belonging to a different tenant.
CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET
    updated_at            = now(),
    needs_human_attention = CASE
      -- Customer wrote in a manually-managed or assisted conversation
      -- → flag as requiring human attention
      WHEN NEW.sender_type = 'customer'
       AND ai_mode IN ('manual', 'assisted')
        THEN true

      -- Human agent replied
      -- → clear the attention flag (agent has taken over)
      WHEN NEW.sender_type = 'human'
        THEN false

      -- AI message, customer in autonomous mode, or any future sender type
      -- → preserve the current flag value unchanged
      ELSE needs_human_attention
    END
  WHERE id          = NEW.conversation_id
    AND tenant_id   = NEW.tenant_id;   -- multi-tenant safety

  RETURN NEW;
END;
$$;

-- ── 5. Create new trigger ──────────────────────────────────────────────────────
CREATE TRIGGER trg_conversation_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_on_message();

COMMIT;

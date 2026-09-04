-- =============================================================
-- Migration: 20260701000000_messages_dedupe_indexes
-- =============================================================
--
-- Enforces the ping-pong guarantee at the database level:
--   1 inbound WhatsApp message → at most 1 AI outbound reply.
--
-- Two partial unique indexes are added:
--
-- INDEX A — messages_one_ai_reply_per_inbound_idx
--   Prevents inserting more than one AI message that claims to be
--   a reply to the same inbound wamid.
--   Scope: sender_type = 'ai' AND metadata ? 'in_reply_to_whatsapp_message_id'
--   Existing AI messages (pre-migration) have no such key in metadata
--   → they are excluded from the index → no data conflicts on creation.
--
-- INDEX B — messages_unique_whatsapp_message_id_idx
--   Prevents duplicate customer messages for the same inbound wamid,
--   and prevents the same outbound wamid being stored on two AI rows.
--   Scope: whatsapp_message_id IS NOT NULL
--   Existing AI messages have whatsapp_message_id = NULL → excluded.
--   Existing customer messages have unique inbound wamids (Meta guarantees
--   this globally), so no conflicts on creation.
--
--   NOTE: Outbound wamids (stored on AI messages after send) are distinct
--   from inbound wamids — Meta uses separate ID spaces — so no cross-type
--   collision can occur in practice. If you suspect existing data has
--   duplicate non-null whatsapp_message_id values, run the diagnostic
--   query below before applying this migration.
--
-- Diagnostic (run before applying if in doubt):
--   SELECT tenant_id, whatsapp_message_id, count(*)
--   FROM public.messages
--   WHERE whatsapp_message_id IS NOT NULL
--   GROUP BY tenant_id, whatsapp_message_id
--   HAVING count(*) > 1;
--
-- Verification after apply:
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'messages'
--     AND indexname IN (
--       'messages_one_ai_reply_per_inbound_idx',
--       'messages_unique_whatsapp_message_id_idx'
--     );
--
-- Invariant check (run any time to audit production data):
--   SELECT m_in.whatsapp_message_id, count(*) AS ai_replies
--   FROM public.messages m_in
--   JOIN public.messages m_ai
--     ON  m_ai.tenant_id  = m_in.tenant_id
--     AND m_ai.metadata->>'in_reply_to_whatsapp_message_id' = m_in.whatsapp_message_id
--     AND m_ai.sender_type = 'ai'
--   WHERE m_in.sender_type = 'customer'
--   GROUP BY m_in.whatsapp_message_id
--   HAVING count(*) > 1;
--   -- Expected: 0 rows.
--
-- Idempotency: CREATE UNIQUE INDEX IF NOT EXISTS — safe to re-apply.
-- =============================================================

BEGIN;

-- ── INDEX A — at most one AI reply per inbound wamid ─────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS messages_one_ai_reply_per_inbound_idx
  ON public.messages (
    tenant_id,
    (metadata->>'in_reply_to_whatsapp_message_id')
  )
  WHERE sender_type = 'ai'
    AND metadata ? 'in_reply_to_whatsapp_message_id';

-- ── INDEX B — no duplicate whatsapp_message_id values (inbound or outbound) ──
CREATE UNIQUE INDEX IF NOT EXISTS messages_unique_whatsapp_message_id_idx
  ON public.messages (tenant_id, whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

COMMIT;

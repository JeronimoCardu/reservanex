-- =============================================================================
-- Migration: 20260905000001_human_handoff_window
-- =============================================================================
--
-- Fase 2B — handoff AI → HUMAN → AI without a ReservaNex inbox.
--
-- Human replies happen in WhatsApp / WhatsApp Web, which ReservaNex cannot
-- see. Two facts therefore have to live on the conversation itself:
--
--  1. human_until — until WHEN the conversation is in HUMAN mode. The
--     existing ai_mode enum ('autonomous' | 'assisted' | 'manual') already
--     says WHETHER the AI may answer, and every existing code path already
--     honours it (context/responder.ts's mode gate, escalate-to-human.ts,
--     the CRM's reactivate action). What it cannot express is an expiry, and
--     this handoff must lapse on a SLIDING 1h window measured from the
--     customer's last inbound. A boolean can't carry that; this timestamp
--     can, without inventing a second state machine.
--
--     Semantics — HUMAN is in force iff:
--         ai_mode <> 'autonomous' AND human_until IS NOT NULL AND human_until > now()
--
--     ai_mode='manual' WITH human_until IS NULL keeps its pre-Fase-2B
--     meaning: manual until a human explicitly reactivates the AI from the
--     CRM. That distinction is deliberate — an operator who took a
--     conversation over by hand must not have it silently handed back to
--     the bot an hour later. Only the AI's own handoff sets human_until.
--
--  2. ai_context_reset_at — the conversation-history boundary. While HUMAN
--     is in force the customer keeps writing, and a human answers those
--     messages from WhatsApp Web. ReservaNex stores the customer's side but
--     never sees the human's replies, so once the window lapses the AI must
--     NOT read that stretch of history: it would see half a dialogue and
--     confidently invent what "it" already said. When an inbound reactivates
--     the AI, this is stamped with that inbound's timestamp and
--     context/responder.ts only feeds the LLM messages at or after it.
--
--     Structured business memory (contact name, linked property, lead
--     context, reservations) is deliberately NOT reset — it lives in its own
--     columns/tables and stays valid. Only the chat transcript is bounded.
--
-- Both columns are nullable with no default: every existing row keeps
-- exactly its current behaviour (no human_until → no sliding expiry; no
-- ai_context_reset_at → full history, as today).
--
-- No index: both columns are only ever read for a conversation already
-- fetched by primary key on the inbound path — an index would add write
-- cost for no read benefit.

BEGIN;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS human_until         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_context_reset_at TIMESTAMPTZ;

COMMENT ON COLUMN public.conversations.human_until IS
  'Fase 2B — sliding expiry of HUMAN mode. HUMAN is in force iff '
  'ai_mode <> ''autonomous'' AND human_until > now(). Extended to '
  'now() + HUMAN_HANDOFF_TIMEOUT_MS (default 1h) on EVERY customer inbound '
  'while in force, so the window slides. NULL means "no automatic expiry": '
  'either the conversation is not in HUMAN mode, or it was set to manual by '
  'a human from the CRM, which must never auto-revert to AI.';

COMMENT ON COLUMN public.conversations.ai_context_reset_at IS
  'Fase 2B — conversation-history boundary for the AI. When set, '
  'context/responder.ts feeds the LLM only messages with created_at >= this '
  'value. Stamped with the inbound timestamp that reactivates the AI after a '
  'HUMAN window lapses, because ReservaNex never saw the human replies sent '
  'from WhatsApp Web and the AI must not pretend to know that exchange. '
  'Structured memory (contact, property, lead_context, reservations) is NOT '
  'affected — only the chat transcript.';

COMMIT;

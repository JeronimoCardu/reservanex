-- =============================================================================
-- 20260901000001_outbound_device_ack.sql
-- Physical ACK from the MacroDroid macro that it executed WhatsApp Send for a
-- dispatched messaging_outbox item — closes the gap where "dispatcher
-- dispatched" (trigger.macrodroid.com returned HTTP 200) was being read as
-- "WhatsApp Send ran on the Android", which it never meant. See the Fase 8
-- "outbound ACK" report for the full audit.
-- =============================================================================
--
-- device_ack_at means exactly:
--   "MacroDroid ran the outbound macro through to the point AFTER the
--    WhatsApp Send action, and successfully POSTed back to this endpoint."
--
-- It does NOT mean:
--   "WhatsApp confirmed delivery to the recipient." There is no delivery/read
--   receipt in this architecture — deliberately not simulating one. See
--   apps/web/src/lib/outbound-status.ts for the derived display states this
--   column feeds, and apps/web/src/app/api/webhooks/autoresponder/
--   outbound-ack/route.ts for how it's set.
--
-- Preferred over delivered_at/read_at/customer_received_at (none of which
-- this architecture can actually know) or a separate ack table (unnecessary —
-- there is exactly one ACK per outbox item, 1:1, so a nullable column on the
-- row it describes is the simplest correct structure, same pattern already
-- used for dispatched_at itself).
-- =============================================================================

ALTER TABLE public.messaging_outbox
  ADD COLUMN IF NOT EXISTS device_ack_at timestamptz NULL;

COMMENT ON COLUMN public.messaging_outbox.device_ack_at IS
  'Set once, by POST /api/webhooks/autoresponder/outbound-ack, when the MacroDroid macro physically ran past its WhatsApp Send action for this dispatch. NEVER a WhatsApp delivery/read receipt — this architecture has no access to one. NULL for anything dispatched before this column existed (see apps/web/src/lib/outbound-status.ts''s ACK_PROTOCOL_INTRODUCED_AT — those rows must never be shown as "unconfirmed", only as "dispatched", since they were never eligible for an ACK in the first place). First-write-wins: the endpoint only updates rows where this is still NULL, so a duplicate/retried ACK can never overwrite the original physical confirmation timestamp with a later one.';

-- Platform observability (Fase 8 §15) — lets /platform distinguish "last
-- dispatch attempted" (last_outbound_dispatch_at, already existed — proves
-- only that the MacroDroid trigger SERVICE accepted the request) from "last
-- execution physically confirmed by the device" (this column). Updated only
-- on a valid ACK; never described as "delivered" anywhere in the UI.
ALTER TABLE public.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS last_outbound_device_ack_at timestamptz NULL;

COMMENT ON COLUMN public.whatsapp_accounts.last_outbound_device_ack_at IS
  'Updated only by a valid POST to /api/webhooks/autoresponder/outbound-ack (first ACK per item). Distinct from last_outbound_dispatch_at (set when trigger.macrodroid.com merely ACKs the HTTP request) and from last_device_seen_at (also updated by any valid ACK, since it is real physical evidence the Android is alive — but last_device_seen_at is also updated by inbound messages/media uploads/heartbeats, so this column is the ACK-specific one). Never call this "delivered" in any UI — see messaging_outbox.device_ack_at''s comment for why.';

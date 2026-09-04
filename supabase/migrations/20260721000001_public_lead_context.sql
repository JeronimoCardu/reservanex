-- =============================================================================
-- public_lead_context
-- Adds lead_source and lead_context to conversations so the worker can
-- persist the origin and structured data from public site WhatsApp leads.
-- =============================================================================

BEGIN;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS lead_source  TEXT,
  ADD COLUMN IF NOT EXISTS lead_context JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.conversations.lead_source IS
  'Marketing origin of the lead: public_site | whatsapp_direct | manual | unknown.
   NULL means not classified yet. Populated by the worker on first message detection.';

COMMENT ON COLUMN public.conversations.lead_context IS
  'Structured context extracted from the first message (public site leads).
   Shape: { public_code, property_slug, requested_start_date, requested_end_date,
            requested_guests, requested_nights }.
   Merged on each message — existing keys are never overwritten with empty values.';

COMMIT;

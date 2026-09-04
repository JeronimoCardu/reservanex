-- Migration: 20260710000001_conversations_property_unit
--
-- Adds property_id and unit_id to conversations so an operator can associate
-- a property (and optionally a specific unit) to a WhatsApp conversation.
-- This context is later pre-filled when creating a reservation from the conversation.
--
-- Both columns are nullable — most conversations start without a property association.
-- The application UI allows the operator to set them manually after receiving a query.

BEGIN;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id),
  ADD COLUMN IF NOT EXISTS unit_id     UUID REFERENCES public.units(id);

CREATE INDEX IF NOT EXISTS idx_conversations_property_id
  ON public.conversations(property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_unit_id
  ON public.conversations(unit_id)
  WHERE unit_id IS NOT NULL;

COMMIT;

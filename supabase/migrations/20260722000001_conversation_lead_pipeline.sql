BEGIN;

-- Add lead pipeline columns to conversations.
-- lead_status tracks commercial progress of the inquiry.
-- lead_operation_type mirrors the property's operation_type for fast filtering without joins.
-- lead_status_updated_at / lead_status_updated_by record the last manual status change.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS lead_status           TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS lead_operation_type   TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS lead_status_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lead_status_updated_by UUID REFERENCES auth.users(id);

-- CHECK constraints (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_lead_status_check'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_lead_status_check
        CHECK (lead_status IN (
          'new', 'contacted', 'interested', 'visit_scheduled',
          'discarded', 'converted', 'closed'
        ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_lead_operation_type_check'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_lead_operation_type_check
        CHECK (lead_operation_type IN (
          'sale', 'long_term_rental', 'temporary_rental', 'unknown'
        ));
  END IF;
END $$;

-- Backfill lead_operation_type from linked property (highest priority)
UPDATE public.conversations c
SET lead_operation_type = p.operation_type
FROM public.properties p
WHERE c.property_id       = p.id
  AND c.lead_operation_type = 'unknown'
  AND p.operation_type IN ('sale', 'long_term_rental', 'temporary_rental')
  AND p.deleted_at IS NULL;

-- Backfill from lead_context.property_operation_type (fallback)
UPDATE public.conversations c
SET lead_operation_type = c.lead_context->>'property_operation_type'
WHERE c.lead_operation_type = 'unknown'
  AND c.lead_context->>'property_operation_type' IN ('sale', 'long_term_rental', 'temporary_rental');

COMMENT ON COLUMN public.conversations.lead_status IS
  'Commercial pipeline stage: new | contacted | interested | visit_scheduled | discarded | converted | closed.';
COMMENT ON COLUMN public.conversations.lead_operation_type IS
  'Operation type of the inquiry: sale | long_term_rental | temporary_rental | unknown.';
COMMENT ON COLUMN public.conversations.lead_status_updated_at IS
  'Timestamp of the last manual lead_status change by a CRM user.';
COMMENT ON COLUMN public.conversations.lead_status_updated_by IS
  'tenant_users.id of the user who last changed lead_status.';

COMMIT;

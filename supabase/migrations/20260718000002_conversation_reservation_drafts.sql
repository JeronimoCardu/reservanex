-- Stores the most recent availability quote per conversation.
-- When check_property_availability returns available=true, a draft is upserted here.
-- When the client confirms ("Dale"), create_pending_reservation reads this draft
-- instead of re-parsing dates from conversation history — prevents stale-date bugs.
-- The (tenant_id, conversation_id) PK ensures exactly one active draft per conversation.

CREATE TABLE IF NOT EXISTS public.conversation_reservation_drafts (
  tenant_id               uuid    NOT NULL,
  conversation_id         uuid    NOT NULL,
  property_id             uuid    NOT NULL,
  property_title          text    NOT NULL DEFAULT '',
  start_date              date    NOT NULL,
  end_date                date    NOT NULL,
  guests                  integer NOT NULL DEFAULT 1,
  price_currency          text,
  pricing_mode            text    NOT NULL DEFAULT 'consult',
  nightly_price           numeric,
  nights_count            integer,
  subtotal_amount         numeric,
  fees_amount             numeric NOT NULL DEFAULT 0,
  total_amount            numeric,
  deposit_required_amount numeric,
  pricing_breakdown       jsonb   NOT NULL DEFAULT '{}',
  status                  text    NOT NULL DEFAULT 'quoted'
                          CHECK (status IN ('quoted', 'used', 'expired', 'cancelled')),
  expires_at              timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id)
);

-- Speed up draft lookups by conversation
CREATE INDEX IF NOT EXISTS idx_conv_reservation_drafts_conv
  ON public.conversation_reservation_drafts(conversation_id);

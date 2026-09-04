-- Add price_currency to reservations.
-- The existing `currency` column is a general-purpose property currency reference.
-- `price_currency` explicitly tags the currency of the price snapshot fields:
-- nightly_price_snapshot, subtotal_amount, fees_amount, total_amount, deposit_required_amount.
-- Stored at reservation creation time so price amounts are always unambiguous.

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS price_currency text;

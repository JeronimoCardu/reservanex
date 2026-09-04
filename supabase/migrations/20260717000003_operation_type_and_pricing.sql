-- =============================================================================
-- operation_type_and_pricing
-- Agrega tipo de operación y campos de precio a properties.
-- Agrega snapshot de precio a reservations.
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + DO $$ para constraints.
-- =============================================================================

BEGIN;

-- ── properties: operation_type ─────────────────────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS operation_type TEXT NOT NULL DEFAULT 'temporary_rental';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_operation_type_check'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_operation_type_check
      CHECK (operation_type IN ('sale', 'long_term_rental', 'temporary_rental'));
  END IF;
END $$;

-- ── properties: pricing_mode ───────────────────────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'consult';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_pricing_mode_check'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_pricing_mode_check
      CHECK (pricing_mode IN ('fixed', 'consult'));
  END IF;
END $$;

-- ── properties: currency + show_price_public ──────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS currency          TEXT    NOT NULL DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS show_price_public BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_currency_format'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_currency_format
      CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
END $$;

-- ── properties: sale pricing ───────────────────────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS sale_price NUMERIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_sale_price_positive'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_sale_price_positive
      CHECK (sale_price IS NULL OR sale_price > 0);
  END IF;
END $$;

-- ── properties: long-term rental pricing ─────────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS monthly_rent_price        NUMERIC,
  ADD COLUMN IF NOT EXISTS expenses_amount           NUMERIC,
  ADD COLUMN IF NOT EXISTS long_term_deposit_amount  NUMERIC,
  ADD COLUMN IF NOT EXISTS long_term_price_notes     TEXT;

-- ── properties: temporary rental pricing ─────────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS base_price_per_night       NUMERIC,
  ADD COLUMN IF NOT EXISTS minimum_stay_nights        INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cleaning_fee               NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS temporary_deposit_amount   NUMERIC,
  ADD COLUMN IF NOT EXISTS temporary_deposit_percent  NUMERIC,
  ADD COLUMN IF NOT EXISTS temporary_price_notes      TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_minimum_stay_positive'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_minimum_stay_positive
      CHECK (minimum_stay_nights >= 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_cleaning_fee_nonneg'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_cleaning_fee_nonneg
      CHECK (cleaning_fee >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_deposit_percent_range'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_deposit_percent_range
      CHECK (temporary_deposit_percent IS NULL OR (temporary_deposit_percent > 0 AND temporary_deposit_percent <= 100));
  END IF;
END $$;

-- ── reservations: price snapshot ─────────────────────────────────────────────
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS nightly_price_snapshot  NUMERIC,
  ADD COLUMN IF NOT EXISTS nights_count            INTEGER,
  ADD COLUMN IF NOT EXISTS subtotal_amount         NUMERIC,
  ADD COLUMN IF NOT EXISTS fees_amount             NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_required_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS pricing_mode_snapshot   TEXT,
  ADD COLUMN IF NOT EXISTS pricing_breakdown       JSONB NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reservations_nights_count_positive'
      AND conrelid = 'public.reservations'::regclass
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_nights_count_positive
      CHECK (nights_count IS NULL OR nights_count > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reservations_pricing_mode_snapshot_check'
      AND conrelid = 'public.reservations'::regclass
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_pricing_mode_snapshot_check
      CHECK (pricing_mode_snapshot IS NULL OR pricing_mode_snapshot IN ('fixed', 'consult'));
  END IF;
END $$;

COMMIT;

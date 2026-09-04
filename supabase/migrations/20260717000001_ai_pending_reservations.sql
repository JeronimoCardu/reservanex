-- Migration: 20260717000001_ai_pending_reservations
--
-- Adds support for AI-created reservations:
--   1. source column on reservations — 'manual' | 'ai' (who created it)
--   2. confirmed_at / confirmed_by — tracks when a receptionist confirms a pre_reserved reservation
--   3. customer_notes — customer notes separate from internal notes
--   4. pending_reservation_hold_minutes on ai_settings — how long an AI reservation stays alive
--      before the pg_cron job cancels it (leverages existing pre_reserved expiry mechanism)

BEGIN;

-- ── 1. Add source tracking to reservations ────────────────────────────────────
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'ai')),
  ADD COLUMN IF NOT EXISTS confirmed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by   UUID REFERENCES public.tenant_users(id),
  ADD COLUMN IF NOT EXISTS customer_notes TEXT;

-- ── 2. Add reservation hold-time config to ai_settings ────────────────────────
ALTER TABLE public.ai_settings
  ADD COLUMN IF NOT EXISTS pending_reservation_hold_minutes INTEGER NOT NULL DEFAULT 60
    CHECK (pending_reservation_hold_minutes BETWEEN 15 AND 10080);

COMMIT;

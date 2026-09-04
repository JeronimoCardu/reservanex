-- Add cancellation audit fields to reservations table
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by        UUID REFERENCES tenant_users(id),
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

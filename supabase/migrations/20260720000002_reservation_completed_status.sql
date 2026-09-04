-- Add completed status to reservation_status enum and audit columns
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'completed';

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES tenant_users(id);

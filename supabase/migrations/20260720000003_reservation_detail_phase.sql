-- ══════════════════════════════════════════════════════════════
-- Reservation detail phase: payment tracking + events + notes fix
-- ══════════════════════════════════════════════════════════════

-- ── PARTE C: Payment tracking fields on reservations ────────

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS payment_status  TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT reservations_payment_status_check
    CHECK (payment_status IN ('pending','deposit_paid','paid','refunded','not_required')),
  ADD COLUMN IF NOT EXISTS amount_paid      NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_notes    TEXT,
  ADD COLUMN IF NOT EXISTS deposit_paid_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ;

-- ── PARTE D: Soft delete on notes ───────────────────────────

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ── PARTE E: Reservation events / historial ─────────────────

CREATE TABLE IF NOT EXISTS reservation_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES tenants(id)       ON DELETE CASCADE,
  reservation_id UUID        NOT NULL REFERENCES reservations(id)  ON DELETE CASCADE,
  actor_id       UUID                 REFERENCES tenant_users(id)  ON DELETE SET NULL,
  event_type     TEXT        NOT NULL,
  metadata       JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservation_events_reservation
  ON reservation_events (reservation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservation_events_tenant
  ON reservation_events (tenant_id);

ALTER TABLE reservation_events ENABLE ROW LEVEL SECURITY;

-- RLS — same pattern as notes table
CREATE POLICY "sa_imp_all_reservation_events"
  ON reservation_events FOR ALL TO authenticated
  USING  (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id())
  WITH CHECK (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());

CREATE POLICY "owner_all_reservation_events"
  ON reservation_events FOR ALL TO authenticated
  USING  (public.is_owner() AND tenant_id = public.auth_tenant_id())
  WITH CHECK (public.is_owner() AND tenant_id = public.auth_tenant_id());

CREATE POLICY "receptionist_all_reservation_events"
  ON reservation_events FOR ALL TO authenticated
  USING  (public.is_receptionist() AND tenant_id = public.auth_tenant_id())
  WITH CHECK (public.is_receptionist() AND tenant_id = public.auth_tenant_id());

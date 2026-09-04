-- =============================================================================
-- 20260723000001_platform_seller_onboarding.sql
-- Platform seller onboarding pipeline for OrderFlow
-- =============================================================================
-- Agrega a la tabla tenants:
--   - onboarding_status (pipeline de 7 estados)
--   - assigned_seller_id (seller primario asignado)
--   - columnas de timeline (approved_at, delivered_at, etc.)
--   - datos del Tenant Owner prospecto (pre-invitación)
-- Extiende tenant_status enum con 'cancelled'.
-- =============================================================================
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + DO $$ para constraints.
-- BACKFILL: todos los tenants existentes → onboarding_status = 'delivered'
-- IMPORTANTE: No aplicar por MCP. Aplicar manualmente en Dashboard Supabase
--             del proyecto veqkuriobordivdxvuhj.
-- =============================================================================

-- ── 1. Extender el enum tenant_status con 'cancelled' ────────────────────────
-- ALTER TYPE ADD VALUE no puede ejecutarse dentro de una transacción con otros
-- DDL en PostgreSQL < 14. En Supabase (PG 17) se soporta IF NOT EXISTS.
-- 'churned' se mantiene por compatibilidad retroactiva.
ALTER TYPE public.tenant_status ADD VALUE IF NOT EXISTS 'cancelled';

-- ── 2. Agregar columnas a tenants ─────────────────────────────────────────────

ALTER TABLE public.tenants
  -- Pipeline de onboarding
  ADD COLUMN IF NOT EXISTS onboarding_status       TEXT        NOT NULL DEFAULT 'pending_review',
  -- Seller asignado (referencia directa, denormalizada para display rápido)
  ADD COLUMN IF NOT EXISTS assigned_seller_id      UUID        REFERENCES public.platform_users(id),
  -- Timeline
  ADD COLUMN IF NOT EXISTS onboarding_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by             UUID        REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS ready_to_deliver_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_by            UUID        REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS rejected_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by             UUID        REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS onboarding_notes        TEXT,
  -- Datos del Tenant Owner prospecto (antes de invitar)
  ADD COLUMN IF NOT EXISTS primary_owner_name      TEXT,
  ADD COLUMN IF NOT EXISTS primary_owner_email     TEXT,
  ADD COLUMN IF NOT EXISTS primary_owner_phone     TEXT,
  ADD COLUMN IF NOT EXISTS owner_invited_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_invited_by        UUID        REFERENCES auth.users(id);

-- ── 3. CHECK constraint para onboarding_status ───────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_onboarding_status_check'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_onboarding_status_check
      CHECK (onboarding_status IN (
        'pending_review',
        'approved',
        'meta_setup',
        'testing',
        'ready_to_deliver',
        'delivered',
        'rejected'
      ));
  END IF;
END $$;

-- ── 4. Backfill de tenants existentes ─────────────────────────────────────────
-- Todos los tenants ya existentes son operativos → onboarding_status = 'delivered'
-- set approved_at = created_at como aproximación razonable del historial
UPDATE public.tenants
SET
  onboarding_status  = 'delivered',
  delivered_at       = now(),
  approved_at        = created_at
WHERE deleted_at IS NULL;

-- ── 5. Índices para consultas frecuentes ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tenants_assigned_seller
  ON public.tenants (assigned_seller_id)
  WHERE assigned_seller_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_onboarding_status
  ON public.tenants (onboarding_status)
  WHERE deleted_at IS NULL;

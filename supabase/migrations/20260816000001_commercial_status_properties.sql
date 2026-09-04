-- =============================================================================
-- 20260816000001_commercial_status_properties.sql
-- Sprint 5B — Agrega commercial_status a properties.
--
-- commercial_status controla el estado comercial de la propiedad.
-- published        controla la visibilidad en el sitio público.
--
-- Las dos columnas son independientes:
--   - published=true + commercial_status='rented'  → aparece en web con badge "Alquilada"
--   - published=false                              → oculta del web público sin importar commercial_status
--
-- El estado se actualiza manualmente por el owner.
-- En Sprint 5C/5D se sincronizará automáticamente con monthly_rental_contracts.
--
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + constraint con IF NOT EXISTS.
-- =============================================================================

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS commercial_status TEXT NOT NULL DEFAULT 'available';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname    = 'properties_commercial_status_check'
      AND conrelid   = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_commercial_status_check
      CHECK (commercial_status IN ('available', 'rented', 'paused', 'sold'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_properties_tenant_commercial_status
  ON public.properties (tenant_id, commercial_status)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN public.properties.commercial_status IS
  'Estado comercial de la propiedad. available=disponible, rented=alquilada (contrato mensual activo), paused=pausada temporalmente, sold=vendida. No reemplaza published: published controla visibilidad pública.';

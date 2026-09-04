-- =============================================================================
-- 20260805000006_v11_properties_meta_description.sql
-- v1.1 — Agrega meta_description a properties para SEO del sitio público.
--
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS
-- =============================================================================

BEGIN;

ALTER TABLE public.properties
  -- Meta description para la página pública de la propiedad (SEO).
  -- Máx 160 caracteres recomendado — la app valida esto en la UI, no en DB.
  ADD COLUMN IF NOT EXISTS meta_description TEXT;

COMMIT;

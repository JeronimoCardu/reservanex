-- =============================================================================
-- 20260816000002_document_type_monthly_rental.sql
-- Sprint 5B — Agrega valores al enum public.document_type para contratos mensuales.
--
-- Sigue el patrón de 20260805000003_v11_document_type_enum.sql:
--   - Migration separada de los CREATE TABLE que usen estos valores.
--   - IF NOT EXISTS para idempotencia.
--
-- Nuevos valores:
--   identity_document → DNI/cédula del inquilino para contratos mensuales.
--   guarantee         → documentación de garantía (fiador, seguro de caución, etc).
-- =============================================================================

ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'identity_document';
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'guarantee';

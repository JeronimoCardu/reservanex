-- =============================================================================
-- 20260828000001_tenant_onboarding_fields.sql
-- Fase 8 — captura mínima de mercado por tenant al crearlo desde /platform.
--
-- Auditoría previa (Fase 8 §1) confirmó que NINGUNA de estas columnas existía
-- — ni en `tenants`, ni en `site_config` JSONB, ni en `ai_settings`. No hay
-- código hoy que LEA country/language/currency/timezone a nivel tenant (el
-- currency por defecto de una property ya vive en `properties.currency`,
-- sin relación con esto). Se agregan como METADATA capturada en el alta,
-- pensada para uso futuro (reportes, defaults de propiedades nuevas,
-- expansión LatAm) — no se rediseña ningún flujo de fecha/moneda existente
-- para consumirlas todavía; ver el reporte de Fase 8 para el detalle
-- honesto de qué queda sin integrar.
--
-- Defaults conservadores (mercado actual real: Argentina), sin hardcodear
-- Argentina como única opción — country/currency/timezone son TEXT libres,
-- validados en la UI (apps/web/src/actions/platform.ts) contra una lista
-- corta de mercados LatAm, no restringidos por CHECK acá (mismo criterio
-- que properties.currency, que tampoco tiene CHECK).
-- =============================================================================

BEGIN;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS country  TEXT NOT NULL DEFAULT 'AR',
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires';

COMMENT ON COLUMN public.tenants.country IS
  'Fase 8 — mercado del tenant (código de país corto, ej. AR/UY/CL/MX/CO). '
  'Metadata capturada al crear el tenant; ningún flujo existente la lee '
  'todavía (no hay lógica de fecha/moneda/localización por tenant aún).';

COMMENT ON COLUMN public.tenants.language IS
  'Fase 8 — idioma del tenant. Todo el producto es actualmente Español '
  'únicamente (sin infraestructura de i18n) — este campo captura el valor '
  'para uso futuro, no cambia ningún texto de la UI hoy.';

COMMENT ON COLUMN public.tenants.currency IS
  'Fase 8 — moneda principal del tenant, independiente de '
  'properties.currency (cada property sigue teniendo su propia moneda).';

COMMENT ON COLUMN public.tenants.timezone IS
  'Fase 8 — timezone del tenant (IANA). Ningún código actual la consume '
  'todavía — metadata capturada para uso futuro.';

COMMIT;

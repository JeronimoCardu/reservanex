-- =============================================================================
-- 20260817000003_ai_settings_model_haiku.sql
-- Cambiar modelo por defecto del bot a Claude Haiku 4.5 (via OpenRouter).
-- Estandariza el formato a "anthropic/<model-id>" (formato OpenRouter).
-- =============================================================================

BEGIN;

-- Cambiar default para nuevos tenants
ALTER TABLE public.ai_settings
  ALTER COLUMN model SET DEFAULT 'anthropic/claude-haiku-4-5';

-- Migrar tenants existentes:
--   - los que tienen el valor viejo sin prefijo "anthropic/" (ej: 'claude-sonnet-4-6')
--   - los que usan cualquier variante de Sonnet
UPDATE public.ai_settings
SET    model      = 'anthropic/claude-haiku-4-5',
       updated_at = now()
WHERE  model NOT LIKE 'anthropic/%'
    OR model ILIKE '%sonnet%';

COMMIT;

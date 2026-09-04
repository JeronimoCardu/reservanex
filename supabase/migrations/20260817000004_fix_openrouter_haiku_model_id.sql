-- =============================================================================
-- 20260817000004_fix_openrouter_haiku_model_id.sql
-- Corregir ID de modelo: 'anthropic/claude-haiku-4-5' → 'anthropic/claude-haiku-4.5'
-- El punto en "4.5" es el formato correcto de OpenRouter para Claude Haiku 4.5.
-- =============================================================================

BEGIN;

-- Cambiar default para nuevos tenants
ALTER TABLE public.ai_settings
  ALTER COLUMN model SET DEFAULT 'anthropic/claude-haiku-4.5';

-- Corregir todos los valores incorrectos en tenants existentes
UPDATE public.ai_settings
SET    model      = 'anthropic/claude-haiku-4.5',
       updated_at = now()
WHERE  model IS NULL
    OR trim(model) = ''
    OR model ILIKE '%sonnet%'
    OR model = 'anthropic/claude-haiku-4-5'
    OR model = 'claude-haiku-4-5'
    OR model = 'claude-haiku-4-5-20251001'
    OR model = 'claude-haiku-4.5';

COMMIT;

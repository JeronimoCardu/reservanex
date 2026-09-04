-- =============================================================================
-- 20260817000005_fix_all_non_haiku_models.sql
-- Fuerza el modelo correcto en todos los tenants que no tengan exactamente
-- 'anthropic/claude-haiku-4.5' (el ID correcto de OpenRouter para Haiku 4.5).
-- Cubre: claude-3-5-haiku-latest, variantes con guión, sonnet, vacíos, etc.
-- =============================================================================

BEGIN;

UPDATE public.ai_settings
SET    model      = 'anthropic/claude-haiku-4.5',
       updated_at = now()
WHERE  model IS DISTINCT FROM 'anthropic/claude-haiku-4.5';

COMMIT;

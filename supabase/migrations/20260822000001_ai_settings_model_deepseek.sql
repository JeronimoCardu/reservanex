-- =============================================================================
-- 20260822000001_ai_settings_model_deepseek.sql
-- Fase 2 (reservanex-autoresponder) — reemplaza el proveedor LLM de
-- OpenRouter/Claude Haiku por la API oficial de DeepSeek.
--
-- ai_settings.model es TEXT NOT NULL, sin CHECK constraint (ver
-- 20260620000000_base_schema_v3.sql:731) — mismo patrón que las migraciones
-- históricas de Haiku (20260817000003/004/005): cambia el DEFAULT para
-- tenants futuros y migra los tenants existentes de esta copia.
--
-- No se toca la definición de columna (tipo, NOT NULL) ni se agrega/quita
-- ningún constraint. Idempotente: correrla más de una vez deja el mismo
-- estado final (el UPDATE con IS DISTINCT FROM no vuelve a tocar filas ya
-- migradas).
-- =============================================================================

BEGIN;

-- Nuevo default para tenants futuros
ALTER TABLE public.ai_settings
  ALTER COLUMN model SET DEFAULT 'deepseek-v4-flash';

-- Migrar todos los tenants existentes de esta copia al modelo DeepSeek
UPDATE public.ai_settings
SET    model      = 'deepseek-v4-flash',
       updated_at = now()
WHERE  model IS DISTINCT FROM 'deepseek-v4-flash';

COMMIT;

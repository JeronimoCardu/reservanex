-- =============================================================================
-- 20260805000002_v11_ai_settings_bot_config.sql
-- v1.1 — Configuración del bot: tono, emojis, links de propiedades.
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + DO $$ para constraint
-- =============================================================================

BEGIN;

ALTER TABLE public.ai_settings
  -- Tono cerrado (4 opciones). El valor se inyecta como instrucción al inicio del system prompt.
  ADD COLUMN IF NOT EXISTS bot_tone                TEXT    NOT NULL DEFAULT 'professional',

  -- Si el bot puede usar emojis en sus respuestas
  ADD COLUMN IF NOT EXISTS bot_use_emojis          BOOLEAN NOT NULL DEFAULT false,

  -- Si el bot puede incluir links directos a propiedades en el sitio público del tenant
  ADD COLUMN IF NOT EXISTS bot_send_property_links BOOLEAN NOT NULL DEFAULT true;

-- CHECK idempotente: solo los 4 valores de tono admitidos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_settings_bot_tone_check'
      AND conrelid = 'public.ai_settings'::regclass
  ) THEN
    ALTER TABLE public.ai_settings
      ADD CONSTRAINT ai_settings_bot_tone_check
      CHECK (bot_tone IN ('professional', 'friendly', 'premium', 'casual'));
  END IF;
END $$;

COMMIT;

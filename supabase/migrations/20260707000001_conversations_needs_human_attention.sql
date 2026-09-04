-- Columna para rastrear si una conversación necesita atención humana.
-- Se enciende cuando la IA hace handoff o llega un mensaje de cliente en modo manual.
-- Se apaga cuando un humano responde o se cierra la conversación.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS needs_human_attention         BOOLEAN    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS human_attention_requested_at  TIMESTAMPTZ;

-- Índice para el inbox (filtrar conversaciones con atención pendiente rápidamente)
CREATE INDEX IF NOT EXISTS idx_conversations_needs_attention
  ON public.conversations (tenant_id, needs_human_attention, status)
  WHERE needs_human_attention = true;

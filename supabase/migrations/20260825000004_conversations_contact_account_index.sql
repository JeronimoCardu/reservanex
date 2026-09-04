-- =============================================================================
-- 20260825000004_conversations_contact_account_index.sql
-- Fase 4.1 (corrección) — soporta el nuevo patrón de matching de
-- conversaciones: (tenant_id, contact_id, whatsapp_account_id, channel,
-- status), agregado en apps/worker/src/context/builder.ts's
-- findConversationForAccount() para que un inbound de la cuenta X nunca
-- reutilice una conversación de la cuenta Y para el mismo contacto.
--
-- No existe (verificado) ningún índice único que limite conversaciones
-- abiertas por contacto — solo índices no-únicos de performance
-- (idx_conversations_contact, idx_conversations_tenant_status). No se tocan.
-- Este índice es puramente de performance para el nuevo patrón de consulta
-- (antes solo se filtraba por contact_id; ahora también por
-- whatsapp_account_id, incluyendo el caso IS NULL para conversaciones
-- legacy).
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_conversations_contact_account_status
  ON public.conversations (contact_id, whatsapp_account_id, status);

COMMIT;

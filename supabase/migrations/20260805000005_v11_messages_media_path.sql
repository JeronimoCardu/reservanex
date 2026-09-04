-- =============================================================================
-- 20260805000005_v11_messages_media_path.sql
-- v1.1 — Agrega media_storage_path a messages para trackear archivos WA.
--
-- AUDITADO: message_content_type ya contiene text | image | document | audio | video.
-- No se requiere migración del enum.
--
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS
-- =============================================================================

BEGIN;

ALTER TABLE public.messages
  -- Path en Supabase Storage del archivo de media descargado desde WhatsApp.
  -- Formato: whatsapp-media/{tenant_id}/{conversation_id}/{message_id}.{ext}
  -- NULL para mensajes de tipo 'text' o si el worker aún no descargó el archivo.
  ADD COLUMN IF NOT EXISTS media_storage_path TEXT;

COMMIT;

-- =============================================================================
-- 20260813000001_extend_whatsapp_media_mime_types.sql
-- Sprint 3A — Ampliar allowed_mime_types de whatsapp-media para soportar
-- documentos salientes (PDF, Word, Excel, plain text, CSV).
--
-- El bucket original solo tenía imágenes, audio, video y application/pdf.
-- Los uploads de documentos fallaban porque usaban application/octet-stream
-- (no permitido) o tipos no listados (Word, Excel, txt, csv).
--
-- Esta migración preserva todos los tipos existentes y agrega los faltantes.
-- IDEMPOTENTE: usa array merge, no reemplaza si ya incluye los tipos.
-- =============================================================================

UPDATE storage.buckets
SET allowed_mime_types = ARRAY(
  SELECT DISTINCT unnest(
    COALESCE(allowed_mime_types, '{}') || ARRAY[
      -- images (outbound + inbound)
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      -- audio (inbound from WhatsApp)
      'audio/ogg',
      'audio/mpeg',
      'audio/mp4',
      'audio/aac',
      'audio/opus',
      -- video (inbound from WhatsApp)
      'video/mp4',
      'video/3gpp',
      -- documents outbound (Sprint 3A)
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'text/csv',
      'application/csv'
    ]
  )
)
WHERE id = 'whatsapp-media';

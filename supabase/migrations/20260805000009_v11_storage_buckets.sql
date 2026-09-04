-- =============================================================================
-- 20260805000009_v11_storage_buckets.sql
-- v1.1 — Buckets privados de Supabase Storage para media de WhatsApp y documentos.
--
-- whatsapp-media:
--   Archivos descargados desde Meta (imágenes, audios, documentos, videos).
--   Privado. Acceso solo vía signed URLs generadas por el backend.
--   Límite 20 MB (Meta límite efectivo para media compartida por WA).
--
-- reservation-docs:
--   Comprobantes de pago (payment_proof) y recibos PDF (receipt) de reservas.
--   Privado. Acceso solo vía signed URLs.
--   Límite 15 MB.
--
-- No se crean storage policies públicas.
-- El acceso desde el frontend será vía API routes con signed URLs (Sprint 1B+).
--
-- IDEMPOTENTE: ON CONFLICT (id) DO NOTHING
-- =============================================================================

-- ── whatsapp-media ────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-media',
  'whatsapp-media',
  false,
  20971520,  -- 20 MB en bytes
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'audio/ogg',
    'audio/mpeg',
    'audio/mp4',
    'audio/aac',
    'audio/opus',
    'video/mp4',
    'video/3gpp',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── reservation-docs ──────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'reservation-docs',
  'reservation-docs',
  false,
  15728640,  -- 15 MB en bytes
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
ON CONFLICT (id) DO NOTHING;

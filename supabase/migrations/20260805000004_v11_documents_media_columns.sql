-- =============================================================================
-- 20260805000004_v11_documents_media_columns.sql
-- v1.1 — Columnas de media/storage y metadatos en public.documents.
--
-- AUDITADO: public.documents ya tiene tenant_id (NOT NULL, FK a tenants).
-- Los valores payment_proof y receipt del enum document_type se agregaron
-- en 20260805000003 (ejecutado antes de esta migración).
--
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
--              + DO $$ para constraint
-- =============================================================================

BEGIN;

-- ── Columnas nuevas ───────────────────────────────────────────────────────────

ALTER TABLE public.documents
  -- Path en Supabase Storage (bucket + path internos separados para flexibilidad)
  ADD COLUMN IF NOT EXISTS storage_path       TEXT,
  ADD COLUMN IF NOT EXISTS storage_bucket     TEXT,

  -- Metadatos del archivo para display e integridad
  ADD COLUMN IF NOT EXISTS file_size_bytes    INTEGER,
  ADD COLUMN IF NOT EXISTS mime_type          TEXT,

  -- Origen del documento: 'manual' | 'whatsapp' | 'generated'
  --   manual    = operador lo subió manualmente desde el CRM
  --   whatsapp  = guardado desde un mensaje de WhatsApp (payment_proof)
  --   generated = PDF generado por ReservaNex (receipt)
  ADD COLUMN IF NOT EXISTS source             TEXT NOT NULL DEFAULT 'manual',

  -- Número correlativo único del recibo (solo para document_type = 'receipt')
  -- Formato: REC-YYYY-NNNN. Generado por next_receipt_number().
  ADD COLUMN IF NOT EXISTS receipt_number     TEXT,

  -- Notas internas del operador sobre el documento
  ADD COLUMN IF NOT EXISTS notes              TEXT,

  -- updated_at para tracking de cambios (la tabla base solo tiene created_at)
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── CHECK idempotente para source ────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_source_check'
      AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_source_check
      CHECK (source IN ('manual', 'whatsapp', 'generated'));
  END IF;
END $$;

-- ── Índice único: receipt_number por tenant (solo cuando está presente) ───────
-- Garantiza que dos recibos del mismo tenant no comparten número.
-- La función next_receipt_number() ya garantiza esto por diseño atómico,
-- pero el índice agrega una capa de protección de integridad en DB.

CREATE UNIQUE INDEX IF NOT EXISTS documents_receipt_number_unique
  ON public.documents (tenant_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

COMMIT;

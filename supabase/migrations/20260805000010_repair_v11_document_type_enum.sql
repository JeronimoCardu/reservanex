-- =============================================================================
-- 20260805000010_repair_v11_document_type_enum.sql
-- REPAIR: reagrega valores al enum public.document_type que no se aplicaron
-- en la migración original 20260805000003 (registrada pero no ejecutada).
--
-- REGLA CRÍTICA:
--   ALTER TYPE ADD VALUE no puede ejecutarse dentro de una transacción que
--   también USE los valores nuevos en DDL. Por eso:
--   1. Este archivo NO lleva BEGIN/COMMIT.
--   2. Los usos de payment_proof y receipt van en 20260805000011.
--
-- IDEMPOTENTE: IF NOT EXISTS
-- =============================================================================

-- Comprobante enviado por el cliente y guardado manualmente como payment_proof.
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'payment_proof';

-- PDF generado por ReservaNex con número correlativo único.
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'receipt';

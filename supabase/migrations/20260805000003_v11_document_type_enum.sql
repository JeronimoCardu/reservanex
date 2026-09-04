-- =============================================================================
-- 20260805000003_v11_document_type_enum.sql
-- v1.1 — Agrega valores al enum public.document_type para comprobantes.
--
-- IMPORTANTE:
--   ALTER TYPE ADD VALUE no puede usar los valores nuevos en la misma
--   transacción donde se agregan (PG limitation). Por eso este archivo
--   es independiente y NO contiene DDL que use payment_proof ni receipt.
--   Los usos de estos valores van en 20260805000004.
--
-- IDEMPOTENTE: IF NOT EXISTS
-- =============================================================================

-- payment_proof: imagen/PDF enviado por el cliente y guardado manualmente
--                como comprobante de pago por el equipo (owner/receptionist).
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'payment_proof';

-- receipt: PDF generado por ReservaNex con número único y correlativo.
--          Nunca lo crea el cliente; siempre lo genera el sistema.
ALTER TYPE public.document_type ADD VALUE IF NOT EXISTS 'receipt';

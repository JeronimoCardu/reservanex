-- =============================================================================
-- 20260805000001_v11_tenants_business_config.sql
-- v1.1 — Configuración ampliada de negocio, pagos y sitio público en tenants.
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS
-- =============================================================================

BEGIN;

ALTER TABLE public.tenants
  -- Redes sociales adicionales
  ADD COLUMN IF NOT EXISTS public_facebook_url     TEXT,
  ADD COLUMN IF NOT EXISTS public_tiktok_url       TEXT,

  -- Texto "Sobre nosotros" con formato enriquecido (HTML sanitizado en app)
  ADD COLUMN IF NOT EXISTS public_about_html       TEXT,

  -- Texto pre-cargado en el botón de WhatsApp del sitio público
  ADD COLUMN IF NOT EXISTS public_wa_pretext       TEXT,

  -- Horarios de atención. Estructura JSONB libre, renderizada en el sitio público.
  -- Ejemplo: { "lunes": "9:00-18:00", "sabado": "9:00-13:00", "domingo": "cerrado" }
  ADD COLUMN IF NOT EXISTS business_hours          JSONB NOT NULL DEFAULT '{}',

  -- Datos de pago del tenant (mostrados al cliente en el CRM)
  ADD COLUMN IF NOT EXISTS payment_alias           TEXT,
  ADD COLUMN IF NOT EXISTS payment_cbu             TEXT,
  ADD COLUMN IF NOT EXISTS payment_account_holder  TEXT,
  ADD COLUMN IF NOT EXISTS payment_bank            TEXT,
  ADD COLUMN IF NOT EXISTS payment_notes           TEXT,

  -- Mensaje configurable que el bot/receptionist envía al cliente cuando le solicita comprobante
  ADD COLUMN IF NOT EXISTS payment_request_message TEXT,

  -- Pie de página de los recibos PDF generados por ReservaNex
  ADD COLUMN IF NOT EXISTS receipt_footer_text     TEXT,

  -- Si el logo del tenant se muestra en los recibos PDF
  ADD COLUMN IF NOT EXISTS receipt_show_logo       BOOLEAN NOT NULL DEFAULT true;

COMMIT;

-- =============================================================================
-- 20260805000011_repair_v11_schema_foundation.sql
-- REPAIR: reaplica de forma idempotente todo el schema de Sprint 1A que no
-- se ejecutó en las migraciones 20260805000001-20260805000009.
--
-- Secciones:
--   A) public.tenants        — configuración de negocio y pagos
--   B) public.ai_settings    — configuración del bot
--   C) public.documents      — media, storage y numeración de recibos
--   D) public.messages       — path de media de WhatsApp
--   E) public.properties     — meta_description para SEO
--   F) public.user_section_seen    — badges por usuario/tenant (RLS cerrada)
--   G) public.tenant_receipt_counters + next_receipt_number()
--   H) storage.buckets       — whatsapp-media y reservation-docs
--
-- COMPLETAMENTE IDEMPOTENTE:
--   ADD COLUMN IF NOT EXISTS
--   CREATE TABLE IF NOT EXISTS
--   CREATE UNIQUE INDEX IF NOT EXISTS
--   CREATE OR REPLACE FUNCTION
--   DO $$ ... IF NOT EXISTS ... $$ para constraints y policies
--   INSERT ... ON CONFLICT DO NOTHING para buckets
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A) public.tenants — configuración ampliada
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS public_facebook_url     TEXT,
  ADD COLUMN IF NOT EXISTS public_tiktok_url       TEXT,
  ADD COLUMN IF NOT EXISTS public_about_html       TEXT,
  ADD COLUMN IF NOT EXISTS public_wa_pretext       TEXT,
  ADD COLUMN IF NOT EXISTS business_hours          JSONB    NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS payment_alias           TEXT,
  ADD COLUMN IF NOT EXISTS payment_cbu             TEXT,
  ADD COLUMN IF NOT EXISTS payment_account_holder  TEXT,
  ADD COLUMN IF NOT EXISTS payment_bank            TEXT,
  ADD COLUMN IF NOT EXISTS payment_notes           TEXT,
  ADD COLUMN IF NOT EXISTS payment_request_message TEXT,
  ADD COLUMN IF NOT EXISTS receipt_footer_text     TEXT,
  ADD COLUMN IF NOT EXISTS receipt_show_logo       BOOLEAN  NOT NULL DEFAULT true;

-- ─────────────────────────────────────────────────────────────────────────────
-- B) public.ai_settings — configuración del bot
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.ai_settings
  ADD COLUMN IF NOT EXISTS bot_tone                TEXT    NOT NULL DEFAULT 'professional',
  ADD COLUMN IF NOT EXISTS bot_use_emojis          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bot_send_property_links BOOLEAN NOT NULL DEFAULT true;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- C) public.documents — storage y numeración de recibos
-- ─────────────────────────────────────────────────────────────────────────────

-- Audit en tiempo de ejecución: verificar que tenant_id existe en documents.
-- Si la columna no está presente, la migración aborta con un mensaje claro.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'documents'
      AND column_name  = 'tenant_id'
  ) THEN
    RAISE EXCEPTION
      'ABORT: public.documents no tiene columna tenant_id. '
      'Verificar schema antes de continuar.';
  END IF;
END $$;

-- Audit: message_content_type ya contiene text|image|document|audio|video
-- (verificado en base schema 20260620000000, línea 106-112).
-- No se requiere migración del enum de messages.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS storage_path       TEXT,
  ADD COLUMN IF NOT EXISTS storage_bucket     TEXT,
  ADD COLUMN IF NOT EXISTS file_size_bytes    INTEGER,
  ADD COLUMN IF NOT EXISTS mime_type          TEXT,
  ADD COLUMN IF NOT EXISTS source             TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS receipt_number     TEXT,
  ADD COLUMN IF NOT EXISTS notes              TEXT,
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT now();

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

CREATE UNIQUE INDEX IF NOT EXISTS documents_receipt_number_unique
  ON public.documents (tenant_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- D) public.messages — path de archivo de media
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_storage_path TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- E) public.properties — meta description para SEO del sitio público
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS meta_description TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- F) public.user_section_seen — tracking de badges por usuario/tenant
--    Seguridad: RLS con policy USING (false) + REVOKE de anon/authenticated.
--    El acceso legítimo es exclusivamente vía Server Actions con createAdminClient().
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_section_seen (
  tenant_id     UUID        NOT NULL REFERENCES public.tenants(id)      ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES public.tenant_users(id) ON DELETE CASCADE,
  section       TEXT        NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, user_id, section)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_section_seen_section_check'
      AND conrelid = 'public.user_section_seen'::regclass
  ) THEN
    ALTER TABLE public.user_section_seen
      ADD CONSTRAINT user_section_seen_section_check
      CHECK (section IN ('conversations', 'reservations', 'tasks', 'payments'));
  END IF;
END $$;

ALTER TABLE public.user_section_seen ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'user_section_seen'
      AND policyname = 'user_section_seen_deny_all'
  ) THEN
    CREATE POLICY user_section_seen_deny_all
      ON public.user_section_seen
      FOR ALL
      USING (false);
  END IF;
END $$;

REVOKE ALL ON public.user_section_seen FROM anon;
REVOKE ALL ON public.user_section_seen FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- G) public.tenant_receipt_counters + next_receipt_number()
--    Contador atómico por tenant/año. No usa COUNT(*)+1 (race condition).
--    Función: SECURITY DEFINER, solo service_role puede ejecutarla.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenant_receipt_counters (
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  year        INTEGER     NOT NULL,
  counter     INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, year)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_receipt_counters_year_valid'
      AND conrelid = 'public.tenant_receipt_counters'::regclass
  ) THEN
    ALTER TABLE public.tenant_receipt_counters
      ADD CONSTRAINT tenant_receipt_counters_year_valid
      CHECK (year >= 2020 AND year <= 2099);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_receipt_counters_counter_nonneg'
      AND conrelid = 'public.tenant_receipt_counters'::regclass
  ) THEN
    ALTER TABLE public.tenant_receipt_counters
      ADD CONSTRAINT tenant_receipt_counters_counter_nonneg
      CHECK (counter >= 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.next_receipt_number(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year    integer := date_part('year', now())::integer;
  v_counter integer;
BEGIN
  INSERT INTO public.tenant_receipt_counters (tenant_id, year, counter, updated_at)
  VALUES (p_tenant_id, v_year, 1, now())
  ON CONFLICT (tenant_id, year)
  DO UPDATE SET
    counter    = tenant_receipt_counters.counter + 1,
    updated_at = now()
  RETURNING counter INTO v_counter;

  RETURN 'REC-' || v_year::text || '-' || lpad(v_counter::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_receipt_number(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_receipt_number(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.next_receipt_number(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.next_receipt_number(uuid) TO service_role;

REVOKE ALL ON public.tenant_receipt_counters FROM anon;
REVOKE ALL ON public.tenant_receipt_counters FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- H) storage.buckets — buckets privados para media WA y documentos de reserva
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'whatsapp-media',
  'whatsapp-media',
  false,
  20971520,
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/opus',
    'video/mp4', 'video/3gpp',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'reservation-docs',
  'reservation-docs',
  false,
  15728640,
  ARRAY[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp'
  ]
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

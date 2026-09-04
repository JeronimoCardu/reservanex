-- =============================================================================
-- 20260824000001_whatsapp_accounts_provider.sql
-- Fase 4 (reservanex-autoresponder) — generaliza whatsapp_accounts para
-- soportar provider='autoresponder' (Android + AutoResponder + MacroDroid)
-- además del provider='meta' existente.
--
-- DECISIÓN (documentada en el reporte de Fase 4):
--   whatsapp_accounts ya modela "una cuenta de canal de WhatsApp por tenant"
--   (tenant_id, phone_number, active, timestamps) — generalizarla en vez de
--   crear una tabla paralela evita duplicar esa lógica (message_queue,
--   sender.ts, apps/web/src/actions/messages.ts ya resuelven "la cuenta
--   activa del tenant" contra esta tabla).
--
--   Se agrega `provider` (default 'meta' → 100% backward compatible con las
--   filas existentes, que no se tocan). Las columnas específicas de Meta
--   (business_account_id, access_token_encrypted, webhook_secret) pasan a
--   ser NULLABLE porque las filas provider='autoresponder' no las usan; un
--   CHECK constraint exige los campos correctos según el provider, así que
--   ninguna fila puede quedar en un estado ambiguo (ni Meta sin sus campos,
--   ni AutoResponder sin los suyos). `phone_number` se sigue reutilizando
--   tal cual (Meta: Phone Number ID: AutoResponder: número real de WhatsApp
--   Business del Android).
--
--   RLS: la tabla ya tiene RLS habilitado SIN policies (solo service role
--   accede — ver 20260801000002_restrict_whatsapp_accounts_to_sa_only.sql).
--   Las columnas nuevas heredan esa misma protección sin cambios de RLS.
-- =============================================================================

BEGIN;

-- ── 1. Nuevas columnas ────────────────────────────────────────────────────────
ALTER TABLE public.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS device_name TEXT,
  ADD COLUMN IF NOT EXISTS inbound_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS macrodroid_webhook_url TEXT;

COMMENT ON COLUMN public.whatsapp_accounts.provider IS
  '''meta'' (Meta WhatsApp Cloud API) o ''autoresponder'' (Android dedicado + '
  'AutoResponder for WA + MacroDroid). Determina qué columnas son requeridas '
  '(ver whatsapp_accounts_provider_fields_check) y qué código de envío/recepción '
  'se usa (apps/worker/src/whatsapp/sender.ts para meta; '
  'apps/worker/src/providers/autoresponder/* para autoresponder).';
COMMENT ON COLUMN public.whatsapp_accounts.device_name IS
  'Nombre/identificador opcional del dispositivo Android (solo provider=autoresponder). '
  'Ej: "Android Palermo #1". Puramente informativo, sin uso funcional.';
COMMENT ON COLUMN public.whatsapp_accounts.inbound_token_hash IS
  'SHA-256 hex del token secreto que el Android envía en el header '
  'x-reservanex-device-token. NUNCA se guarda el token crudo. '
  'Solo provider=autoresponder.';
COMMENT ON COLUMN public.whatsapp_accounts.macrodroid_webhook_url IS
  'URL del webhook de MacroDroid — SECRETA (equivalente a un token de envío: '
  'cualquiera que la tenga puede disparar el envío de WhatsApp desde el Android). '
  'Nunca debe: exponerse al browser, loguearse, devolverse en APIs de frontend, '
  'ni incluirse en mensajes de error. Protegida únicamente por el RLS de esta '
  'tabla (sin policies = sin acceso por JWT, solo service role) — igual nivel '
  'de protección que access_token_encrypted (Meta) ya tenía. Solo provider=autoresponder.';

-- ── 2. Relajar NOT NULL en columnas exclusivas de Meta ──────────────────────────
-- Las filas existentes ya tienen estos campos poblados (son NOT NULL hoy),
-- así que relajar la constraint no requiere backfill ni pierde datos.
ALTER TABLE public.whatsapp_accounts
  ALTER COLUMN business_account_id    DROP NOT NULL,
  ALTER COLUMN access_token_encrypted DROP NOT NULL,
  ALTER COLUMN webhook_secret         DROP NOT NULL;

-- ── 3. Constraints ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_accounts_provider_check'
      AND conrelid = 'public.whatsapp_accounts'::regclass
  ) THEN
    ALTER TABLE public.whatsapp_accounts
      ADD CONSTRAINT whatsapp_accounts_provider_check
      CHECK (provider IN ('meta', 'autoresponder'));
  END IF;
END $$;

-- Cada fila debe tener los campos que su provider necesita — evita estados
-- ambiguos (ej. una fila 'meta' sin access_token, o 'autoresponder' sin token hash).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_accounts_provider_fields_check'
      AND conrelid = 'public.whatsapp_accounts'::regclass
  ) THEN
    ALTER TABLE public.whatsapp_accounts
      ADD CONSTRAINT whatsapp_accounts_provider_fields_check
      CHECK (
        (provider = 'meta'
          AND business_account_id    IS NOT NULL
          AND access_token_encrypted IS NOT NULL
          AND webhook_secret         IS NOT NULL)
        OR
        (provider = 'autoresponder'
          AND inbound_token_hash     IS NOT NULL
          AND macrodroid_webhook_url IS NOT NULL)
      );
  END IF;
END $$;

-- ── 4. Índices ───────────────────────────────────────────────────────────────
-- El índice único existente (business_account_id, phone_number) WHERE active
-- no protege filas autoresponder: business_account_id es NULL ahí, y en un
-- índice único btree estándar cada NULL se considera distinto de otro NULL
-- (no chocan entre sí). Se agrega el equivalente para autoresponder:
-- como no hay WABA ID, se acota por tenant_id.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_accounts_one_active_autoresponder_per_phone_idx
  ON public.whatsapp_accounts (tenant_id, phone_number)
  WHERE active = true AND provider = 'autoresponder';

-- El webhook de AutoResponder resuelve la cuenta ÚNICAMENTE por el hash del
-- token (ver sección 3 del reporte) — debe ser único para que la resolución
-- sea inequívoca, y el índice acelera esa búsqueda en cada request.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_accounts_inbound_token_hash_idx
  ON public.whatsapp_accounts (inbound_token_hash)
  WHERE inbound_token_hash IS NOT NULL;

COMMIT;

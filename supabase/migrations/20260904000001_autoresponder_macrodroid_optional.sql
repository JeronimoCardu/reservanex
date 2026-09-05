-- =============================================================================
-- Migration: 20260904000001_autoresponder_macrodroid_optional
-- =============================================================================
--
-- Fase 1B (AutoResponder sin MacroDroid, definitivo) — relaxes
-- whatsapp_accounts_provider_fields_check (added by
-- 20260824000001_whatsapp_accounts_provider.sql), which currently REQUIRES
-- macrodroid_webhook_url IS NOT NULL for provider='autoresponder'. That was
-- correct when MacroDroid was the only outbound transport; it no longer is
-- — the active AutoResponder flow (inbound webhook → apps/worker's internal
-- sync endpoint → replies[]) never reads macrodroid_webhook_url at all (see
-- apps/worker/src/internal-server.ts / processor.ts's deliverAIReply).
-- MacroDroid/messaging_outbox is now legacy-only, unreachable from any
-- active flow.
--
-- inbound_token_hash IS NOT NULL is KEPT — that one is still a real,
-- current requirement (the sync webhook's entire auth is the device token
-- hash lookup; an autoresponder account with no token could never
-- authenticate an inbound request).
--
-- Idempotent — DROP CONSTRAINT IF EXISTS / guarded ADD CONSTRAINT, safe to
-- run more than once. Reversible: re-adding the original constraint (with
-- macrodroid_webhook_url IS NOT NULL restored) is a valid down-migration if
-- ever needed, though nothing in this version relies on that.

BEGIN;

ALTER TABLE public.whatsapp_accounts
  DROP CONSTRAINT IF EXISTS whatsapp_accounts_provider_fields_check;

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
          AND inbound_token_hash     IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.whatsapp_accounts.macrodroid_webhook_url IS
  'URL del webhook de MacroDroid — SECRETA (equivalente a un token de envío: '
  'cualquiera que la tenga puede disparar el envío de WhatsApp desde el Android). '
  'Fase 1B: OPCIONAL — legacy-only. La única función que la lee es '
  'apps/worker/src/dispatcher.ts (messaging_outbox), que ya no participa de '
  'ningún flujo activo de AutoResponder; el envío ahora ocurre exclusivamente '
  'vía apps/worker/src/internal-server.ts (replies[] síncrono). Nunca debe: '
  'exponerse al browser, loguearse, devolverse en APIs de frontend, ni '
  'incluirse en mensajes de error. Protegida únicamente por el RLS de esta '
  'tabla (sin policies = sin acceso por JWT, solo service role).';

COMMIT;

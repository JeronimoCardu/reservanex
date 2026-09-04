-- =============================================================================
-- 20260824000002_messaging_outbox.sql
-- Fase 4 (reservanex-autoresponder) — cola durable de mensajes salientes.
--
-- Usada exclusivamente por provider='autoresponder' en esta fase: el envío
-- vía MacroDroid es HTTP + automatización de UI en un dispositivo físico
-- (no instantáneo, no debe dispararse en paralelo, no tiene delivery receipts),
-- así que no puede enviarse sincrónicamente desde responder.ts ni desde la
-- server action del CRM como se hace hoy con Meta Graph API. provider='meta'
-- NO se toca — sigue enviando sincrónicamente como hasta ahora.
--
-- `dispatched` significa únicamente "MacroDroid aceptó el trigger HTTP" — NO
-- significa delivered/read/recibido por WhatsApp. No hay delivery receipts
-- en este MVP (ver comentario en la columna status).
--
-- RLS: mismo patrón que whatsapp_accounts — habilitado, sin policies. Solo
-- el service role (worker, server actions con admin client) accede. Esta
-- tabla contiene texto de mensajes y números de teléfono de clientes.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.messaging_outbox (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL REFERENCES public.tenants(id),
  account_id         UUID        NOT NULL REFERENCES public.whatsapp_accounts(id),
  conversation_id    UUID        NOT NULL REFERENCES public.conversations(id),
  message_id         UUID        NOT NULL REFERENCES public.messages(id),
  destination_phone  TEXT        NOT NULL,
  text               TEXT        NOT NULL,
  provider           TEXT        NOT NULL,
  source             TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'pending',
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at      TIMESTAMPTZ,

  CONSTRAINT messaging_outbox_provider_check CHECK (provider IN ('meta', 'autoresponder')),
  CONSTRAINT messaging_outbox_source_check   CHECK (source   IN ('ai', 'human')),
  CONSTRAINT messaging_outbox_status_check   CHECK (status   IN ('pending', 'processing', 'dispatched', 'failed')),
  CONSTRAINT messaging_outbox_dispatched_at_consistency CHECK (
    (status = 'dispatched' AND dispatched_at IS NOT NULL) OR
    (status <> 'dispatched')
  )
);

COMMENT ON TABLE public.messaging_outbox IS
  'Cola durable de mensajes salientes para providers asincrónicos (hoy: autoresponder). '
  'El worker (apps/worker/src/dispatcher.ts) hace polling y despacha vía MacroDroid, '
  'serializando por account_id (ver dispatcher-claim.ts) — un Android físico no '
  'puede procesar dos envíos de WhatsApp Send en simultáneo.';
COMMENT ON COLUMN public.messaging_outbox.status IS
  'pending → processing → dispatched | failed. '
  '"dispatched" significa SOLO que MacroDroid aceptó el trigger HTTP (respondió OK) — '
  'NO significa delivered, read, ni siquiera que WhatsApp Business terminó de enviar '
  'el mensaje. No hay delivery receipts en este MVP; no marcar como delivered.';
COMMENT ON COLUMN public.messaging_outbox.error IS
  'Mensaje de error saneado (nunca incluye la URL del webhook de MacroDroid ni tokens).';
COMMENT ON COLUMN public.messaging_outbox.source IS
  '''ai'' = generado por el agente DeepSeek. ''human'' = enviado por un empleado desde el CRM.';

-- Cola del dispatcher: próximo pending más antiguo.
CREATE INDEX IF NOT EXISTS idx_messaging_outbox_status_created
  ON public.messaging_outbox (status, created_at);

-- Serialización por dispositivo: saber si una cuenta tiene un envío en curso
-- o reciente (cooldown) sin escanear toda la tabla.
CREATE INDEX IF NOT EXISTS idx_messaging_outbox_account_status
  ON public.messaging_outbox (account_id, status, dispatched_at);

CREATE INDEX IF NOT EXISTS idx_messaging_outbox_conversation
  ON public.messaging_outbox (conversation_id);

ALTER TABLE public.messaging_outbox ENABLE ROW LEVEL SECURITY;

COMMIT;

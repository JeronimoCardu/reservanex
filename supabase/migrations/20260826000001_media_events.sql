-- =============================================================================
-- 20260826000001_media_events.sql
-- Fase 6B — evento de media pendiente para AutoResponder + MacroDroid.
--
-- CONTEXTO: AutoResponder nunca entrega bytes de audio/imagen/documento en el
-- webhook inbound (solo un placeholder de texto — "🎤 Voice message (0:03)",
-- "📷 Photo", "📄 <filename> (<N> pages)"). Los bytes reales viven en el
-- almacenamiento local del Android y solo MacroDroid puede leerlos. Este
-- registro es el "boleto" que conecta: mensaje inbound (ya creado, con
-- placeholder) → disparo a MacroDroid → upload real de bytes → mensaje
-- actualizado con el archivo real.
--
-- No se reutiliza messaging_outbox porque ese modela "enviar ESTE texto a
-- ESTE teléfono" (rn_phone/rn_message) — un contrato de datos distinto al de
-- "andá a buscar el archivo más reciente de tal carpeta y subilo"
-- (rn_event_id/rn_media_type/rn_filename). Mismo patrón de tabla-como-cola
-- que messaging_outbox (Fase 4), sin duplicar su lógica.
--
-- Estados (nombres tal como los pidió el brief de Fase 6B):
--   pending_android  → creado; dispatched_at NULL = aún no disparado a
--                       MacroDroid, dispatched_at NOT NULL = ya disparado,
--                       esperando que el Android suba el archivo.
--   uploading        → el endpoint de upload reclamó este evento
--                       atómicamente (ver claim en la Fase 6B report) —
--                       evita procesar el mismo event_id dos veces.
--   uploaded         → bytes guardados en Storage (whatsapp-media, mismo
--                       bucket que Meta) y vinculados a messages.media_storage_path.
--   processing       → solo audio: transcripción en curso (Groq Whisper,
--                       reutilizado de apps/worker/src/whatsapp/transcribe.ts).
--   ready            → terminal, éxito. Para audio, "ready" NO implica que
--                       la transcripción haya tenido éxito — un audio bien
--                       guardado con transcripción fallida sigue siendo
--                       "ready" (el archivo existe y es reproducible); el
--                       resultado de la transcripción se guarda aparte en
--                       messages.metadata.transcription_status.
--   failed           → terminal, error (validación, storage, o MacroDroid
--                       nunca respondió). Nunca se reintenta automáticamente
--                       — mismo principio ya establecido para messaging_outbox.
--
-- RLS: mismo patrón que whatsapp_accounts/messaging_outbox — habilitado, sin
-- policies (solo service role).
-- =============================================================================

BEGIN;

CREATE TABLE public.media_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES public.tenants(id),
  account_id         UUID NOT NULL REFERENCES public.whatsapp_accounts(id),
  conversation_id    UUID NOT NULL REFERENCES public.conversations(id),
  message_id         UUID NOT NULL REFERENCES public.messages(id),
  media_type         TEXT NOT NULL CHECK (media_type IN ('audio', 'image', 'document')),
  expected_filename  TEXT,
  status             TEXT NOT NULL DEFAULT 'pending_android'
                       CHECK (status IN ('pending_android', 'uploading', 'uploaded', 'processing', 'ready', 'failed')),
  error              TEXT,
  storage_path       TEXT,
  dispatched_at      TIMESTAMPTZ,
  uploaded_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT media_events_message_id_unique UNIQUE (message_id)
);

COMMENT ON TABLE public.media_events IS
  'Evento de media AutoResponder pendiente/en curso — desde placeholder '
  'inbound hasta bytes reales subidos por MacroDroid. id = event_id que se '
  'pasa a MacroDroid como rn_event_id. Ver migración para el detalle de '
  'cada estado.';
COMMENT ON COLUMN public.media_events.expected_filename IS
  'Solo para media_type=document (nombre exacto que entrega AutoResponder). '
  'NULL para audio/image — AutoResponder no da nombre de archivo en esos '
  'casos, MacroDroid localiza "el más reciente" de la carpeta correspondiente.';
COMMENT ON COLUMN public.media_events.storage_path IS
  'Path en el bucket whatsapp-media (mismo bucket que usa Meta) una vez '
  'subido. Formato: {tenant_id}/{conversation_id}/{message_id}.{ext} — '
  'idéntico al de Meta, sin necesidad de incluir event_id (relación 1:1 '
  'evento:mensaje ya garantiza que no colisiona).';

CREATE INDEX media_events_claim_idx
  ON public.media_events (created_at ASC)
  WHERE status = 'pending_android' AND dispatched_at IS NULL;

CREATE INDEX media_events_account_status_idx
  ON public.media_events (account_id, status);

ALTER TABLE public.media_events ENABLE ROW LEVEL SECURITY;

COMMIT;

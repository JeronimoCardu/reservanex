-- =============================================================================
-- 20260827000001_device_health.sql
-- Fase 7 Parte A — telemetría mínima de salud del Android bridge
-- (AutoResponder + MacroDroid), para poder mostrar "Online/Stale/Offline" en
-- /platform sin depender de un booleano guardado (que se desincroniza) ni de
-- una tabla de historial (que no escala a ~100 dispositivos — ver Fase 7
-- report §9, "no quiero cientos de miles de filas inútiles").
--
-- Solo 4 timestamps NULLABLE en whatsapp_accounts, cada uno con una fuente
-- de verdad distinta y sin overlap:
--
--   last_device_seen_at        evidencia física DIRECTA de que el Android
--                               está vivo: un heartbeat válido, un inbound
--                               autenticado, o un upload de media aceptado.
--                               NUNCA se actualiza por un ACK del servicio
--                               trigger de MacroDroid (eso solo confirma que
--                               el RELAY aceptó la orden, no que el Android
--                               la ejecutó ni siquiera que la recibió).
--
--   last_inbound_at            último inbound AutoResponder autenticado
--                               aceptado (independiente de si el mensaje en
--                               particular se enqueueó, fue de un grupo
--                               ignorado, etc. — lo que importa es que el
--                               device se autenticó y nos habló).
--
--   last_outbound_dispatch_at  último trigger outbound (rn_action=outbound)
--                               ACEPTADO por el endpoint de MacroDroid.
--                               IMPORTANTE — esto NO significa
--                               entregado/enviado/leído, solo que el
--                               servicio trigger devolvió "OK". El label en
--                               UI debe ser honesto sobre esto (ver
--                               Fase 7 report §8).
--
--   last_media_upload_at       último upload de media (audio/imagen/
--                               documento) válido y aceptado, recibido
--                               físicamente desde MacroDroid.
--
-- Deliberadamente NO se agrega un last_device_error genérico — no hay una
-- fuente confiable de errores del lado Android para poblarlo honestamente
-- (ver Fase 7 report, backlog).
--
-- Distinto y sin relación con whatsapp_accounts.device_dispatch_reserved_until
-- (Fase 6B.2) — ese es un lease de COORDINACIÓN de trabajo entre las colas
-- outbound/media (cuánto dura, quién puede disparar next), efímero (~20s) y
-- se limpia solo. Esto es HEALTH — evidencia de vida del dispositivo en una
-- escala de minutos, para observabilidad humana en /platform. No se mezclan.
-- =============================================================================

BEGIN;

ALTER TABLE public.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS last_device_seen_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_outbound_dispatch_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_media_upload_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.whatsapp_accounts.last_device_seen_at IS
  'Fase 7 — última evidencia FÍSICA directa de que el Android está vivo: '
  'heartbeat válido, inbound autenticado, o upload de media aceptado. Nunca '
  'se actualiza por un ACK del servicio trigger de MacroDroid.';

COMMENT ON COLUMN public.whatsapp_accounts.last_inbound_at IS
  'Fase 7 — último inbound AutoResponder autenticado y aceptado por '
  'POST /api/webhooks/autoresponder.';

COMMENT ON COLUMN public.whatsapp_accounts.last_outbound_dispatch_at IS
  'Fase 7 — último trigger outbound (rn_action=outbound) ACEPTADO (HTTP OK) '
  'por el endpoint de MacroDroid. NO significa entregado/enviado/leído.';

COMMENT ON COLUMN public.whatsapp_accounts.last_media_upload_at IS
  'Fase 7 — último upload de media (audio/imagen/documento) válido y '
  'aceptado, recibido desde MacroDroid vía '
  'POST /api/webhooks/autoresponder/media.';

COMMIT;

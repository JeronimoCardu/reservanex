-- =============================================================================
-- 20260825000002_inbound_rejections.sql
-- Fase 4.1 — registro durable de mensajes entrantes rechazados antes de
-- crear contacto/conversación (p. ej. remitente de AutoResponder no es un
-- teléfono válido, como "Jeronimo Cardu" en vez de un número).
--
-- Antes de esta migración, este caso solo generaba una línea de console.log
-- (se pierde en cualquier reinicio/rotación de logs) — sin registro durable
-- para diagnóstico o soporte.
--
-- Privacidad: NO se guarda el remitente crudo ni el nombre de contacto
-- completo. Se guarda únicamente sender_length (un entero, cuántos
-- caracteres tenía el string recibido), que permite distinguir casos
-- "probablemente un nombre guardado" (p. ej. 8-30 caracteres) de casos
-- "dato corrupto/vacío" (0 caracteres) sin persistir el string en sí. No hay
-- forma de reconstruir el remitente original a partir de un largo.
--
-- RLS: mismo patrón que whatsapp_accounts / messaging_outbox — RLS
-- habilitado, cero policies, únicamente accesible vía service role.
-- =============================================================================

BEGIN;

CREATE TABLE public.inbound_rejections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES public.tenants(id),
  account_id         UUID REFERENCES public.whatsapp_accounts(id),
  provider           TEXT NOT NULL CHECK (provider IN ('meta', 'autoresponder')),
  reason             TEXT NOT NULL CHECK (reason IN ('sender_not_a_phone', 'empty_sender')),
  internal_event_id  UUID NOT NULL,
  sender_length      INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inbound_rejections IS
  'Mensajes entrantes rechazados antes de crear contacto/conversación (p. ej. '
  'remitente de AutoResponder no resoluble a un teléfono). Diagnóstico '
  'durable — nunca guarda el remitente/nombre crudo, solo su largo en '
  'caracteres (sender_length) como pista sanitizada. Solo accesible vía '
  'service role (RLS sin policies).';

COMMENT ON COLUMN public.inbound_rejections.sender_length IS
  'Cantidad de caracteres del remitente crudo recibido (NO el valor en sí). '
  'Permite distinguir "probablemente un nombre de contacto guardado" de '
  '"dato vacío/corrupto" sin persistir PII. NULL si no aplica al reason.';

COMMENT ON COLUMN public.inbound_rejections.internal_event_id IS
  'Mismo UUID interno que se hubiera usado como whatsapp_message_id si el '
  'mensaje hubiera sido aceptado — permite correlacionar con logs de '
  'aplicación (que sí pueden imprimir este id) sin exponer PII en la fila.';

CREATE INDEX inbound_rejections_tenant_created_idx
  ON public.inbound_rejections (tenant_id, created_at DESC);

ALTER TABLE public.inbound_rejections ENABLE ROW LEVEL SECURITY;

COMMIT;

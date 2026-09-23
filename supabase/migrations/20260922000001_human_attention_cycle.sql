-- ════════════════════════════════════════════════════════════════════════════
-- Atención humana V2 — el ciclo de atención, separado del modo de IA
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL PROBLEMA ──────────────────────────────────────────────────────────────
--
-- Hasta acá "¿este cliente necesita una persona?" se deducía de ai_mode y de
-- needs_human_attention. Pero ai_mode responde OTRA pregunta: "¿la IA puede
-- responder ahora?". Con AutoResponder la ventana HUMAN vence sola a los 60
-- minutos y el próximo inbound reactiva la IA (processor.ts, human_expired):
-- ai_mode vuelve a autonomous y needs_human_attention a false SIN que ninguna
-- persona haya atendido al cliente. Ese cliente desaparecía de la vista.
--
-- Además ReservaNex NO observa lo que el humano responde desde WhatsApp
-- Business, así que "el humano respondió" no se puede detectar: sólo puede
-- DECLARARSE.
--
-- ── EL MODELO ────────────────────────────────────────────────────────────────
--
-- Un ciclo de atención humana empieza cuando alguien escribe
-- human_attention_requested_at (ya existía; lo escriben los handoffs reales:
-- escalate_to_human, el límite de auto-replies, la falta de datos de pago y la
-- toma manual desde el CRM) y termina SOLO cuando una persona lo marca:
--
--   human_attention_resolved_at / human_attention_resolved_by
--
-- Un ciclo nuevo NO borra nada: escribe requested_at = now() y, como queda
-- después de resolved_at, vuelve a estar pendiente. La comparación temporal
-- distingue los ciclos; no hace falta limpiar resolved_at ni email_sent_at.
--
-- PENDIENTE ≡ status = 'open'
--           ∧ requested_at IS NOT NULL
--           ∧ (resolved_at IS NULL ∨ resolved_at < requested_at)
--
-- No depende de ai_mode. La IA puede estar autonomous y la atención seguir
-- pendiente: son dos preguntas distintas.
--
-- ── POR QUÉ UNA COLUMNA GENERADA ─────────────────────────────────────────────
--
-- PostgREST no puede comparar dos columnas de la misma fila en un filtro
-- (resolved_at < requested_at). En vez de una RPC o una vista, la condición
-- vive UNA vez acá, como columna generada STORED: la bandeja, el badge y el
-- cron filtran por human_attention_pending = true, las RLS de conversations
-- aplican igual que a cualquier columna, y el índice parcial la hace barata.
--
-- ── EL EMAIL DE LAS 2 HORAS ──────────────────────────────────────────────────
--
-- human_attention_email_sent_at es el claim de idempotencia del recordatorio:
-- un UPDATE condicional (sent_at IS NULL OR sent_at < requested_at) lo escribe,
-- y como es un solo statement, de dos ejecuciones concurrentes gana una. Un
-- ciclo nuevo (requested_at > sent_at) vuelve a ser elegible sin tocar nada.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS human_attention_resolved_at   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS human_attention_resolved_by   UUID NULL
    REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS human_attention_email_sent_at TIMESTAMPTZ NULL;

-- La definición canónica de "pendiente". Cualquier lector la consume; nadie la
-- reimplementa.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS human_attention_pending BOOLEAN
    GENERATED ALWAYS AS (
      status = 'open'::public.conversation_status
      AND human_attention_requested_at IS NOT NULL
      AND (
        human_attention_resolved_at IS NULL
        OR human_attention_resolved_at < human_attention_requested_at
      )
    ) STORED;

-- La bandeja lista pendientes de un tenant, más antiguo primero; el badge los
-- cuenta; el cron busca los que llevan más de 2 h. Todos pasan por acá.
CREATE INDEX IF NOT EXISTS idx_conversations_human_attention_pending
  ON public.conversations (tenant_id, human_attention_requested_at)
  WHERE human_attention_pending = true;

COMMENT ON COLUMN public.conversations.human_attention_requested_at IS
  'Inicio del ciclo de atención humana vigente. Lo escriben los handoffs reales '
  '(escalate_to_human, límite de auto-replies, falta de datos de pago, toma manual '
  'desde el CRM). No se borra: un ciclo nuevo lo sobreescribe con now().';

COMMENT ON COLUMN public.conversations.human_attention_resolved_at IS
  'Atención humana V2: cuándo una PERSONA marcó el ciclo como atendido. Sólo lo '
  'escribe "Marcar como atendido". La reactivación automática de la IA (human_until '
  'vencido) NO lo escribe: que la IA vuelva a responder no significa que alguien '
  'haya atendido al cliente.';

COMMENT ON COLUMN public.conversations.human_attention_resolved_by IS
  'Atención humana V2: el tenant_user que marcó el ciclo como atendido. ON DELETE '
  'SET NULL, como todas las columnas de actor del proyecto.';

COMMENT ON COLUMN public.conversations.human_attention_email_sent_at IS
  'Atención humana V2: claim del recordatorio por email del ciclo vigente. Se '
  'escribe con un UPDATE condicional (NULL o anterior a requested_at), así que de '
  'dos ejecuciones concurrentes gana exactamente una y cada ciclo recibe como '
  'máximo un email. Si el envío falla después del claim se libera (vuelve a NULL) '
  'sólo si todavía vale lo que este intento escribió.';

COMMENT ON COLUMN public.conversations.human_attention_pending IS
  'Atención humana V2: columna generada — la definición canónica de "un cliente '
  'está esperando una persona": open ∧ requested_at no nulo ∧ (resolved_at nulo ∨ '
  'resolved_at < requested_at). Independiente de ai_mode a propósito.';

COMMENT ON COLUMN public.conversations.needs_human_attention IS
  'Flag del gate de IA y del trigger de mensajes (Fase 2B y anteriores). Desde '
  'Atención humana V2 NO es la fuente de verdad de la bandeja: eso es '
  'human_attention_pending. Se conserva porque el worker y el trigger lo escriben.';

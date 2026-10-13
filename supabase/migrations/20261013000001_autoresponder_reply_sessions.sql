-- ════════════════════════════════════════════════════════════════════════════
-- MVP P0-A — estabilidad de AutoResponder
--   1. sesiones de auto-respuesta de 8 h (el contador deja de ser de por vida)
--   2. fusible de 25 respuestas automáticas por sesión, atómico
--   3. el poller genérico deja de reclamar filas de AutoResponder
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1 · SESIÓN. Antes, ai_auto_replies_count sólo volvía a 0 al marcar
-- "atendido" o al vencer la ventana HUMAN: un cliente que habló 9 veces la
-- semana pasada recibía el handoff con su primer mensaje de hoy. Ahora una
-- sesión nueva empieza cuando el inbound del cliente llega >= 8 h después del
-- último inbound que pasó por el slot de IA (ai_session_last_inbound_at). Los
-- tiempos son los persistidos: el created_at del mensaje en messages (ya
-- insertado cuando corre el worker), nunca un reloj en memoria. La columna se
-- mueve con GREATEST bajo el lock de la fila, así dos inbounds procesados
-- fuera de orden no la hacen retroceder ni parten mal la sesión.
--
-- 2 · FUSIBLE. Convención: se permiten hasta ai_auto_replies_limit (25)
-- respuestas de IA COMPLETAS por sesión; el intento siguiente dispara el
-- fusible: la conversación pasa a HUMAN (mismos campos que escribía el worker)
-- y la RPC devuelve 'fuse_tripped' a UN solo llamador, que manda el mensaje de
-- handoff. Cualquier otro concurrente ve 'not_autonomous' y queda en silencio.
-- (Antes el límite N daba N-1 respuestas y la N-ésima era el handoff.) El
-- límite es un fusible, no una regla comercial.
--
-- 3 · POLLER. AutoResponder sólo puede responder dentro del request HTTP del
-- webhook: una fila suya que reclama el poller genera una respuesta que nadie
-- puede entregar, y además le gana el claim al camino síncrono (el cliente
-- queda sin respuesta). claim_next_pollable_message_queue_item() reclama
-- atómicamente (FOR UPDATE SKIP LOCKED) la pendiente más vieja que NO sea de
-- AutoResponder. Marcas reales de una fila AutoResponder: el objeto `query`
-- de su payload (el discriminador que usa el worker, isAutoResponderPayload)
-- o el `provider` del sobre que agrega el webhook. Se excluye por cualquiera.

-- ── 1. Columna de sesión ─────────────────────────────────────────────────────

ALTER TABLE public.conversations
  ADD COLUMN ai_session_last_inbound_at timestamptz NULL;

COMMENT ON COLUMN public.conversations.ai_session_last_inbound_at IS
  'created_at del último inbound del cliente que pasó por el slot de IA. Un inbound >= 8 h posterior abre una sesión nueva (contador a 1). Lo escribe sólo claim_ai_auto_reply_slot.';

-- ── 2. Límite por defecto: 25 por sesión ─────────────────────────────────────
-- Las conversaciones existentes con el default viejo (10, nunca editable desde
-- la UI) pasan a 25. Sin mover updated_at: no es actividad de la conversación.

ALTER TABLE public.conversations ALTER COLUMN ai_auto_replies_limit SET DEFAULT 25;

ALTER TABLE public.conversations DISABLE TRIGGER trg_conversations_updated_at;
UPDATE public.conversations SET ai_auto_replies_limit = 25 WHERE ai_auto_replies_limit = 10;
ALTER TABLE public.conversations ENABLE TRIGGER trg_conversations_updated_at;

-- ── 3. Slot de auto-respuesta con sesión y fusible ───────────────────────────

DROP FUNCTION IF EXISTS public.claim_ai_auto_reply_slot(uuid, uuid);

CREATE FUNCTION public.claim_ai_auto_reply_slot(
  p_conversation_id    uuid,
  p_tenant_id          uuid,
  p_inbound_message_id uuid,
  -- human_until a escribir si dispara el fusible: lo calcula el worker según
  -- el proveedor (AutoResponder: ventana deslizante; Meta: NULL).
  p_human_until        timestamptz DEFAULT NULL
)
RETURNS TABLE(
  outcome       text,     -- 'claimed' | 'fuse_tripped' | 'not_autonomous' | 'not_found'
  new_count     integer,
  reply_limit   integer,
  session_reset boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inbound_at  timestamptz;
  v_mode        text;
  v_count       integer;
  v_limit       integer;
  v_session_at  timestamptz;
  v_new_session boolean;
BEGIN
  -- Momento real del inbound: el mensaje ya está persistido. Sin él (no
  -- debería pasar), el reloj de la base.
  SELECT m.created_at INTO v_inbound_at
  FROM public.messages m
  WHERE m.id = p_inbound_message_id
    AND m.tenant_id = p_tenant_id
    AND m.conversation_id = p_conversation_id;
  IF v_inbound_at IS NULL THEN
    v_inbound_at := now();
  END IF;

  -- La conversación es el mutex del contador.
  SELECT c.ai_mode::text, c.ai_auto_replies_count, c.ai_auto_replies_limit, c.ai_session_last_inbound_at
  INTO v_mode, v_count, v_limit, v_session_at
  FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 0, 0, false;
    RETURN;
  END IF;

  IF v_mode <> 'autonomous' THEN
    RETURN QUERY SELECT 'not_autonomous'::text, v_count, v_limit, false;
    RETURN;
  END IF;

  v_new_session := v_session_at IS NULL OR v_inbound_at - v_session_at >= interval '8 hours';

  IF NOT v_new_session AND v_count >= v_limit THEN
    -- Fusible: el intento siguiente a la última respuesta permitida.
    UPDATE public.conversations c
    SET ai_mode                      = 'manual',
        needs_human_attention        = true,
        human_attention_requested_at = now(),
        ai_handoff_reason            = 'auto_reply_limit',
        ai_handoff_at                = now(),
        human_until                  = p_human_until
    WHERE c.id = p_conversation_id AND c.tenant_id = p_tenant_id;

    RETURN QUERY SELECT 'fuse_tripped'::text, v_count, v_limit, false;
    RETURN;
  END IF;

  UPDATE public.conversations c
  SET ai_auto_replies_count      = CASE WHEN v_new_session THEN 1 ELSE c.ai_auto_replies_count + 1 END,
      ai_session_last_inbound_at = GREATEST(COALESCE(c.ai_session_last_inbound_at, v_inbound_at), v_inbound_at)
  WHERE c.id = p_conversation_id AND c.tenant_id = p_tenant_id
  RETURNING c.ai_auto_replies_count INTO v_count;

  RETURN QUERY SELECT 'claimed'::text, v_count, v_limit, v_new_session;
END;
$$;

COMMENT ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid, uuid, timestamptz) IS
  'Slot de respuesta automática por SESIÓN (8 h de inactividad del cliente abren una nueva). Hasta ai_auto_replies_limit respuestas completas; el intento siguiente dispara el fusible (pasa a HUMAN, outcome fuse_tripped, una sola vez).';

REVOKE ALL ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid, uuid, timestamptz) TO service_role;

-- ── 4. Claim del poller sin AutoResponder ────────────────────────────────────

CREATE FUNCTION public.claim_next_pollable_message_queue_item()
RETURNS SETOF public.message_queue
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  UPDATE public.message_queue q
  SET status = 'processing',
      processing_started_at = now()
  WHERE q.id = (
    SELECT p.id
    FROM public.message_queue p
    WHERE p.status = 'pending'
      AND p.attempts < 3
      AND NOT COALESCE(jsonb_typeof(p.raw_payload -> 'query') = 'object', false)
      AND NOT COALESCE(p.raw_payload ->> 'provider' = 'autoresponder', false)
    ORDER BY p.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.*;
$$;

COMMENT ON FUNCTION public.claim_next_pollable_message_queue_item() IS
  'Claim atómico del poller genérico: la pendiente más vieja (attempts < 3) que NO sea de AutoResponder. Las filas AutoResponder sólo se procesan por el camino síncrono del webhook.';

REVOKE ALL ON FUNCTION public.claim_next_pollable_message_queue_item() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_pollable_message_queue_item() TO service_role;

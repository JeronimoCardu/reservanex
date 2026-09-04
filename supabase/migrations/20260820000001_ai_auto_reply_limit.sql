-- =============================================================================
-- 20260820000001_ai_auto_reply_limit.sql
-- Sprint 5K: Límite de respuestas automáticas por ciclo de IA.
--
-- Agrega campos de contador y metadata al lifecycle del ciclo de IA
-- en conversations, y una RPC atómica para reclamar slots de respuesta.
-- =============================================================================

-- ── 1. Nuevas columnas en conversations ────────────────────────────────────────

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_auto_replies_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_auto_replies_limit integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS ai_handoff_reason     text NULL,
  ADD COLUMN IF NOT EXISTS ai_handoff_at         timestamptz NULL,
  ADD COLUMN IF NOT EXISTS ai_reactivated_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS ai_reactivated_by     uuid NULL
    REFERENCES public.tenant_users(id) ON DELETE SET NULL;

-- ── 2. CHECK constraints ────────────────────────────────────────────────────────

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_ai_auto_replies_count_check
    CHECK (ai_auto_replies_count >= 0);

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_ai_auto_replies_limit_check
    CHECK (ai_auto_replies_limit > 0);

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_ai_handoff_reason_check
    CHECK (
      ai_handoff_reason IS NULL
      OR ai_handoff_reason IN (
        'auto_reply_limit',
        'human_requested',
        'negotiation',
        'reservation_ready',
        'error',
        'manual_takeover'
      )
    );

-- ── 3. RPC atómica para reclamar slot de respuesta automática ──────────────────
--
-- Antes de cada respuesta de IA, el worker llama esta función.
-- Ella incrementa el contador SOLO si:
--   - la conversación está en modo 'autonomous'
--   - ai_auto_replies_count < ai_auto_replies_limit
-- Si dos workers compiten por el mismo slot (ej. count=9 y limit=10),
-- solo uno gana el UPDATE; el otro recibe claimed=false.
--
-- Retorna:
--   claimed     → true si se reservó un slot
--   new_count   → valor del contador DESPUÉS del incremento
--   reply_limit → límite configurado para esta conversación
--   is_last     → true cuando new_count == reply_limit (slot de derivación)

CREATE OR REPLACE FUNCTION public.claim_ai_auto_reply_slot(
  p_conversation_id uuid,
  p_tenant_id       uuid
)
RETURNS TABLE(
  claimed     boolean,
  new_count   integer,
  reply_limit integer,
  is_last     boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_limit integer;
BEGIN
  -- Intento atómico: incrementar solo si autonomous AND count < limit.
  -- El WHERE previene que dos workers concurrentes ambos ganen el mismo slot.
  UPDATE public.conversations
  SET ai_auto_replies_count = ai_auto_replies_count + 1
  WHERE id         = p_conversation_id
    AND tenant_id  = p_tenant_id
    AND ai_mode    = 'autonomous'
    AND ai_auto_replies_count < ai_auto_replies_limit
  RETURNING ai_auto_replies_count, ai_auto_replies_limit
  INTO v_count, v_limit;

  IF v_count IS NULL THEN
    -- Sin slot: ya al límite o no está en modo autonomous.
    -- Leemos el estado actual para devolver info útil al worker.
    SELECT c.ai_auto_replies_count, c.ai_auto_replies_limit
    INTO v_count, v_limit
    FROM public.conversations c
    WHERE c.id = p_conversation_id AND c.tenant_id = p_tenant_id;

    RETURN QUERY SELECT
      false,
      COALESCE(v_count, 0),
      COALESCE(v_limit, 10),
      false;
    RETURN;
  END IF;

  -- Slot reclamado. is_last=true cuando alcanzamos exactamente el límite.
  RETURN QUERY SELECT true, v_count, v_limit, (v_count = v_limit);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.claim_ai_auto_reply_slot(uuid, uuid) IS
  'Reserva un slot de respuesta automática de IA de forma atómica. '
  'Retorna claimed=false si ya se alcanzó el límite o el modo no es autonomous.';

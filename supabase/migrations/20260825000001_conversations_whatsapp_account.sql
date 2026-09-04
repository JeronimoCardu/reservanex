-- =============================================================================
-- 20260825000001_conversations_whatsapp_account.sql
-- Fase 4.1 — routing determinista de cuenta/canal por conversación.
--
-- PROBLEMA (auditado en el reporte de Fase 4.1):
--   conversations no registraba por qué whatsapp_accounts fue recibido/debe
--   responderse cada conversación. El envío manual (sendViaWhatsApp) y el
--   envío de IA resolvían "la cuenta activa del tenant" con
--   .eq('tenant_id', ...).eq('active', true).limit(1) — si un tenant tiene
--   simultáneamente una cuenta Meta activa Y una AutoResponder activa (caso
--   real durante una migración de proveedor), esa query es ambigua y puede
--   elegir la cuenta equivocada.
--
-- SOLUCIÓN:
--   conversations.whatsapp_account_id (nullable, FK) — la cuenta ORIGINANTE
--   de esa conversación. builder.ts la fija al crear la conversación y la
--   respeta (no la pisa) en mensajes siguientes; el envío (IA y manual) la
--   usa directamente en vez de adivinar. NULL = conversación legacy sin dato
--   confiable → cae al comportamiento anterior (cuenta activa del tenant)
--   como fallback seguro, no como caso de error.
--
-- Backfill: solo cuando es inequívoco (el tenant tuvo exactamente 1 fila en
-- whatsapp_accounts en el momento de esta migración). Si un tenant ya tiene
-- 2+ cuentas históricas, sus conversaciones existentes quedan NULL — mejor
-- honesto-desconocido que adivinar mal.
--
-- Trigger de consistencia cross-tenant: mismo patrón exacto que las 3
-- triggers ya existentes para workspace_id (20260627000002).
-- =============================================================================

BEGIN;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS whatsapp_account_id UUID REFERENCES public.whatsapp_accounts(id);

COMMENT ON COLUMN public.conversations.whatsapp_account_id IS
  'Cuenta/canal ORIGINANTE de esta conversación (Meta o AutoResponder). Fijada '
  'por builder.ts al crear la conversación; no se reasigna en mensajes '
  'siguientes. El envío (IA y manual) debe usar esta cuenta cuando esté '
  'presente, en vez de "la cuenta activa del tenant" (ambiguo si hay más de '
  'una activa). NULL = conversación legacy sin dato confiable — el código de '
  'envío cae de forma segura al comportamiento anterior.';

-- Backfill inequívoco únicamente. (array_agg(id))[1] is safe here — not an
-- arbitrary/unstable pick — because HAVING COUNT(*) = 1 guarantees the
-- aggregated array has exactly one element; MIN()/MAX() do not exist for
-- uuid in Postgres, so this is the standard way to project "the one value"
-- out of a single-row-per-group aggregate.
UPDATE public.conversations c
SET whatsapp_account_id = single_account.id
FROM (
  SELECT tenant_id, (array_agg(id))[1] AS id
  FROM public.whatsapp_accounts
  GROUP BY tenant_id
  HAVING COUNT(*) = 1
) AS single_account
WHERE c.tenant_id = single_account.tenant_id
  AND c.whatsapp_account_id IS NULL
  AND c.channel = 'whatsapp';

-- Consistencia cross-tenant (mismo patrón que check_*_workspace_consistency).
CREATE OR REPLACE FUNCTION public.check_conversation_whatsapp_account_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_tenant UUID;
BEGIN
  IF NEW.whatsapp_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO v_account_tenant
  FROM public.whatsapp_accounts
  WHERE id = NEW.whatsapp_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'whatsapp_account % does not exist', NEW.whatsapp_account_id;
  END IF;

  IF v_account_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'conversations.whatsapp_account_id (%) belongs to tenant (%), but conversation belongs to tenant (%). '
      'Cross-tenant account references are not allowed.',
      NEW.whatsapp_account_id, v_account_tenant, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_whatsapp_account_consistency ON public.conversations;

CREATE TRIGGER trg_conversation_whatsapp_account_consistency
  BEFORE INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.check_conversation_whatsapp_account_consistency();

COMMIT;

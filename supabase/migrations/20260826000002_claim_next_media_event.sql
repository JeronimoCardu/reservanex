-- =============================================================================
-- 20260826000002_claim_next_media_event.sql
-- Fase 6B — claim atómico de media_events, mismo mecanismo que
-- claim_next_outbox_item (Fase 4.1): pg_try_advisory_xact_lock de 64 bits
-- por account_id, decisión "¿está ocupada esta cuenta?" evaluada DENTRO de
-- la sección protegida por el lock, para que dos workers nunca disparen dos
-- extracciones de media en simultáneo para el mismo Android.
--
-- ALCANCE — LEER ANTES DE ASUMIR MÁS DE LO QUE ESTO GARANTIZA:
--   Este lock NO coordina con claim_next_outbox_item (envío de texto
--   saliente). Usan el MISMO cálculo de clave (hashtextextended(account_id,
--   0)) pero eso solo los serializa durante la ventana breve del claim en sí
--   (unos ms) — NO impide que un envío de texto y una extracción de media
--   estén "en vuelo" al mismo tiempo hacia el mismo Android, porque el
--   busy-check de cada función solo mira SU PROPIA tabla. Coordinar eso
--   completo exigiría tocar claim_next_outbox_item (ya aprobada en Fase
--   4.1, "no cambiarla sin justificar") para que también mire media_events,
--   y viceversa. NO se implementa acá porque no fue pedido explícitamente
--   y no hay certeza física de cómo MacroDroid maneja triggers concurrentes
--   de distinto tipo sobre el mismo webhook — ver Fase 6B report §15/riesgo
--   residual. Lo que SÍ está garantizado: nunca dos extracciones de media
--   simultáneas en el mismo Android (media-a-media), tal como fue pedido.
--
-- No usa cooldown post-completado (a diferencia de claim_next_outbox_item)
-- — el busy-check acá es "¿hay algo no-terminal para esta cuenta?", que ya
-- es una serialización FIFO completa sin necesitar un timer adicional. El
-- pequeño delay antes de que MacroDroid busque el archivo (para dar tiempo
-- a que WhatsApp termine de escribirlo a disco) es una configuración DENTRO
-- de la macro del Android, no algo que el servidor controle — ver Fase 6B
-- report §21.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_next_media_event()
RETURNS SETOF public.media_events
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row             public.media_events%ROWTYPE;
  v_claimed         public.media_events%ROWTYPE;
  v_tried_accounts  UUID[] := ARRAY[]::UUID[];
BEGIN
  FOR v_row IN
    SELECT * FROM public.media_events
    WHERE status = 'pending_android' AND dispatched_at IS NULL
    ORDER BY created_at ASC
    LIMIT 50
  LOOP
    IF v_row.account_id = ANY(v_tried_accounts) THEN
      CONTINUE;
    END IF;

    IF NOT pg_try_advisory_xact_lock(hashtextextended(v_row.account_id::text, 0)) THEN
      v_tried_accounts := array_append(v_tried_accounts, v_row.account_id);
      CONTINUE;
    END IF;

    -- Busy: this account already has a media event in flight (dispatched
    -- and not yet terminal, or actively being uploaded/transcribed).
    IF EXISTS (
      SELECT 1 FROM public.media_events
      WHERE account_id = v_row.account_id
        AND (
          status IN ('uploading', 'processing')
          OR (status = 'pending_android' AND dispatched_at IS NOT NULL)
        )
    ) THEN
      v_tried_accounts := array_append(v_tried_accounts, v_row.account_id);
      CONTINUE;
    END IF;

    UPDATE public.media_events
    SET dispatched_at = now(), updated_at = now()
    WHERE id = v_row.id AND status = 'pending_android' AND dispatched_at IS NULL
    RETURNING * INTO v_claimed;

    IF FOUND THEN
      RETURN NEXT v_claimed;
      RETURN;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.claim_next_media_event() IS
  'Atomically claims (marks dispatched_at) at most one pending_android media '
  'event, enforcing at most 1 in-flight media extraction per account at a '
  'time via pg_try_advisory_xact_lock. See migration header for exact scope '
  '(does not cross-coordinate with claim_next_outbox_item).';

REVOKE ALL ON FUNCTION public.claim_next_media_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_media_event() TO service_role;

COMMIT;

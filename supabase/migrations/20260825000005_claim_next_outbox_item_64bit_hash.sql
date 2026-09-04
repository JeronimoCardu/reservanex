-- =============================================================================
-- 20260825000005_claim_next_outbox_item_64bit_hash.sql
-- Fase 4.1 (corrección) — mejora menor, opcional, solicitada explícitamente
-- para revisión: claim_next_outbox_item() usaba hashtext(account_id::text),
-- que devuelve un entero de 32 bits (~4.29 mil millones de valores posibles).
--
-- Con N cuentas intentando reclamar EN EL MISMO instante, la probabilidad de
-- colisión (paradoja del cumpleaños) es N²/(2·2^32) — p.ej. ~0.01% con 1000
-- cuentas simultáneas, creciendo con la escala. IMPORTANTE: una colisión acá
-- NUNCA compromete la seguridad/atomicidad (dos cuentas que colisionan
-- simplemente se bloquean espuriamente entre sí por un instante — el
-- busy-check sigue evaluando el estado real de CADA cuenta correctamente).
-- Es, en el peor caso, un hiccup de latencia menor (se resuelve solo en el
-- siguiente poll del dispatcher, 3s después), nunca un doble-envío.
--
-- No es un requisito para esta fase (la implementación con hashtext ya era
-- correcta), pero el cambio a hashtextextended() es de una sola línea, sin
-- downside, y reduce la probabilidad de colisión a niveles despreciables
-- (2^64 valores posibles) — se aplica como mejora defensiva.
--
-- Ningún otro comportamiento de la función cambia.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_next_outbox_item(p_cooldown_seconds INT DEFAULT 8)
RETURNS SETOF public.messaging_outbox
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row             public.messaging_outbox%ROWTYPE;
  v_claimed         public.messaging_outbox%ROWTYPE;
  v_tried_accounts  UUID[] := ARRAY[]::UUID[];
BEGIN
  FOR v_row IN
    SELECT * FROM public.messaging_outbox
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 50
  LOOP
    IF v_row.account_id = ANY(v_tried_accounts) THEN
      CONTINUE;
    END IF;

    -- Non-blocking: if another concurrent call already holds this
    -- account's lock, skip to the next candidate account in this same
    -- call instead of waiting. hashtextextended (64-bit) instead of
    -- hashtext (32-bit) — see migration header for rationale.
    IF NOT pg_try_advisory_xact_lock(hashtextextended(v_row.account_id::text, 0)) THEN
      v_tried_accounts := array_append(v_tried_accounts, v_row.account_id);
      CONTINUE;
    END IF;

    -- Safe to evaluate "is this account busy" now: no other transaction
    -- can be mid-claim for this account while we hold its lock.
    IF EXISTS (
      SELECT 1 FROM public.messaging_outbox
      WHERE account_id = v_row.account_id
        AND (
          status = 'processing'
          OR (status = 'dispatched' AND dispatched_at > now() - (p_cooldown_seconds || ' seconds')::interval)
        )
    ) THEN
      v_tried_accounts := array_append(v_tried_accounts, v_row.account_id);
      CONTINUE;
    END IF;

    UPDATE public.messaging_outbox
    SET status = 'processing', updated_at = now()
    WHERE id = v_row.id AND status = 'pending'
    RETURNING * INTO v_claimed;

    IF FOUND THEN
      RETURN NEXT v_claimed;
      RETURN;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.claim_next_outbox_item(INT) IS
  'Atomically claims at most one pending messaging_outbox row, enforcing '
  'at most 1 processing/recently-dispatched item per account at a time, '
  'safe under concurrent callers via pg_try_advisory_xact_lock (64-bit '
  'hashtextextended key) per account_id. See migration 20260825000003 for '
  'the full rationale and 20260825000005 for the 32→64-bit hash change.';

REVOKE ALL ON FUNCTION public.claim_next_outbox_item(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_outbox_item(INT) TO service_role;

COMMIT;

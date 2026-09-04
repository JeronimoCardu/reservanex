-- =============================================================================
-- 20260825000003_claim_next_outbox_item.sql
-- Fase 4.1 — claim atómico de messaging_outbox entre múltiples workers.
--
-- PROBLEMA (auditado en el reporte de Fase 4.1):
--   dispatcher.ts's claimNextOutboxItem() hacía:
--     1. SELECT status rows -> computar "cuentas ocupadas" en JS
--     2. SELECT pending candidates
--     3. elegir uno en JS (pickNextClaimable)
--     4. UPDATE ... WHERE id = X AND status = 'pending'  (esto SÍ es atómico
--        a nivel de fila individual)
--   El paso 4 es atómico por fila, pero la decisión "¿esta cuenta ya está
--   ocupada?" (pasos 1-3) se calcula sobre una lectura no bloqueante bajo
--   READ COMMITTED. Dos workers concurrentes pueden leer, cada uno, un
--   snapshot donde la cuenta X "no está ocupada" y terminar reclamando DOS
--   filas pending DISTINTAS para la MISMA cuenta — violando "máximo 1 item
--   processing por cuenta a la vez" y arriesgando disparar MacroDroid dos
--   veces para el mismo Android en simultáneo.
--
-- SOLUCIÓN:
--   Toda la decisión (¿está ocupada? ¿cuál reclamo?) se mueve a una única
--   función Postgres que usa pg_try_advisory_xact_lock(hashtext(account_id))
--   para serializar, POR CUENTA, el tramo "verificar ocupada + reclamar".
--   El lock es transaction-scoped: se libera solo al confirmar la
--   transacción que envuelve esta llamada RPC (una llamada = una
--   transacción implícita), por lo que ningún otro caller puede evaluar
--   "¿está ocupada la cuenta X?" mientras este caller todavía está
--   decidiendo/reclamando para la cuenta X. pg_try_advisory_xact_lock no es
--   bloqueante: si otra transacción ya tiene el lock de esa cuenta, este
--   caller simplemente pasa a la siguiente cuenta candidata en la misma
--   llamada (Android A nunca bloquea a Android B).
--
--   Preserva exactamente la misma política que ya existía en JS
--   (dispatcher-claim.ts, que se mantiene como test/documentación de la
--   política, ya no como mecanismo de aplicación real):
--     - ocupada si hay una fila 'processing' para esa cuenta, o una fila
--       'dispatched' dentro del cooldown (p_cooldown_seconds).
--     - FIFO por created_at ascendente sobre pending, entre TODAS las
--       cuentas (no solo dentro de una cuenta) — se recorre la cola global
--       ordenada por antigüedad y se salta cualquier cuenta ya determinada
--       ocupada/bloqueada dentro de esta misma llamada.
--     - devuelve como mucho 1 fila (0 si no hay nada reclamable) — mismo
--       contrato que la función JS original, dispatcher.ts sigue llamándola
--       en un loop acotado por MAX_DISPATCHES_PER_TICK.
--
-- Solo accesible por service_role (mismo modelo de acceso que las tablas
-- que toca: RLS habilitado, cero policies).
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
    -- call instead of waiting.
    IF NOT pg_try_advisory_xact_lock(hashtext(v_row.account_id::text)) THEN
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
  'safe under concurrent callers via pg_try_advisory_xact_lock per '
  'account_id. See migration file header for full rationale.';

REVOKE ALL ON FUNCTION public.claim_next_outbox_item(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_outbox_item(INT) TO service_role;

COMMIT;

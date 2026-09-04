-- =============================================================================
-- 20260826000003_device_dispatch_lease.sql
-- Fase 6B.2 — coordinación cross-queue entre messaging_outbox (texto saliente)
-- y media_events (extracción de media): ambas colas se serializan de forma
-- INDEPENDIENTE por cuenta (claim_next_outbox_item / claim_next_media_event,
-- cada una con su propio pg_try_advisory_xact_lock por account_id), pero
-- ambas terminan disparando el MISMO webhook MacroDroid del MISMO Android
-- físico. Sin coordinación entre ellas, un envío de texto y una extracción de
-- media para la MISMA cuenta podían quedar "en vuelo" (HTTP disparado, macro
-- de MacroDroid potencialmente ejecutando) al mismo tiempo — ver Fase 6B.1
-- report, riesgo señalado explícitamente por el usuario como el problema
-- arquitectónico #1 a resolver antes del commit.
--
-- POR QUÉ EL LOCK COMPARTIDO POR SÍ SOLO NO ALCANZABA:
--   Las dos funciones ya usan la MISMA clave de lock
--   (hashtextextended(account_id::text, 0)) — son mutuamente excluyentes
--   DURANTE la sección de claim (unos ms), pero el lock es transaction-scoped
--   y se libera al terminar esa llamada RPC. El fetch() real a MacroDroid
--   ocurre DESPUÉS, en Node, fuera de cualquier transacción/lock — por lo que
--   dos ticks independientes (dispatcher.ts y media-dispatcher.ts, cada uno
--   en su propio setInterval de 3s) podían cada uno reclamar exitosamente
--   (el busy-check de cada función solo mira SU PROPIA tabla) y disparar dos
--   fetch() casi simultáneos contra el mismo webhook.
--
-- SOLUCIÓN — reserva compartida mínima en whatsapp_accounts (no tabla nueva,
-- no rediseño de ninguna de las dos funciones más allá de esto):
--   whatsapp_accounts.device_dispatch_reserved_until: si es NULL o está en el
--   pasado, el device está libre. Cuando CUALQUIERA de las dos funciones
--   reclama una fila para una cuenta, dentro de la MISMA sección protegida
--   por el advisory lock que ya tenía, también fija esta columna a
--   now() + p_lease_seconds. La OTRA función, al evaluar su propio
--   busy-check (bajo el MISMO lock, para la misma cuenta), ahora también
--   consulta esta columna — si está reservada, trata la cuenta como ocupada
--   y pasa a la siguiente candidata, sin bloquear otras cuentas.
--
--   El dispatcher en Node (dispatcher.ts / media-dispatcher.ts) libera la
--   reserva explícitamente apenas el fetch() a MacroDroid resuelve (éxito o
--   error) — ver apps/worker/src/lib/device-lease.ts. Si el worker crashea
--   antes de liberar, la reserva simplemente expira sola a los
--   p_lease_seconds (no hace falta un job de limpieza ni un retry: el ESTADO
--   del mensaje/evento fallado no depende de esto, solo la disponibilidad del
--   device para el SIGUIENTE claim).
--
-- VALOR DEL LEASE (p_lease_seconds, default 20s) — justificación:
--   DISPATCH_TIMEOUT_MS en outbound.ts es 15s (el fetch() a MacroDroid aborta
--   solo si tarda más que eso). 20s da margen sobre el peor caso normal
--   (~15s) para que la liberación explícita en Node alcance a correr antes de
--   que el lease expire por sí solo, y sigue siendo un valor conservador y
--   acotado (nunca deja una cuenta bloqueada más de 20s aunque el worker
--   crashee a mitad del dispatch). No tuneado aún contra throughput real de
--   dispositivo — mismo criterio que ACCOUNT_DISPATCH_COOLDOWN_MS
--   (dispatcher.ts) y STUCK_THRESHOLD_MS (media-dispatcher.ts).
--
-- GARANTIZA:
--   A) outbound cuenta X y media cuenta X nunca "en vuelo" al mismo tiempo.
--   B) dos outbound de la cuenta X siguen serializados exactamente como antes
--      (busy-check propio de messaging_outbox sin cambios).
--   C) dos media de la cuenta X siguen serializados exactamente como antes
--      (busy-check propio de media_events sin cambios).
--   D) la cuenta Y (Android distinto) nunca se ve afectada por una reserva de
--      la cuenta X — la columna y el lock son por account_id.
--   E) no se agrega ningún retry automático nuevo.
-- =============================================================================

BEGIN;

ALTER TABLE public.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS device_dispatch_reserved_until TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.whatsapp_accounts.device_dispatch_reserved_until IS
  'Fase 6B.2 — reserva compartida cross-queue: mientras sea > now(), NI '
  'claim_next_outbox_item NI claim_next_media_event pueden reclamar una '
  'nueva fila para esta cuenta (impide que un envío de texto y una '
  'extracción de media disparen MacroDroid en simultáneo para el mismo '
  'Android). Fijada por la función que reclama; liberada explícitamente por '
  'el worker (ver device-lease.ts) apenas el fetch() a MacroDroid resuelve, '
  'o expira sola si el worker crashea a mitad del dispatch.';

-- ── claim_next_outbox_item: agrega p_lease_seconds y el check/reserva
--    cross-queue. El resto de la función (política FIFO, busy-check propio
--    de messaging_outbox, retorno de a lo sumo 1 fila) queda IDÉNTICO.
--
--    IMPORTANTE: CREATE OR REPLACE con una firma de argumentos DISTINTA
--    (INT) → (INT, INT) NO reemplaza la función vieja — Postgres identifica
--    funciones por nombre+tipos de argumentos, así que crearía un SEGUNDO
--    overload y dejaría la firma anterior viva y otorgada a service_role,
--    lo que puede volver ambigua la resolución de PostgREST al llamar via
--    supabase.rpc(). Se DROP explícitamente la firma vieja primero. ────────
DROP FUNCTION IF EXISTS public.claim_next_outbox_item(INT);

CREATE OR REPLACE FUNCTION public.claim_next_outbox_item(
  p_cooldown_seconds INT DEFAULT 8,
  p_lease_seconds    INT DEFAULT 20
)
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

    IF NOT pg_try_advisory_xact_lock(hashtextextended(v_row.account_id::text, 0)) THEN
      v_tried_accounts := array_append(v_tried_accounts, v_row.account_id);
      CONTINUE;
    END IF;

    -- Ocupada si: hay un item propio en curso/cooldown (igual que antes), O
    -- la reserva compartida cross-queue (Fase 6B.2) está activa — otra
    -- extracción de media para esta misma cuenta está en vuelo.
    IF EXISTS (
      SELECT 1 FROM public.messaging_outbox
      WHERE account_id = v_row.account_id
        AND (
          status = 'processing'
          OR (status = 'dispatched' AND dispatched_at > now() - (p_cooldown_seconds || ' seconds')::interval)
        )
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_accounts
      WHERE id = v_row.account_id
        AND device_dispatch_reserved_until IS NOT NULL
        AND device_dispatch_reserved_until > now()
    ) THEN
      v_tried_accounts := array_append(v_tried_accounts, v_row.account_id);
      CONTINUE;
    END IF;

    UPDATE public.messaging_outbox
    SET status = 'processing', updated_at = now()
    WHERE id = v_row.id AND status = 'pending'
    RETURNING * INTO v_claimed;

    IF FOUND THEN
      -- Reserva el device compartido para el fetch() que Node hará a
      -- continuación, fuera de este lock/transacción.
      UPDATE public.whatsapp_accounts
      SET device_dispatch_reserved_until = now() + (p_lease_seconds || ' seconds')::interval
      WHERE id = v_row.account_id;

      RETURN NEXT v_claimed;
      RETURN;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.claim_next_outbox_item(INT, INT) IS
  'Atomically claims at most one pending messaging_outbox row, enforcing at '
  'most 1 processing/recently-dispatched item per account at a time, AND '
  'the shared cross-queue device_dispatch_reserved_until lease (Fase 6B.2) '
  'so a text send never overlaps a media_events dispatch for the same '
  'account. See migration 20260825000003 for the base rationale and '
  '20260826000003 for the cross-queue lease.';

REVOKE ALL ON FUNCTION public.claim_next_outbox_item(INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_outbox_item(INT, INT) TO service_role;

-- ── claim_next_media_event: mismo tratamiento — agrega p_lease_seconds y el
--    check/reserva cross-queue. Busy-check propio de media_events sin
--    cambios. Mismo motivo que arriba: DROP explícito de la firma vieja
--    (sin argumentos) antes de crear la nueva. ─────────────────────────────
DROP FUNCTION IF EXISTS public.claim_next_media_event();

CREATE OR REPLACE FUNCTION public.claim_next_media_event(
  p_lease_seconds INT DEFAULT 20
)
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

    -- Ocupada si: hay un media event propio en curso (igual que antes), O
    -- la reserva compartida cross-queue (Fase 6B.2) está activa — un envío
    -- de texto para esta misma cuenta está en vuelo.
    IF EXISTS (
      SELECT 1 FROM public.media_events
      WHERE account_id = v_row.account_id
        AND (
          status IN ('uploading', 'processing')
          OR (status = 'pending_android' AND dispatched_at IS NOT NULL)
        )
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_accounts
      WHERE id = v_row.account_id
        AND device_dispatch_reserved_until IS NOT NULL
        AND device_dispatch_reserved_until > now()
    ) THEN
      v_tried_accounts := array_append(v_tried_accounts, v_row.account_id);
      CONTINUE;
    END IF;

    UPDATE public.media_events
    SET dispatched_at = now(), updated_at = now()
    WHERE id = v_row.id AND status = 'pending_android' AND dispatched_at IS NULL
    RETURNING * INTO v_claimed;

    IF FOUND THEN
      UPDATE public.whatsapp_accounts
      SET device_dispatch_reserved_until = now() + (p_lease_seconds || ' seconds')::interval
      WHERE id = v_row.account_id;

      RETURN NEXT v_claimed;
      RETURN;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.claim_next_media_event(INT) IS
  'Atomically claims (marks dispatched_at) at most one pending_android media '
  'event, enforcing at most 1 in-flight media extraction per account, AND '
  'the shared cross-queue device_dispatch_reserved_until lease (Fase 6B.2) '
  'so a media dispatch never overlaps a messaging_outbox dispatch for the '
  'same account. See migration 20260826000002 for the base rationale and '
  '20260826000003 for the cross-queue lease.';

REVOKE ALL ON FUNCTION public.claim_next_media_event(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_media_event(INT) TO service_role;

COMMIT;

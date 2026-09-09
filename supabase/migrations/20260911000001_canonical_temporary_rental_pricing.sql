-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-A.1 — motor de pricing canónico para temporary_rental
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── QUÉ ENCONTRÓ LA AUDITORÍA ───────────────────────────────────────────────
--
-- No existía una fuente canónica. Existían CUATRO copias de la misma fórmula,
-- todas en TypeScript y aritméticamente idénticas:
--
--   1. apps/worker/src/tools/check-property-availability.ts
--        → cotiza y escribe conversation_reservation_drafts + price_summary
--   2. apps/worker/src/tools/create-pending-reservation.ts (Step 5)
--        → snapshots de la reserva cuando no hay draft válido
--   3. apps/web/src/actions/reservations.ts — rescheduleReservationAction
--   4. apps/web/src/actions/reservations.ts — createReservationAction
--
-- Y un quinto camino, decide_operation_request (Fase 3E-A), que no calculaba
-- nada y dejaba todos los importes en NULL.
--
-- ── POR QUÉ LA FÓRMULA VIVE EN SQL Y NO EN TYPESCRIPT ───────────────────────
--
-- El worker no tiene NINGUNA dependencia de workspace en runtime (@orderflow/*
-- son devDependencies, type-only). Un módulo TS compartido entre apps/worker y
-- apps/web tendría que copiarse a mano — el precedente lib/phone.ts. O sea:
-- mantener la fórmula en TypeScript garantiza DOS copias como mínimo.
--
-- Además, la materialización desde formulario tiene que ocurrir dentro de la
-- transacción de decide_operation_request (atomicidad de Fase 3E-A). Un cálculo
-- en TypeScript no puede participar de esa transacción.
--
-- SQL es el único lugar que alcanzan los tres: apps/worker, apps/web y una
-- transacción del servidor. Así que la fórmula se mudó acá y las cuatro copias
-- de TypeScript se borraron; lo que quedó allá son wrappers que solo hacen la
-- llamada y no contienen aritmética.
--
-- Esto NO es "reescribir la fórmula en PL/pgSQL manteniéndola en TS". Es
-- MOVERLA: después de esta fase la aritmética existe exactamente una vez.
--
-- ── SEMÁNTICA — COPIA EXACTA DEL COMPORTAMIENTO VIGENTE ─────────────────────
--
-- Cada detalle acá replica lo que hacía el TypeScript, incluidas sus rarezas:
--
--   · noches = end - start (resta de DATE en PG = días enteros; el TS hacía
--     Math.round(diffMs / 86400000) sobre fechas UTC a medianoche → igual).
--   · Solo cotiza si pricing_mode = 'fixed' Y base_price_per_night es TRUTHY.
--     En JavaScript `if (property.base_price_per_night)` es falso también para
--     0, no solo para null — de ahí el `<> 0`. Una propiedad 'fixed' con precio
--     0 o sin precio cae al mismo lugar que 'consult': todo NULL.
--   · fees = COALESCE(cleaning_fee, 0)
--   · total = subtotal + fees
--   · deposit: temporary_deposit_amount si es truthy; si no, el porcentaje
--     redondeado sobre el total; si no, NULL. Mismo orden de precedencia.
--   · currency = COALESCE(currency, 'ARS'), pricing_mode = COALESCE(…,'consult')
--
-- NO se agregó ninguna regla nueva (§8): no hay service fee, ni descuentos, ni
-- estacionalidad, porque el producto no los tiene hoy. Los únicos conceptos
-- monetarios reales son cleaning_fee y la seña.
--
-- ── 'consult' — PRECIO DESCONOCIDO, NO PRECIO CERO (§7) ─────────────────────
--
-- nightly_price / subtotal / total / deposit vuelven NULL, no 0. La distinción
-- importa: NULL significa "todavía no hay precio calculable, lo coordina el
-- asesor". El único 0 es `fees`, y no es una decisión: reservations.fees_amount
-- es NUMERIC NOT NULL DEFAULT 0, así que nunca pudo ser NULL.
--
-- ── SEGURIDAD (§5) ──────────────────────────────────────────────────────────
--
-- SECURITY INVOKER a propósito (no DEFINER). Así las RLS de properties siguen
-- aplicando para quien llame: un authenticated de otro tenant no encuentra la
-- propiedad y recibe property_not_found, sin poder cotizar propiedades ajenas.
-- Llamada desde decide_operation_request (SECURITY DEFINER) corre con los
-- privilegios de esa función, que ya validó pertenencia al tenant.
--
-- STABLE: solo lee. No escribe nada, así que cotizar no tiene efectos.
--
-- Lo importante de §5: ningún importe viaja nunca desde el browser. Los montos
-- se derivan de public.properties del lado del servidor. La UI no tiene forma
-- de proponer un precio, ni siquiera de mencionarlo.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.quote_temporary_rental(
  p_tenant_id   UUID,
  p_property_id UUID,
  p_start       DATE,
  p_end         DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_prop      record;
  v_nights    INT;
  v_mode      TEXT;
  v_currency  TEXT;
  v_nightly   NUMERIC;
  v_subtotal  NUMERIC;
  v_fees      NUMERIC := 0;
  v_total     NUMERIC;
  v_deposit   NUMERIC;
  v_breakdown JSONB   := '{}'::JSONB;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_dates');
  END IF;

  SELECT p.pricing_mode, p.currency, p.base_price_per_night, p.cleaning_fee,
         p.temporary_deposit_amount, p.temporary_deposit_percent
  INTO v_prop
  FROM public.properties p
  WHERE p.id = p_property_id
    AND p.tenant_id = p_tenant_id
    AND p.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'property_not_found');
  END IF;

  v_nights   := p_end - p_start;
  v_mode     := COALESCE(v_prop.pricing_mode, 'consult');
  v_currency := COALESCE(v_prop.currency, 'ARS');

  -- `<> 0` replica la truthiness de JavaScript: 0 y NULL caen igual.
  IF v_mode = 'fixed' AND COALESCE(v_prop.base_price_per_night, 0) <> 0 THEN
    v_nightly  := v_prop.base_price_per_night;
    v_subtotal := v_nightly * v_nights;
    v_fees     := COALESCE(v_prop.cleaning_fee, 0);
    v_total    := v_subtotal + v_fees;

    IF COALESCE(v_prop.temporary_deposit_amount, 0) <> 0 THEN
      v_deposit := v_prop.temporary_deposit_amount;
    ELSIF COALESCE(v_prop.temporary_deposit_percent, 0) <> 0 THEN
      v_deposit := round(v_total * v_prop.temporary_deposit_percent / 100);
    END IF;

    -- El breakdown unifica lo que antes divergía: create-pending-reservation
    -- incluía currency y pricing_mode, los otros tres caminos no. Se toma el
    -- superconjunto, así una reserva creada desde draft y una calculada al
    -- momento quedan con el MISMO breakdown (antes no coincidían entre sí).
    v_breakdown := jsonb_build_object(
      'nightly_price', v_nightly,
      'nights',        v_nights,
      'subtotal',      v_subtotal,
      'cleaning_fee',  v_fees,
      'total',         v_total,
      'deposit',       v_deposit,
      'currency',      v_currency,
      'pricing_mode',  v_mode
    );
  END IF;

  RETURN jsonb_build_object(
    'ok',            true,
    'pricing_mode',  v_mode,
    'currency',      v_currency,
    'nights',        v_nights,
    'nightly_price', v_nightly,
    'subtotal',      v_subtotal,
    'fees',          v_fees,
    'total',         v_total,
    'deposit',       v_deposit,
    'breakdown',     v_breakdown
  );
END;
$function$;

COMMENT ON FUNCTION public.quote_temporary_rental(UUID, UUID, DATE, DATE) IS
  'Fase 3E-A.1: ÚNICA fuente de verdad del pricing de alquiler temporal. La '
  'usan los cuatro caminos que crean o reprograman reservas (IA cotizando, IA '
  'creando, creación manual, reprogramación) y decide_operation_request al '
  'materializar una solicitud aprobada. Devuelve importes en NULL cuando el '
  'precio no es calculable (pricing_mode consult, o fixed sin '
  'base_price_per_night) — NULL es "precio desconocido", nunca cero. '
  'SECURITY INVOKER para que las RLS de properties acoten al tenant del caller.';

-- Supabase aplica ALTER DEFAULT PRIVILEGES que otorgan EXECUTE en funciones
-- nuevas de public a anon/authenticated/service_role. REVOKE FROM PUBLIC no
-- deshace esos grants — hay que revocarlos por rol, explícitamente
-- (precedente: 20260803000002_harden_admin_purge_tenant_permissions.sql).
REVOKE ALL ON FUNCTION public.quote_temporary_rental(UUID, UUID, DATE, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.quote_temporary_rental(UUID, UUID, DATE, DATE) FROM anon;

-- authenticated: las server actions del dashboard (creación manual y
-- reprogramación) cotizan con la sesión del usuario, y las RLS de properties
-- acotan al tenant. service_role: el worker (IA).
GRANT EXECUTE ON FUNCTION public.quote_temporary_rental(UUID, UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quote_temporary_rental(UUID, UUID, DATE, DATE) TO service_role;

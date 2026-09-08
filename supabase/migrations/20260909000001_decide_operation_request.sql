-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3D — decisión humana sobre una operation_request
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── POR QUÉ UNA RPC Y NO UPDATE DIRECTO ─────────────────────────────════════
--
-- La Fase 3C cerró el UPDATE directo para authenticated sobre
-- operation_requests, precisamente porque decided_by/decided_at son HECHOS
-- ("esta persona decidió, en este momento") y poder escribirlos desde el
-- cliente es poder fabricarlos. Esta RPC es la única vía de decisión.
--
-- decided_by sale de auth.uid() y decided_at de now(), ambos server-side.
-- Los valores que mande el cliente para esos campos no existen: la función no
-- los recibe.
--
-- ── PATRÓN REUTILIZADO ──────────────────────────────────────────────────────
--
-- record_monthly_rental_payment(): SECURITY DEFINER, search_path fijo,
-- SELECT ... FOR UPDATE para lockear, validaciones antes de escribir,
-- RETURNS jsonb. Igual que confirm_submission_and_create_operation() de 3C,
-- los desenlaces de NEGOCIO vuelven como 'outcome' y no como excepción, para
-- que la UI pueda mostrar un mensaje distinto por caso sin parsear texto de
-- error.
--
-- ── AUTORIZACIÓN (§5) ───────────────────────────────────────────────────────
--
-- SECURITY DEFINER significa que el UPDATE corre como el owner de la función y
-- SALTEA RLS. Por eso la autorización la hace la función explícitamente, paso
-- por paso, y no se apoya en las policies (§16).
--
--   1. auth.uid() tiene que existir       → si no, no hay usuario
--   2. tiene que ser tenant_user           → bloquea platform_user (ver §6)
--   3. tiene que estar en tenant_users y activo
--   4. la operación tiene que ser de SU tenant
--   5. rol permitido: owner, o can_confirm_reservations
--   6. status actual = pending
--   7. action ∈ (confirmed, rejected)
--
-- El permiso reutilizado es can_confirm_reservations, el mismo que usa
-- confirmReservationAction para confirmar reservas: decidir una solicitud es
-- la misma clase de autoridad. No se inventa un permiso nuevo porque no hay
-- UI para otorgarlo — sería un permiso que nadie puede dar.
--
-- ── IMPERSONACIÓN (§6) ──────────────────────────────────────────────────────
--
-- Un super admin impersonando NO puede decidir. No es una preferencia: es el
-- patrón ya establecido del producto. Diez archivos de apps/web/src/actions
-- (contacts, conversations, documents, messages, monthly-rentals, notes,
-- receipts, receipt-whatsapp, reservation-payments, reservations) empiezan sus
-- mutaciones con
--
--     if (ctx.accessMode === 'setup_operator') return { success: false, ... }
--
-- La impersonación en ReservaNex es para soporte y lectura, no para actuar en
-- nombre del tenant. Acá se aplica lo mismo, pero en la BASE y no solo en la
-- action: el check 2 rechaza a cualquier platform_user, tenga o no sesión de
-- impersonación activa.
--
-- ── TRANSICIONES (§3) ───────────────────────────────────────────────────────
--
-- Solo pending → confirmed y pending → rejected. Nada más. No hay
-- confirmed → pending ni rejected → confirmed: revertir una decisión ya
-- comunicada es una operación de dominio que todavía no existe, y abrirla
-- "por las dudas" permitiría reescribir la historia de la decisión.
-- 'cancelled' queda reservado para la cancelación válida futura.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.decide_operation_request(
  p_operation_id UUID,
  p_action       TEXT,
  p_notes        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor   UUID;
  v_member  record;
  v_op      record;
  v_notes   TEXT;
BEGIN
  -- ── 1. Hay un usuario ────────────────────────────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;

  -- ── 2. Es un usuario de tenant, no de plataforma ─────────────────────────
  -- Bloquea al super admin impersonando (§6). Se mira el claim del JWT, que
  -- SECURITY DEFINER no altera: cambia el rol de ejecución, no los GUC de
  -- sesión de donde auth.jwt() lee.
  IF public.auth_user_type() = 'platform_user' THEN
    RETURN jsonb_build_object('outcome', 'platform_user_not_allowed');
  END IF;

  -- ── 3. Está en tenant_users y activo ─────────────────────────────────────
  SELECT tu.tenant_id, tu.role::TEXT AS role, tu.can_confirm_reservations
  INTO v_member
  FROM public.tenant_users tu
  WHERE tu.id = v_actor AND tu.active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_a_tenant_member');
  END IF;

  -- ── 7. La acción es una de las dos permitidas ────────────────────────────
  IF p_action IS NULL OR p_action NOT IN ('confirmed', 'rejected') THEN
    RETURN jsonb_build_object('outcome', 'invalid_action');
  END IF;

  -- ── §7. Nota: trim, tope de longitud, sin HTML ───────────────────────────
  -- Se guarda texto plano. El tope evita que alguien use decision_notes como
  -- almacenamiento libre. Una nota que queda vacía después del trim es NULL,
  -- no una cadena vacía.
  v_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');
  IF v_notes IS NOT NULL THEN
    IF length(v_notes) > 500 THEN
      RETURN jsonb_build_object('outcome', 'notes_too_long', 'max_length', 500);
    END IF;
    IF v_notes ~ '<[^>]+>' THEN
      RETURN jsonb_build_object('outcome', 'notes_invalid');
    END IF;
  END IF;

  -- ── 4. La operación es de SU tenant, y se lockea ─────────────────────────
  -- El tenant_id del WHERE viene de tenant_users (la base), NUNCA de un
  -- parámetro: el cliente no puede elegir sobre qué tenant decide.
  -- FOR UPDATE serializa dos decisiones simultáneas (§8).
  SELECT o.id, o.status, o.decided_at, o.decided_by, o.decision_notes
  INTO v_op
  FROM public.operation_requests o
  WHERE o.id = p_operation_id AND o.tenant_id = v_member.tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Genérico a propósito: no distingue "no existe" de "es de otro tenant".
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- ── 5. Permiso para decidir ──────────────────────────────────────────────
  IF NOT (v_member.role = 'owner' OR v_member.can_confirm_reservations) THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  -- ── 6. Sigue pendiente ───────────────────────────────────────────────────
  -- El segundo de dos decisores concurrentes llega acá: el primero ya la
  -- movió, así que se devuelve la decisión existente SIN pisarla (§8, §9).
  IF v_op.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'outcome',        'already_decided',
      'status',         v_op.status,
      'decided_at',     v_op.decided_at,
      'decided_by',     v_op.decided_by,
      'decision_notes', v_op.decision_notes
    );
  END IF;

  -- ── La transición ────────────────────────────────────────────────────────
  -- decided_by de auth.uid() y decided_at de now(): ninguno de los dos puede
  -- venir del cliente. El guard status='pending' en el WHERE cierra la
  -- carrera aunque dos transacciones pasaran el chequeo de arriba.
  UPDATE public.operation_requests
  SET status         = p_action,
      decided_at     = NOW(),
      decided_by     = v_actor,
      decision_notes = v_notes
  WHERE id = p_operation_id
    AND tenant_id = v_member.tenant_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'already_decided');
  END IF;

  -- La auditoría la escribe trg_audit_operation_requests (audit_table_change),
  -- que ya estaba desde la Fase 3C: guarda actor_id = auth.uid(), old_value y
  -- new_value completos, así que el status anterior y el nuevo se reconstruyen
  -- de ahí. No se crea un segundo sistema de auditoría (§10).

  RETURN jsonb_build_object(
    'outcome',    p_action,
    'decided_at', NOW(),
    'decided_by', v_actor
  );
END;
$function$;

-- ── Grants (§17) ────────────────────────────────────────────────────────────
--
-- Acá SÍ hace falta que authenticated ejecute: es el usuario del CRM quien
-- decide. La autorización la hace la función, no el grant.
--
-- anon NO: no hay ningún caso en que un anónimo decida.
-- service_role tampoco se otorga: la función depende de auth.uid(), que para
-- el service role es NULL, así que devolvería 'unauthenticated' — un grant
-- que no sirve para nada es un grant que no debe existir.
--
-- Se revoca EXPLÍCITAMENTE de anon además de PUBLIC: los ALTER DEFAULT
-- PRIVILEGES de Supabase otorgan EXECUTE directo a anon/authenticated sobre
-- las funciones nuevas de public, y "REVOKE FROM PUBLIC" no toca esos grants
-- directos. Ya tropezamos con esto en 20260908000004 y en
-- 20260803000002_harden_admin_purge_tenant_permissions.sql.
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) IS
  'Fase 3D: única vía para decidir una operation_request. pending → confirmed '
  'o pending → rejected, nada más. decided_by sale de auth.uid() y decided_at '
  'de now(): el cliente no puede fabricarlos. Bloquea a los platform_user '
  '(impersonación es soporte/lectura, igual que en las server actions). '
  'Outcomes: confirmed | rejected | already_decided | not_found | forbidden | '
  'unauthenticated | platform_user_not_allowed | not_a_tenant_member | '
  'invalid_action | notes_too_long | notes_invalid. '
  'NO crea reservations ni bloquea disponibilidad — eso es Fase 3E.';

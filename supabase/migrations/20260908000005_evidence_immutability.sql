-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3C — inmutabilidad de la evidencia histórica
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── LA BRECHA ───────────────────────────────────────────────────────────────
--
-- RLS restringe FILAS, no COLUMNAS. Las policies tenant_update_form_submissions
-- (Fase 3A) y tenant_update_operation_requests (Fase 3C) usan
--
--   USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id())
--
-- lo que autoriza a un usuario del tenant a hacer UPDATE de CUALQUIER columna
-- de sus propias filas. Verificado empíricamente con un login real de owner
-- (apps/web/scripts/validate-evidence-integrity.ts, corrida previa a esta
-- migración): 19 mutaciones retroactivas exitosas, entre ellas
--
--   operation_requests.payload_snapshot
--     {"name":"Ana Gómez","adults":2,...} → {"name":"FALSIFICADO","adults":99}
--   operation_requests.intent          temporary_rental → general_inquiry
--   operation_requests.requested_date  2026-10-15 → 2027-01-01
--   operation_requests.created_at      → 2020-01-01
--   form_submissions.payload           → FALSIFICADO
--   form_submissions.confirmed_at      → 2020-01-01
--
-- Solo dos columnas resistieron, y por accidente: `reference` por el CHECK de
-- formato (23514) y `tenant_id` porque cambiarlo viola el propio WITH CHECK
-- de la policy (42501). Ninguna de las dos es una defensa de integridad.
--
-- Consecuencia real: un owner podía reescribir qué pidió el cliente, después
-- de que el cliente lo confirmara por WhatsApp. Eso destruye el valor de la
-- evidencia justo cuando más importa (una disputa).
--
-- ── PROTECCIÓN ELEGIDA: A + B (defensa en profundidad, §3 C) ────────────────
--
-- 1. TRIGGER BEFORE UPDATE que rechaza cambios en columnas históricas.
--    Es la garantía real y aplica a TODOS los roles, incluido service_role:
--    ni siquiera un bug del propio worker puede reescribir la evidencia. Sigue
--    el idioma del repo, que ya usa triggers de guarda
--    (check_*_consistency, clear_expires_at_on_advance, set_task_completed_at).
--
-- 2. GRANTS POR COLUMNA para authenticated y anon: se revoca el UPDATE de
--    tabla y se otorga solo sobre las columnas mutables. Así el intento falla
--    por privilegios ANTES de llegar al trigger, y —más importante— cualquier
--    columna que se agregue en el futuro nace INMUTABLE salvo que alguien la
--    otorgue explícitamente. Para una tabla de evidencia, ese es el default
--    correcto.
--
-- No se eligió la opción B sola (quitar UPDATE y hacer todo por RPC) porque la
-- RPC de aprobación/rechazo pertenece a una fase posterior; dejar hoy la tabla
-- sin ningún camino de UPDATE obligaría a construirla ahora, fuera de alcance.
-- El trigger ya da la garantía dura sin bloquear ese futuro.
-- ════════════════════════════════════════════════════════════════════════════


-- ── operation_requests ──────────────────────────────────────────────────────
--
-- MUTABLE:   status, decided_at, decided_by, decision_notes, updated_at
-- INMUTABLE: todo lo demás (identidad, origen, contexto y datos del pedido)

CREATE OR REPLACE FUNCTION public.guard_operation_request_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.id                    IS DISTINCT FROM OLD.id
  OR NEW.tenant_id             IS DISTINCT FROM OLD.tenant_id
  OR NEW.contact_id            IS DISTINCT FROM OLD.contact_id
  OR NEW.conversation_id       IS DISTINCT FROM OLD.conversation_id
  OR NEW.source_submission_id  IS DISTINCT FROM OLD.source_submission_id
  OR NEW.kind                  IS DISTINCT FROM OLD.kind
  OR NEW.intent                IS DISTINCT FROM OLD.intent
  OR NEW.entity_type           IS DISTINCT FROM OLD.entity_type
  OR NEW.entity_id             IS DISTINCT FROM OLD.entity_id
  OR NEW.publication_ref       IS DISTINCT FROM OLD.publication_ref
  OR NEW.entity_title_snapshot IS DISTINCT FROM OLD.entity_title_snapshot
  OR NEW.requested_date        IS DISTINCT FROM OLD.requested_date
  OR NEW.requested_end_date    IS DISTINCT FROM OLD.requested_end_date
  OR NEW.requested_time        IS DISTINCT FROM OLD.requested_time
  OR NEW.payload_snapshot      IS DISTINCT FROM OLD.payload_snapshot
  OR NEW.customer_confirmed_at IS DISTINCT FROM OLD.customer_confirmed_at
  OR NEW.created_at            IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'operation_requests: los datos del pedido son inmutables. Solo se pueden cambiar status, decided_at, decided_by y decision_notes.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_operation_request_immutability ON public.operation_requests;
CREATE TRIGGER trg_guard_operation_request_immutability
  BEFORE UPDATE ON public.operation_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_operation_request_immutability();


-- ── form_submissions ────────────────────────────────────────────────────────
--
-- MUTABLE:   status, updated_at
--            contact_id   — pero SOLO de NULL a un valor (el binding del §8 de
--                           la Fase 3B), nunca de un contacto a otro
--            confirmed_at — SOLO de NULL a un valor, una vez
-- INMUTABLE: payload, tenant_id, reference, intent, source, idempotency_key,
--            publication_ref, entity_type, entity_id, expires_at, created_at
--
-- expires_at queda inmutable a propósito: define la ventana de validez, y
-- poder estirarla retroactivamente permitiría resucitar una submission ya
-- vencida. Si alguna vez hace falta extenderla, que sea por una RPC explícita.

CREATE OR REPLACE FUNCTION public.guard_form_submission_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.id              IS DISTINCT FROM OLD.id
  OR NEW.tenant_id       IS DISTINCT FROM OLD.tenant_id
  OR NEW.reference       IS DISTINCT FROM OLD.reference
  OR NEW.intent          IS DISTINCT FROM OLD.intent
  OR NEW.source          IS DISTINCT FROM OLD.source
  OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  OR NEW.publication_ref IS DISTINCT FROM OLD.publication_ref
  OR NEW.entity_type     IS DISTINCT FROM OLD.entity_type
  OR NEW.entity_id       IS DISTINCT FROM OLD.entity_id
  OR NEW.expires_at      IS DISTINCT FROM OLD.expires_at
  OR NEW.created_at      IS DISTINCT FROM OLD.created_at
  OR NEW.payload         IS DISTINCT FROM OLD.payload
  THEN
    RAISE EXCEPTION
      'form_submissions: lo que el cliente envió es inmutable. Solo se pueden cambiar status, contact_id (una vez) y confirmed_at (una vez).'
      USING ERRCODE = 'check_violation';
  END IF;

  -- contact_id: se puede ASIGNAR una vez, nunca reasignar.
  IF OLD.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    RAISE EXCEPTION
      'form_submissions: contact_id ya está asignado y no se puede reasignar.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- confirmed_at: idem. Se sella cuando el cliente confirma y no se retoca.
  IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION
      'form_submissions: confirmed_at ya está sellado y no se puede modificar.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_form_submission_immutability ON public.form_submissions;
CREATE TRIGGER trg_guard_form_submission_immutability
  BEFORE UPDATE ON public.form_submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_submission_immutability();


-- ── Capa 2: grants por columna ──────────────────────────────────────────────
-- El UPDATE de tabla se revoca y se re-otorga SOLO sobre lo mutable. anon no
-- tiene ninguna policy en estas tablas, pero igual se le revoca: un grant que
-- no debería existir no debe quedar esperando a que alguien agregue una policy
-- por error.

REVOKE UPDATE ON public.operation_requests FROM authenticated;
REVOKE UPDATE ON public.operation_requests FROM anon;
GRANT  UPDATE (status, decided_at, decided_by, decision_notes, updated_at)
  ON public.operation_requests TO authenticated;

REVOKE UPDATE ON public.form_submissions FROM authenticated;
REVOKE UPDATE ON public.form_submissions FROM anon;
GRANT  UPDATE (status, contact_id, confirmed_at, updated_at)
  ON public.form_submissions TO authenticated;

-- anon tampoco debería poder INSERT/DELETE en ninguna de las dos: no tiene
-- policies, así que hoy no puede, pero el grant de tabla existe igual. Se
-- quita para que la ausencia de policy no sea lo único que lo detiene.
REVOKE INSERT, DELETE ON public.operation_requests FROM anon;
REVOKE INSERT, DELETE ON public.form_submissions   FROM anon;

COMMENT ON FUNCTION public.guard_operation_request_immutability() IS
  'Fase 3C: impide reescribir retroactivamente qué pidió el cliente. Aplica a '
  'TODOS los roles, service_role incluido — la evidencia no la puede alterar '
  'nadie, ni siquiera un bug del worker.';

COMMENT ON FUNCTION public.guard_form_submission_immutability() IS
  'Fase 3C: el payload y la identidad de una submission son inmutables. '
  'contact_id y confirmed_at se pueden asignar UNA vez (el binding y la '
  'confirmación de la Fase 3B) y después quedan sellados.';

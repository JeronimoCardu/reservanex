-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3C — endurecer permisos de confirm_submission_and_create_operation
-- ════════════════════════════════════════════════════════════════════════════
--
-- La migración 20260908000003 creó la función con
--
--   REVOKE ALL ... FROM PUBLIC;
--   GRANT EXECUTE ... TO service_role;
--
-- y eso NO alcanzó. Verificado en information_schema.routine_privileges
-- inmediatamente después de aplicarla: la función quedó con EXECUTE para
-- anon y authenticated.
--
-- El motivo es que los proyectos Supabase tienen ALTER DEFAULT PRIVILEGES que
-- otorgan EXECUTE sobre las funciones nuevas de public a anon, authenticated y
-- service_role. Ese grant es DIRECTO al rol, no vía PUBLIC, así que
-- "REVOKE FROM PUBLIC" no lo toca.
--
-- Por qué importa: la función es SECURITY DEFINER, o sea que corre con los
-- privilegios del owner y saltea RLS. Con EXECUTE para anon, cualquiera con la
-- anon key —que es pública por diseño— podía llamarla. Que los UUID sean
-- difíciles de adivinar no es un límite de seguridad aceptable.
--
-- Este repo ya tropezó con esto antes: existe
-- 20260803000002_harden_admin_purge_tenant_permissions.sql exactamente por el
-- mismo motivo, y 20260901000002_security_hardening_fase10.sql hizo lo mismo
-- con claim_ai_auto_reply_slot. Se sigue ese precedente: revocar
-- EXPLÍCITAMENTE de anon y authenticated, no solo de PUBLIC.
-- ════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.confirm_submission_and_create_operation(UUID, UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_submission_and_create_operation(UUID, UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.confirm_submission_and_create_operation(UUID, UUID, UUID, UUID) FROM authenticated;

-- Solo el worker. Un usuario del CRM no confirma una submission en nombre del
-- cliente: eso lo hace el cliente por WhatsApp, y nadie más.
GRANT EXECUTE ON FUNCTION public.confirm_submission_and_create_operation(UUID, UUID, UUID, UUID) TO service_role;

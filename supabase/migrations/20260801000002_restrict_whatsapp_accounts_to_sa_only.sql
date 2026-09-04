-- =============================================================================
-- 20260801000002_restrict_whatsapp_accounts_to_sa_only.sql
-- Fix A-02: mover configuración WhatsApp exclusivamente al Super Admin
-- =============================================================================
-- Policies eliminadas:
--   • owner_all_whatsapp_accounts     — owner tenía CRUD completo incluyendo
--     lectura de access_token_encrypted desde browser client.
--   • sa_imp_all_whatsapp_accounts    — SA podía operar vía sesión impersonada;
--     ahora todas las operaciones SA usan admin client en Server Actions,
--     por lo que esta policy no cumple ningún propósito y expone tokens.
--
-- Ya eliminada en migración anterior:
--   • receptionist_select_whatsapp_accounts (20260710000004)
--
-- Después de esta migración, ningún JWT autenticado puede acceder a
-- whatsapp_accounts directamente (RLS habilitado, sin policies = sin acceso).
-- Toda lectura y escritura ocurre vía service role (admin client) en:
--   • apps/web/src/actions/platform-whatsapp.ts  → SA actions
--   • apps/web/src/actions/whatsapp-settings.ts   → owner read-only
--   • apps/web/src/app/api/webhooks/whatsapp/route.ts
--   • apps/worker/src/whatsapp/sender.ts
-- =============================================================================

DROP POLICY IF EXISTS "owner_all_whatsapp_accounts"  ON public.whatsapp_accounts;
DROP POLICY IF EXISTS "sa_imp_all_whatsapp_accounts" ON public.whatsapp_accounts;

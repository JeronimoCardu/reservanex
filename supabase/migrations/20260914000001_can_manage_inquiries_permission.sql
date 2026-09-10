-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-B1 — permiso propio para gestionar consultas
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── LA BRECHA QUE CIERRA ────────────────────────────────────────────────────
--
-- La auditoría de 3E-B encontró que decide_operation_request autorizaba TODOS
-- los kinds con un único permiso: can_confirm_reservations. O sea que una
-- recepcionista con permiso de reservas también podía gestionar y descartar
-- consultas inmobiliarias.
--
-- Y ese permiso, en su propia UI, dice literalmente:
--
--     "Confirmar reservas — Puede confirmar y gestionar reservas"
--
-- No habla de consultas. Autorizarlas con él era una brecha semántica, no una
-- decisión de producto.
--
-- ── POR QUÉ DEFAULT false Y NO BACKFILL ─────────────────────────────────────
--
-- can_confirm_reservations tiene DEFAULT true (viene de la migración
-- 20260711000001). Este permiso nuevo arranca en false, a propósito y con dos
-- consecuencias que conviene decir en voz alta:
--
--   1. Las recepcionistas existentes que hoy pueden decidir consultas dejan de
--      poder. Eso NO es un efecto colateral: es exactamente la brecha que se
--      está cerrando. El owner las habilita de nuevo, una por una, desde
--      Ajustes → Usuarios, tomando una decisión explícita.
--
--   2. No se copia el valor de can_confirm_reservations. Hacerlo sería usarlo
--      como fallback, que es justo lo que la fase prohíbe: dejaría el permiso
--      nuevo con el significado del viejo y la brecha seguiría abierta, solo
--      escrita de otra forma.
--
-- Los owners no dependen de esta columna: la RPC los autoriza por rol.
--
-- ── DÓNDE NO HAY QUE TOCAR NADA ─────────────────────────────────────────────
--
-- Los permisos NO viajan en el JWT. custom_access_token_hook solo publica
-- user_type, tenant_id, role y workspace_ids; requireTenantContext lee los
-- can_* de tenant_users en cada request. Así que agregar un permiso no
-- invalida sesiones ni exige re-login, y el hook no se modifica.
--
-- Tampoco hacen falta cambios de RLS: la columna se lee dentro de
-- decide_operation_request (SECURITY DEFINER) y por las policies que ya
-- existen sobre tenant_users.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tenant_users
  ADD COLUMN IF NOT EXISTS can_manage_inquiries BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenant_users.can_manage_inquiries IS
  'Fase 3E-B1 — permite gestionar o descartar consultas recibidas '
  '(operation_requests con kind = inquiry: property_inquiry y '
  'monthly_rental_inquiry). Deliberadamente independiente de '
  'can_confirm_reservations, que es solo para reservas: usarlo para consultas '
  'era la brecha semántica que esta fase cierra. DEFAULT false — habilitación '
  'explícita por parte del owner, sin backfill desde el permiso de reservas. '
  'Los owners no lo necesitan: se autorizan por rol.';

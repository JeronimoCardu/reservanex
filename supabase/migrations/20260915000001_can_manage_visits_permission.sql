-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-B2 — permiso propio para gestionar visitas
-- ════════════════════════════════════════════════════════════════════════════
--
-- Completa el trabajo que empezó 3E-B1. Ahí se cerró la brecha de las consultas
-- y se dejó `visit_request` autorizándose con can_confirm_reservations como
-- LEGACY DOCUMENTADO, anotando que su migración pertenecía a esta fase.
--
-- Acá se cierra: agendar una visita deja de depender del permiso de reservas.
--
-- Mismo criterio que can_manage_inquiries: DEFAULT false, sin backfill desde
-- can_confirm_reservations. Copiarlo sería usarlo como fallback y la brecha
-- seguiría abierta, solo escrita de otra forma. El owner habilita a cada
-- recepcionista de forma explícita desde Ajustes → Usuarios.
--
-- Los permisos NO viajan en el JWT (el hook solo publica user_type, tenant_id,
-- role y workspace_ids; requireTenantContext los lee de tenant_users en cada
-- request), así que agregar uno no invalida sesiones ni exige re-login.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tenant_users
  ADD COLUMN IF NOT EXISTS can_manage_visits BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenant_users.can_manage_visits IS
  'Fase 3E-B2 — permite agendar, reagendar, completar o cancelar visitas '
  '(operation_requests con kind = visit_request, y las property_visits que '
  'resultan). Deliberadamente independiente de can_confirm_reservations: hasta '
  '3E-B2 ese permiso autorizaba visitas por herencia, que era la última brecha '
  'semántica abierta. DEFAULT false — habilitación explícita, sin backfill. '
  'Los owners no lo necesitan: se autorizan por rol.';

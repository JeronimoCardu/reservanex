-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C2 — permiso propio para reservas de mesa
-- ════════════════════════════════════════════════════════════════════════════
--
-- Cierra el anteúltimo legacy de autorización. Hasta acá table_request se
-- autorizaba con can_confirm_reservations, y en gastronomía eso era peor que en
-- inmobiliaria: ese permiso se llama "Confirmar reservas — Puede confirmar y
-- gestionar reservas" y gobierna reservas de alquiler temporal, bloqueos de
-- disponibilidad, pagos y recibos. Un tenant gastronómico NO TIENE nada de eso.
-- O sea que el permiso que habilitaba tomar una reserva de mesa estaba definido
-- en términos de un módulo que ese tenant nunca va a usar.
--
-- Mismo criterio que can_manage_inquiries (3E-B1) y can_manage_visits (3E-B2):
-- DEFAULT false, sin backfill desde can_confirm_reservations. Copiarlo sería
-- usarlo como fallback y la brecha seguiría abierta, solo escrita de otra forma.
--
-- Los permisos NO viajan en el JWT (el hook publica user_type, tenant_id, role
-- y workspace_ids; requireTenantContext los lee de tenant_users en cada
-- request), así que agregar uno no invalida sesiones.
--
-- NO se agrega can_manage_orders: los pedidos quedan bloqueados hasta que
-- exista catálogo, pricing y carrito. order_request sigue siendo el ÚLTIMO
-- legacy de este mapa, y está documentado como tal.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tenant_users
  ADD COLUMN IF NOT EXISTS can_manage_table_reservations BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenant_users.can_manage_table_reservations IS
  'Fase 3E-C2 — permite confirmar, editar, completar, cancelar o marcar '
  'ausencia en reservas de mesa (operation_requests con kind = table_request, y '
  'las table_reservations que resultan). Independiente de '
  'can_confirm_reservations, que es de alquiler temporal y no aplica a un '
  'tenant gastronómico. DEFAULT false, sin backfill. Los owners no lo '
  'necesitan: se autorizan por rol.';

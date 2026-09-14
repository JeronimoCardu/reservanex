-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3B0 — permiso propio para los pedidos gastronómicos
-- ════════════════════════════════════════════════════════════════════════════
--
-- Cierra el ÚLTIMO legacy del mapa de autorización. Hasta acá order_request caía
-- en el ELSE de decide_operation_request y se autorizaba con
-- can_confirm_reservations, que es el permiso de alquiler temporal: se llama
-- "Confirmar reservas — Puede confirmar y gestionar reservas" y gobierna
-- reservas temporales, bloqueos de disponibilidad, pagos y recibos. Un tenant
-- gastronómico NO TIENE nada de eso.
--
-- Y no era teórico: /dashboard/requests es TRANSVERSAL —una bandeja de
-- solicitudes sirve a los dos rubros— así que una recepcionista gastronómica con
-- can_confirm_reservations podía decidir un pedido sin que nadie se lo hubiera
-- concedido. Que la materialización de pedidos todavía no exista no lo vuelve
-- inocuo: la solicitud pasa a 'confirmed' y esa decisión queda registrada con su
-- nombre.
--
-- Mismo criterio que los cuatro anteriores (can_manage_inquiries 3E-B1,
-- can_manage_visits 3E-B2, can_manage_table_reservations 3E-C2,
-- can_manage_menu 3E-C3A1): DEFAULT false y SIN backfill.
--
-- En particular NO se hace can_manage_orders = can_confirm_reservations.
-- Copiarlo sería usar el legacy como fallback y dejar la brecha abierta escrita
-- de otra forma — exactamente lo que esta migración viene a cerrar. Son dominios
-- distintos: despachar pedidos no es confirmar alquileres.
--
-- Tampoco cuelga de can_manage_menu: administrar el catálogo es una decisión
-- COMERCIAL (fija precios) y despachar pedidos es OPERACIÓN diaria. Quien atiende
-- la cocina no necesariamente fija la carta.
--
-- Los permisos NO viajan en el JWT (el hook publica user_type, tenant_id, role y
-- workspace_ids; requireTenantContext los lee de tenant_users en cada request),
-- así que agregar uno no invalida sesiones.
--
-- Sin datos que migrar: auditado antes de aplicar esto, el proyecto tiene 0
-- submissions con intent='food_order' y 0 operation_requests con
-- kind='order_request'.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tenant_users
  ADD COLUMN IF NOT EXISTS can_manage_orders BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenant_users.can_manage_orders IS
  'Fase 3E-C3B0 — permite aceptar y rechazar operation_requests de kind '
  'order_request, y en el futuro gobernará el ciclo de vida de las órdenes y el '
  'dashboard de pedidos. NO gobierna el catálogo: eso es can_manage_menu. '
  'Independiente de can_confirm_reservations, que es de alquiler temporal. '
  'DEFAULT false, sin backfill. Los owners no lo necesitan: se autorizan por rol.';

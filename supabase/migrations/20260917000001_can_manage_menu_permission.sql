-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3A1 — permiso propio para el catálogo gastronómico
-- ════════════════════════════════════════════════════════════════════════════
--
-- Administrar la carta es una decisión COMERCIAL: fija precios. No es lo mismo
-- que la operación diaria del salón, y por eso no cuelga de ninguno de los
-- permisos que ya existen:
--
--   can_create_properties          es inmobiliario en el nombre y en el uso —
--                                  ya gobierna las policies de storage de
--                                  property-images. Que "puede crear
--                                  propiedades" habilitara editar precios de un
--                                  restaurante es el mismo error de herencia
--                                  que 3E-B1, 3E-B2 y 3E-C2 vinieron
--                                  desarmando permiso por permiso.
--
--   can_manage_table_reservations  es una agenda operacional. Quien atiende el
--                                  teléfono y confirma mesas no necesariamente
--                                  fija precios.
--
--   can_confirm_reservations       es alquiler temporal. Un tenant
--                                  gastronómico no tiene nada de eso.
--
-- Mismo criterio que los tres anteriores: DEFAULT false, SIN backfill desde
-- ningún otro permiso. Copiar un valor existente sería usarlo como fallback y
-- dejar la brecha abierta, solo escrita de otra forma.
--
-- Los permisos NO viajan en el JWT (el hook publica user_type, tenant_id, role
-- y workspace_ids; requireTenantContext los lee de tenant_users en cada
-- request), así que agregar uno no invalida sesiones.
--
-- NO se agrega can_manage_orders: el carrito y los pedidos no existen todavía.
-- order_request sigue siendo el ÚLTIMO legacy del mapa de autorización, y esta
-- fase no lo toca.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tenant_users
  ADD COLUMN IF NOT EXISTS can_manage_menu BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenant_users.can_manage_menu IS
  'Fase 3E-C3A1 — permite administrar el catálogo gastronómico: crear, '
  'renombrar, activar/desactivar y ordenar categorías; crear, editar, '
  'publicar/despublicar, marcar disponible/no disponible, ordenar, archivar y '
  'restaurar items. Independiente de can_create_properties (inmobiliario) y de '
  'can_manage_table_reservations (agenda operacional, no decisión comercial). '
  'DEFAULT false, sin backfill. Los owners no lo necesitan: se autorizan por '
  'rol. No cubre imágenes: no existen todavía (3E-C3A2).';

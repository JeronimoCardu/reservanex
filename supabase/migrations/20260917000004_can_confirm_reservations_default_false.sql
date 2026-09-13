-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3A1 — cierre del default legacy de can_confirm_reservations
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL PROBLEMA ─────────────────────────────────────────────────────────────
--
-- can_confirm_reservations nació con DEFAULT true en 20260711000001, cuando era
-- el único permiso operativo y el producto era solo inmobiliario. Todos los que
-- vinieron después nacen en false:
--
--   can_access_settings            false
--   can_assign_conversations       false
--   can_create_properties          false
--   can_manage_inquiries           false   (3E-B1)
--   can_manage_visits              false   (3E-B2)
--   can_manage_table_reservations  false   (3E-C2)
--   can_manage_menu                false   (3E-C3A1)
--   can_confirm_reservations       TRUE    ← el único
--
-- Y el único camino de producción que crea un tenant_users
-- (users.repository.ts → createTenantUser) inserta solo
-- {id, tenant_id, name, email, role, active}: OMITE todas las columnas can_*.
-- O sea que cada recepcionista invitada nace con esa capacidad concedida y
-- ninguna otra, sin que nadie la haya elegido.
--
-- ── POR QUÉ NO ES INOCUO ────────────────────────────────────────────────────
--
-- Para un tenant gastronómico se podría pensar que da igual, porque los módulos
-- inmobiliarios no existen para él. Es falso, y esta es la parte que importa:
--
--   decide_operation_request mapea order_request → can_confirm_reservations
--   (legacy, mientras no exista can_manage_orders), y /dashboard/requests es
--   TRANSVERSAL: no está gateado por rubro, porque una bandeja de solicitudes
--   sirve a los dos. Así que una recepcionista gastronómica recién creada puede
--   confirmar un order_request hoy mismo, sin que nadie se lo haya dado.
--
-- Que todavía no exista materialización de pedidos no lo vuelve inocuo: la
-- solicitud pasa a 'confirmed' y esa decisión queda registrada con su nombre.
--
-- ── QUÉ CAMBIA Y QUÉ NO ─────────────────────────────────────────────────────
--
-- Solo el DEFAULT de la columna. NO hay UPDATE, NO hay backfill: las filas
-- existentes conservan exactamente el valor que tienen. Auditado antes de
-- aplicar esto — las 3 filas del proyecto tienen can_confirm_reservations = true
-- y lo van a seguir teniendo.
--
-- Afecta ÚNICAMENTE a los tenant_users nuevos.
--
-- ── POR QUÉ ES SEGURO (auditoría, no intuición) ─────────────────────────────
--
-- Se revisaron todos los consumidores de la columna. Ninguno depende del
-- DEFAULT: todos leen el VALOR de la fila, en el request o en SQL.
--
--   · requireTenantContext lee la columna por request (los permisos no viajan
--     en el JWT), así que no hay sesiones que revalidar.
--   · las RPC leen v_member.can_confirm_reservations de la fila.
--   · la única policy de RLS que la usa
--     (receptionist_confirm_property_availability_blocks) lee la columna.
--   · los validadores que crean recepcionistas la setean EXPLÍCITAMENTE
--     (decisions, inquiries, visits, table-reservations, menu-catalog); los del
--     worker crean OWNERS, que se autorizan por rol y no miran la columna.
--
-- ── CONSECUENCIA ACEPTADA ───────────────────────────────────────────────────
--
-- Una recepcionista nueva nace ahora SIN ningún permiso, en los dos rubros, y el
-- diálogo de creación no ofrece permisos: hay que abrir "Permisos" y
-- concederlos. Es un paso más en el onboarding inmobiliario, y es deliberado —
-- una capacidad operativa se concede, no se hereda por accidente.
--
-- NO se toca la autorización por kind. order_request sigue siendo el último
-- legacy del mapa y lo cierra la fase de carrito/pedidos, con su propio permiso.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tenant_users
  ALTER COLUMN can_confirm_reservations SET DEFAULT false;

COMMENT ON COLUMN public.tenant_users.can_confirm_reservations IS
  'Permite confirmar y gestionar reservas de alquiler temporal, bloqueos de '
  'disponibilidad, pagos y recibos; y, como LEGACY, decidir operation_requests '
  'de kind reservation_request y order_request. '
  'Fase 3E-C3A1: el DEFAULT pasó de true a false. Nació en true en '
  '20260711000001, cuando era el único permiso operativo y el producto era solo '
  'inmobiliario, y quedó como el único con ese default. Como createTenantUser '
  'omite todas las columnas can_*, cada recepcionista nueva lo recibía concedido '
  'sin que nadie lo eligiera — y eso NO era inocuo en gastronomía, porque '
  'order_request se autoriza con este permiso y /dashboard/requests es '
  'transversal. Sin backfill: las filas existentes conservan su valor.';

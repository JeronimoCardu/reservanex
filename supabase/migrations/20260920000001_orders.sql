-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3C — orders + order_items: el pedido OPERACIONAL
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── AUDITORÍA PREVIA (§1) ───────────────────────────────────────────────────
--
-- Verificado contra la base antes de escribir esto: 0 tablas orders/order_items,
-- 0 operation_requests kind='order_request', 0 form_submissions intent
-- 'food_order'. No hay nada que migrar y ningún pedido real que romper.
--
-- El patrón se copia de table_reservations (3E-C2) y property_visits (3E-B2),
-- que son las dos entidades operacionales más recientes: TEXT + CHECK para el
-- estado, CHECK de coherencia estado↔marcas, pares <verbo>_at/<verbo>_by,
-- guard de tenant por trigger, set_updated_at, audit_table_change, RLS de solo
-- lectura y REVOKE explícito de los grants que Supabase pone por default.
--
-- ── LA DISTINCIÓN QUE JUSTIFICA LA TABLA (§1 de la fase) ────────────────────
--
--   operation_request  = lo que el cliente PIDIÓ y la empresa aceptó o rechazó
--   order              = el trabajo OPERACIONAL que la empresa se comprometió
--                        a hacer, con su propio ciclo de vida
--
-- Por eso order.status NO tiene 'pending': un pedido nace cuando la empresa
-- ACEPTA, y nace ya 'confirmed'. Lo que está pendiente de decisión es la
-- solicitud, no el pedido — y eso ya lo modela operation_requests.status.
--
-- Y por eso 'rejected' no existe acá: rechazar es no crear nunca el pedido.
-- 'cancelled' es distinto — la empresa lo aceptó y después lo dio de baja.
--
-- ── TODO ES SNAPSHOT (§5, §10) ──────────────────────────────────────────────
--
-- El pedido se materializa EXCLUSIVAMENTE desde operation_requests
-- .payload_snapshot, que a su vez lo escribió el servidor en C3B1 leyendo el
-- catálogo en el momento del pedido. Acá NO se vuelve a consultar menu_items:
-- el precio y el nombre ya están congelados, y el catálogo pudo cambiar.
--
-- menu_item_id se conserva igual, como vínculo histórico — sirve para saber qué
-- producto era— pero NO es de dónde se lee el nombre ni el precio para mostrar
-- un pedido.
-- ════════════════════════════════════════════════════════════════════════════

-- ── orders ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.orders (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  contact_id                  UUID NOT NULL REFERENCES public.contacts(id),

  -- Una solicitud produce COMO MÁXIMO un pedido. La garantía es esta UNIQUE, no
  -- un SELECT previo: sobrevive a reintentos y a dos empleados aceptando a la
  -- vez. ON DELETE RESTRICT porque un pedido sin su solicitud de origen sería
  -- evidencia huérfana — el camino para borrarlo es borrar el tenant.
  source_operation_request_id UUID NOT NULL UNIQUE
                                   REFERENCES public.operation_requests(id) ON DELETE RESTRICT,

  status                      TEXT NOT NULL DEFAULT 'confirmed',

  -- ── Snapshots del payload. NO se leen de menu_items ni de tenants ─────────
  fulfillment                 TEXT NOT NULL,
  delivery_address_snapshot   TEXT,
  payment_method              TEXT NOT NULL,
  currency                    TEXT NOT NULL,
  subtotal                    NUMERIC(14,2) NOT NULL,
  notes                       TEXT,

  -- ── Actores y momentos ───────────────────────────────────────────────────
  --
  -- confirmed_at es NOT NULL: un pedido siempre nace de una aceptación, y ese
  -- instante es parte de la evidencia.
  --
  -- confirmed_by es NULLABLE, y es una desviación deliberada de la
  -- especificación de la fase. Motivo: en este proyecto TODAS las columnas de
  -- actor son nullable con ON DELETE SET NULL (reservations, property_visits,
  -- table_reservations, operation_requests.decided_by, tasks, notes…). NOT NULL
  -- es incompatible con SET NULL, y la alternativa —RESTRICT— haría que un
  -- pedido histórico bloqueara para siempre el borrado de quien lo aceptó, algo
  -- que admin_purge_tenant hace hoy al purgar un tenant.
  --
  -- El invariante "siempre se registra quién aceptó" lo garantiza la RPC de
  -- materialización, que escribe confirmed_by con auth.uid() y nunca NULL.
  confirmed_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,

  preparing_at                TIMESTAMPTZ,
  preparing_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  ready_at                    TIMESTAMPTZ,
  ready_by                    UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  completed_at                TIMESTAMPTZ,
  completed_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  cancelled_at                TIMESTAMPTZ,
  cancelled_by                UUID REFERENCES public.tenant_users(id) ON DELETE SET NULL,
  cancellation_reason         TEXT,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_status_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
      CHECK (status IN ('confirmed', 'preparing', 'ready', 'completed', 'cancelled'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_fulfillment_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_fulfillment_check
      CHECK (fulfillment IN ('delivery', 'takeaway'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_payment_method_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IN ('cash', 'transfer', 'card'));
  END IF;

  -- §3 — la moneda se valida por FORMA, no contra una lista. tenants.currency
  -- no tiene CHECK y el alta de tenant la acepta como cualquier string de 3
  -- caracteres, así que un tenant en CLP existe y tiene que poder tener
  -- pedidos. Cerrar esa inconsistencia es otra fase; acá NO se toca.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_currency_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_currency_check
      CHECK (char_length(btrim(currency)) = 3);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_subtotal_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_subtotal_check
      CHECK (subtotal >= 0);
  END IF;

  -- §4 — coherencia entrega ↔ dirección. Un delivery sin dirección y un
  -- takeaway CON dirección son los dos estados contradictorios que el
  -- formulario público ya rechaza; acá se vuelven imposibles también en la base.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_address_coherence_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_address_coherence_check
      CHECK (
        (fulfillment = 'delivery' AND delivery_address_snapshot IS NOT NULL
                                  AND char_length(btrim(delivery_address_snapshot)) > 0) OR
        (fulfillment = 'takeaway' AND delivery_address_snapshot IS NULL)
      );
  END IF;

  -- §14/§15 — coherencia estado ↔ marcas.
  --
  -- Las marcas históricas NO se borran al avanzar: un pedido 'ready' conserva su
  -- preparing_at. Por eso el CHECK exige la marca del estado ACTUAL y de los
  -- anteriores del camino, y prohíbe las de estados que todavía no ocurrieron.
  --
  -- 'cancelled' es aparte: se puede llegar desde confirmed, preparing o ready,
  -- así que solo se exige cancelled_at y se prohíbe completed_at.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_lifecycle_coherence_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_lifecycle_coherence_check
      CHECK (
        (status = 'confirmed' AND preparing_at IS NULL     AND ready_at IS NULL
                              AND completed_at IS NULL     AND cancelled_at IS NULL) OR
        (status = 'preparing' AND preparing_at IS NOT NULL AND ready_at IS NULL
                              AND completed_at IS NULL     AND cancelled_at IS NULL) OR
        (status = 'ready'     AND preparing_at IS NOT NULL AND ready_at IS NOT NULL
                              AND completed_at IS NULL     AND cancelled_at IS NULL) OR
        (status = 'completed' AND preparing_at IS NOT NULL AND ready_at IS NOT NULL
                              AND completed_at IS NOT NULL AND cancelled_at IS NULL) OR
        (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
      );
  END IF;

  -- §16 — el motivo de cancelación es OPCIONAL, pero si llega no puede ser
  -- espacios. Mismo límite que decision_notes y las reservas de mesa.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_cancellation_reason_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_cancellation_reason_check
      CHECK (cancellation_reason IS NULL OR
             (char_length(btrim(cancellation_reason)) > 0 AND char_length(cancellation_reason) <= 500));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_notes_check'
                 AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_notes_check
      CHECK (notes IS NULL OR char_length(notes) <= 1000);
  END IF;
END $$;

-- La lista del dashboard filtra por estado y ordena por más reciente.
CREATE INDEX IF NOT EXISTS idx_orders_tenant_status_created
  ON public.orders (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_tenant_created
  ON public.orders (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_contact
  ON public.orders (tenant_id, contact_id);

-- ── order_items ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.order_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,

  -- Vínculo histórico al producto. ON DELETE RESTRICT: un producto que alguna
  -- vez se vendió no se borra de la base — el dashboard lo archiva con
  -- deleted_at, que es soft delete y no toca esta FK.
  menu_item_id        UUID NOT NULL REFERENCES public.menu_items(id) ON DELETE RESTRICT,

  -- §10 — lo que se MUESTRA sale de acá, no de menu_items.
  name_snapshot       TEXT NOT NULL,
  unit_price_snapshot NUMERIC(14,2) NOT NULL,
  quantity            INTEGER NOT NULL,
  line_total          NUMERIC(14,2) NOT NULL,
  notes               TEXT,

  -- §5 — la POSICIÓN en el array del snapshot. Es lo que permite que dos líneas
  -- del mismo producto se distingan y se muestren en el orden en que el cliente
  -- las armó.
  sort_order          INTEGER NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NO hay UNIQUE(order_id, menu_item_id), y es el punto (§6 de las decisiones):
-- "Muzzarella sin cebolla" y "Muzzarella sin aceitunas" son dos líneas del mismo
-- producto, y consolidarlas perdería justo lo que las distingue.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_quantity_check'
                 AND conrelid='public.order_items'::regclass) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_quantity_check
      CHECK (quantity >= 1 AND quantity <= 99);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_unit_price_check'
                 AND conrelid='public.order_items'::regclass) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_unit_price_check
      CHECK (unit_price_snapshot >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_line_total_check'
                 AND conrelid='public.order_items'::regclass) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_line_total_check
      CHECK (line_total >= 0);
  END IF;

  -- La aritmética de la línea, garantizada por la base. No depende de que quien
  -- inserte se acuerde de multiplicar bien.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_line_math_check'
                 AND conrelid='public.order_items'::regclass) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_line_math_check
      CHECK (line_total = unit_price_snapshot * quantity);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_sort_order_check'
                 AND conrelid='public.order_items'::regclass) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_sort_order_check
      CHECK (sort_order >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_name_snapshot_check'
                 AND conrelid='public.order_items'::regclass) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_name_snapshot_check
      CHECK (char_length(btrim(name_snapshot)) > 0 AND char_length(name_snapshot) <= 120);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_items_notes_check'
                 AND conrelid='public.order_items'::regclass) THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_notes_check
      CHECK (notes IS NULL OR char_length(notes) <= 300);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON public.order_items (order_id, sort_order);

-- ── Coherencia de tenant, garantizada por la base (§6 de la fase) ───────────
--
-- Las FK garantizan que el contacto y la solicitud EXISTEN, no que sean del
-- MISMO tenant. Mismo criterio que guard_table_reservation_tenant.

CREATE OR REPLACE FUNCTION public.guard_order_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = NEW.contact_id AND c.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'El contacto % no pertenece al tenant %', NEW.contact_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.operation_requests o
    WHERE o.id = NEW.source_operation_request_id
      AND o.tenant_id = NEW.tenant_id
      AND o.kind = 'order_request'
  ) THEN
    RAISE EXCEPTION 'La solicitud % no es un pedido del tenant %',
      NEW.source_operation_request_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_order_tenant ON public.orders;
CREATE TRIGGER trg_guard_order_tenant
  BEFORE INSERT OR UPDATE OF tenant_id, contact_id, source_operation_request_id
  ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_tenant();

-- El producto de una línea tiene que ser del MISMO tenant que el pedido.
--
-- Lo que NO se exige, a propósito (§6): que siga publicado, disponible, sin
-- archivar, ni que su categoría esté activa. El catálogo puede haber cambiado
-- entre el pedido del cliente y la aceptación de la empresa, y eso no puede
-- impedir materializar lo que ya se acordó. El snapshot congeló nombre y precio;
-- de menu_items solo importa que exista y sea del tenant correcto.
CREATE OR REPLACE FUNCTION public.guard_order_item_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_order_tenant UUID;
BEGIN
  SELECT o.tenant_id INTO v_order_tenant
  FROM public.orders o WHERE o.id = NEW.order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El pedido % no existe', NEW.order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.menu_items mi
    WHERE mi.id = NEW.menu_item_id AND mi.tenant_id = v_order_tenant
  ) THEN
    RAISE EXCEPTION 'El producto % no pertenece al tenant del pedido %',
      NEW.menu_item_id, NEW.order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_order_item_tenant ON public.order_items;
CREATE TRIGGER trg_guard_order_item_tenant
  BEFORE INSERT OR UPDATE OF order_id, menu_item_id
  ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_item_tenant();

DROP TRIGGER IF EXISTS set_orders_updated_at ON public.orders;
CREATE TRIGGER set_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- §11 — mismo sistema de auditoría que reservations, operation_requests,
-- property_visits y table_reservations.
DROP TRIGGER IF EXISTS trg_audit_orders ON public.orders;
CREATE TRIGGER trg_audit_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

DROP TRIGGER IF EXISTS trg_audit_order_items ON public.order_items;
CREATE TRIGGER trg_audit_order_items
  AFTER INSERT OR UPDATE OR DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

-- ── RLS (§12) ───────────────────────────────────────────────────────────────
--
-- SELECT tenant-scoped. INSERT/UPDATE/DELETE: NADIE, ni el owner. Toda mutación
-- pasa por las RPC SECURITY DEFINER, que revalidan permiso, estado y transición.
-- Si el browser pudiera escribir, podría fabricar un pedido sin solicitud,
-- saltarse una transición o poner un confirmed_by que no es quien aceptó.

ALTER TABLE public.orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_select_orders ON public.orders;
CREATE POLICY tenant_select_orders
  ON public.orders
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS sa_imp_select_orders ON public.orders;
CREATE POLICY sa_imp_select_orders
  ON public.orders
  FOR SELECT TO authenticated
  USING (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());

-- order_items no tiene tenant_id propio: se alcanza por su pedido. Las dos
-- policies espejan exactamente lo que orders concede.
DROP POLICY IF EXISTS tenant_select_order_items ON public.order_items;
CREATE POLICY tenant_select_order_items
  ON public.order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_items.order_id AND o.tenant_id = public.auth_tenant_id()
  ));

DROP POLICY IF EXISTS sa_imp_select_order_items ON public.order_items;
CREATE POLICY sa_imp_select_order_items
  ON public.order_items
  FOR SELECT TO authenticated
  USING (public.is_super_admin() AND EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_items.order_id AND o.tenant_id = public.auth_impersonating_tenant_id()
  ));

-- ── Grants reales (§12) ─────────────────────────────────────────────────────
--
-- Supabase otorga INSERT/UPDATE/DELETE a anon y authenticated en toda tabla
-- nueva de public vía ALTER DEFAULT PRIVILEGES. RLS los frena hoy, pero
-- apoyarse solo en eso significa que el día que alguien agregue una policy el
-- grant ya está puesto.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.orders      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.order_items FROM authenticated;
REVOKE ALL ON TABLE public.orders      FROM anon;
REVOKE ALL ON TABLE public.order_items FROM anon;
GRANT SELECT ON TABLE public.orders      TO authenticated;
GRANT SELECT ON TABLE public.order_items TO authenticated;

COMMENT ON TABLE public.orders IS
  'Fase 3E-C3C: el pedido OPERACIONAL, que nace únicamente cuando la empresa '
  'ACEPTA un operation_request kind=order_request. Por eso status no tiene '
  '"pending": lo pendiente es la solicitud, no el pedido. "rejected" tampoco '
  'existe acá — rechazar es no crear nunca un pedido; "cancelled" es haberlo '
  'aceptado y después darlo de baja. Todos los datos comerciales son SNAPSHOT '
  'del payload de la solicitud: acá NO se consulta menu_items ni tenants.';

COMMENT ON COLUMN public.orders.confirmed_by IS
  'Fase 3E-C3C: quién aceptó la solicitud. Nullable con ON DELETE SET NULL como '
  'todas las columnas de actor del proyecto — NOT NULL sería incompatible con '
  'SET NULL y RESTRICT bloquearía el borrado del usuario. Que siempre se escriba '
  'lo garantiza la RPC de materialización, que usa auth.uid().';

COMMENT ON COLUMN public.orders.currency IS
  'Fase 3E-C3C: snapshot exacto de la moneda del payload. Se valida por FORMA '
  '(3 caracteres) y no contra un enum, porque tenants.currency no tiene CHECK y '
  'admite cualquier código de 3: un tenant así existe y tiene que poder operar.';

COMMENT ON TABLE public.order_items IS
  'Fase 3E-C3C: las líneas del pedido, congeladas. SIN unique por producto: dos '
  'líneas del mismo menu_item con notas distintas son dos pedidos distintos de '
  'ese producto. sort_order conserva la posición del array del snapshot. La UI '
  'muestra name_snapshot/unit_price_snapshot, NUNCA menu_items.';

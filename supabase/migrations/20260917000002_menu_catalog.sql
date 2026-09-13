-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3A1 — catálogo gastronómico base
-- ════════════════════════════════════════════════════════════════════════════
--
-- La fuente canónica de qué vende un tenant gastronómico y a cuánto. Es lo que
-- la fase del carrito va a consultar para resolver precios SIN confiar en el
-- browser: el cliente va a mandar identificadores y cantidades, y el servidor
-- va a leer base_price de acá.
--
-- ── POR QUÉ menu_items Y NO products ────────────────────────────────────────
--
-- No existe una tabla de catálogo genérica en el repo, y no se crea una ahora.
-- Las verticales de ReservaNex no comparten reglas: una propiedad tiene
-- operation_type, commercial_status, pricing_mode, mínimo de noches y
-- disponibilidad por fechas; un plato tiene precio y punto. Un `products`
-- genérico sería una tabla con la unión de dos dominios y la intersección de
-- ninguno.
--
-- ── LO QUE NO TIENE V1, Y POR QUÉ ───────────────────────────────────────────
--
-- SIN variantes. "Pizza Muzzarella Chica" y "Pizza Muzzarella Grande" son dos
-- menu_items. El costo es carga de datos, una vez, del lado del dueño. El costo
-- de la alternativa es permanente y cae justo en la ruta de pricing: el precio
-- dejaría de ser un campo y pasaría a ser una resolución. Y agregarlas después
-- es puramente ADITIVO (tabla nueva + FK nullable), porque el snapshot del
-- pedido va a congelar nombre y precio unitario ya resueltos.
--
-- SIN modificadores con precio. Las observaciones por línea ("sin cebolla") son
-- texto y NUNCA alteran el precio. El día que "extra queso" tenga que costar
-- $1.000, eso es una entidad con su propio delta, no un texto libre que alguien
-- lee y suma a mano. Confundirlas es cómo un sistema de pedidos empieza a
-- cobrar mal.
--
-- SIN composición de combos. Un combo es un menu_item con su propio precio. La
-- composición real solo se paga sola cuando hay que descontar stock por
-- componente o sustituir uno, y ninguna de las dos cosas existe.
--
-- SIN stock. `available` es un booleano operacional: no tiene cantidades, ni
-- descuento por pedido, ni reposición. Inventario sería otra fase con otro
-- modelo.
--
-- SIN imágenes. image_url / image_storage_path llegan en 3E-C3A2 junto con el
-- bucket, las policies, el upload, el delete y la purga de tenant. No se dejan
-- columnas preparatorias sin escritor ni lector: este mismo repo tiene el
-- contraejemplo en el schema `items` de food_order, escrito "para que 3B+ no
-- tenga que migrar" y que terminó siendo una forma equivocada que hay que tirar.
--
-- SIN currency por item. Vive en tenants.currency, que existe desde
-- 20260828000001 documentada como metadata sin consumidor — igual que
-- tenants.timezone antes de 3E-B2. Un restaurante no cobra la pizza en pesos y
-- la cerveza en dólares, y permitirlo pondría un carrito multi-moneda sin
-- cotización.
-- ════════════════════════════════════════════════════════════════════════════


-- ── menu_categories ─────────────────────────────────────────────────────────
--
-- Entidad propia y no un TEXT libre en el item, por tres cosas concretas que un
-- menú necesita y que el texto libre no puede dar: ORDEN (un menú se lee
-- Entradas → Principales → Postres), RENOMBRAR en un solo lugar, y APAGAR la
-- categoría entera. Con texto libre, además, "Bebidas" / "bebidas" / "Bebidas "
-- serían tres categorías fantasma.

CREATE TABLE IF NOT EXISTS public.menu_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,

  -- Sin deleted_at: `active=false` ES el mecanismo de desactivación, y es
  -- reversible. Una categoría inactiva sigue existiendo y CONSERVA sus items
  -- con su published/available intactos; simplemente no se va a renderizar en
  -- el menú público. No hay DELETE desde el dashboard.
  active      BOOLEAN NOT NULL DEFAULT true,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_categories_name_check'
                 AND conrelid='public.menu_categories'::regclass) THEN
    ALTER TABLE public.menu_categories ADD CONSTRAINT menu_categories_name_check
      CHECK (length(btrim(name)) > 0 AND length(name) <= 60);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_categories_sort_order_check'
                 AND conrelid='public.menu_categories'::regclass) THEN
    ALTER TABLE public.menu_categories ADD CONSTRAINT menu_categories_sort_order_check
      CHECK (sort_order >= 0);
  END IF;
END $$;

-- ── Unicidad semántica dentro del tenant ────────────────────────────────────
--
-- "Bebidas", " bebidas " y "BEBIDAS" son la MISMA categoría para quien lee el
-- menú, así que tienen que serlo para la base. Postgres no acepta una
-- expresión en un UNIQUE constraint de tabla, pero sí en un UNIQUE INDEX
-- funcional, que da exactamente la misma garantía y el mismo error 23505.
--
-- La normalización es lower(btrim(...)): el mismo par de funciones que ya usan
-- los CHECK de este repo. Deliberadamente NO se normaliza lo que se GUARDA —
-- el dueño escribió "Bebidas" y eso es lo que ve. Se normaliza para comparar.
--
-- Es tenant-scoped: dos tenants distintos pueden tener cada uno su "Bebidas".
--
-- Incluye las inactivas a propósito. Si "Bebidas" está desactivada, el camino
-- correcto es reactivarla, no crear una segunda que después conviva con la
-- primera cuando alguien la vuelva a encender.
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_categories_tenant_name_normalized
  ON public.menu_categories (tenant_id, lower(btrim(name)));

-- El dashboard lista las categorías de un tenant en su orden.
CREATE INDEX IF NOT EXISTS idx_menu_categories_tenant_sort
  ON public.menu_categories (tenant_id, sort_order);

COMMENT ON TABLE public.menu_categories IS
  'Fase 3E-C3A1: agrupador ordenado del catálogo gastronómico (Entradas, '
  'Pizzas, Bebidas). Sin description y sin published: una categoría no es un '
  'objeto público en sí, es un agrupador — con active alcanza, y evita el '
  'estado incoherente "categoría publicada sin items publicados". Sin '
  'deleted_at: active=false es la desactivación, y es reversible.';

COMMENT ON COLUMN public.menu_categories.active IS
  'Fase 3E-C3A1: desactivar NO toca los items. Conservan su category_id, su '
  'published y su available; solo dejan de renderizarse públicamente porque su '
  'categoría no se renderiza. Totalmente reversible.';


-- ── menu_items ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.menu_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- RESTRICT y no CASCADE: borrar una categoría con items tiene que fallar.
  -- CASCADE borraría el catálogo, y el día que existan order_items arrastraría
  -- su propio RESTRICT a un error confuso a dos niveles de distancia. El camino
  -- de producto es desactivar la categoría, o mover los items y recién después
  -- borrarla vacía.
  --
  -- NOT NULL: sin categoría, el menú público no tendría dónde ubicar el item.
  category_id  UUID NOT NULL REFERENCES public.menu_categories(id) ON DELETE RESTRICT,

  name         TEXT NOT NULL,
  description  TEXT,

  -- NUMERIC(14,2), NUNCA float. La escala 2 es deliberada: el precio canónico
  -- no puede persistir fracciones monetarias arbitrarias como 1000.999.
  --
  -- NOT NULL y >= 0. Un item de menú SIEMPRE tiene precio: "consultar" no
  -- existe en una carta de la que se puede pedir (a diferencia de
  -- properties.pricing_mode='consult', que sí tiene sentido en una propiedad).
  --
  -- Y 0 significa GRATIS, no "sin precio". Es explícito porque el repo tiene el
  -- antipatrón a la vista: quote_temporary_rental replica la truthiness de JS
  -- con COALESCE(base_price_per_night, 0) <> 0, o sea que para las propiedades
  -- precio 0 significa "sin precio". Ese atajo NO se copia acá.
  base_price   NUMERIC(14,2) NOT NULL,

  -- Dos dimensiones distintas, con el precedente exacto en properties:
  -- `published` es visibilidad pública y `commercial_status` es estado
  -- operacional (20260816000001 lo documenta textualmente).
  --
  --   published  ¿existe para el público?   decisión comercial, cambia poco
  --   available  ¿se puede pedir AHORA?     operación diaria, cambia seguido
  --
  -- published DEFAULT false espeja properties.published DEFAULT false: un item
  -- a medio cargar no debe filtrarse al menú antes de tener precio.
  published    BOOLEAN NOT NULL DEFAULT false,
  available    BOOLEAN NOT NULL DEFAULT true,

  sort_order   INTEGER NOT NULL DEFAULT 0,

  -- Soft delete. A diferencia de property_visits y table_reservations —que
  -- deliberadamente NO lo tienen porque su ciclo ya incluye 'cancelled' para
  -- "esto no va a ocurrir"— un item de catálogo no tiene estado terminal: no se
  -- "cancela" una pizza, se saca de la carta. Y el día que existan order_items,
  -- su FK con ON DELETE RESTRICT necesita que la fila siga existiendo.
  deleted_at   TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_items_name_check'
                 AND conrelid='public.menu_items'::regclass) THEN
    ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_name_check
      CHECK (length(btrim(name)) > 0 AND length(name) <= 120);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_items_description_check'
                 AND conrelid='public.menu_items'::regclass) THEN
    ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_description_check
      CHECK (description IS NULL OR length(description) <= 1000);
  END IF;

  -- >= 0 y no > 0: un item gratis es real (pan de cortesía, guarnición
  -- incluida). Mismo criterio que properties.cleaning_fee CHECK (>= 0).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_items_base_price_check'
                 AND conrelid='public.menu_items'::regclass) THEN
    ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_base_price_check
      CHECK (base_price >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_items_sort_order_check'
                 AND conrelid='public.menu_items'::regclass) THEN
    ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_sort_order_check
      CHECK (sort_order >= 0);
  END IF;
END $$;

-- SIN UNIQUE sobre name: los nombres parecidos son legítimos, y las "variantes"
-- de V1 se representan justamente como items distintos con nombres que difieren
-- en una palabra ("… Chica" / "… Grande").

-- El listado del dashboard: por categoría, en su orden.
CREATE INDEX IF NOT EXISTS idx_menu_items_tenant_category_sort
  ON public.menu_items (tenant_id, category_id, sort_order);

-- El futuro menú público. Parcial porque un menú público nunca quiere
-- archivados, así que el índice no los carga.
CREATE INDEX IF NOT EXISTS idx_menu_items_tenant_published_available
  ON public.menu_items (tenant_id, published, available)
  WHERE deleted_at IS NULL;

-- ON DELETE RESTRICT sobre category_id obliga a Postgres a buscar hijos al
-- borrar una categoría. Sin un índice cuyo PRIMER campo sea category_id, eso es
-- un seq scan (el índice de arriba lo tiene en segunda posición y no sirve).
CREATE INDEX IF NOT EXISTS idx_menu_items_category
  ON public.menu_items (category_id);

COMMENT ON TABLE public.menu_items IS
  'Fase 3E-C3A1: la fuente canónica de precios del catálogo gastronómico. El '
  'browser NUNCA es autoridad de precio: la fase del carrito va a mandar '
  'identificadores y cantidades, y el servidor va a leer base_price de acá. '
  'V1 sin variantes (cada tamaño es un item), sin modificadores con precio, '
  'sin composición de combos, sin stock y sin imágenes.';

COMMENT ON COLUMN public.menu_items.base_price IS
  'Fase 3E-C3A1: NUMERIC(14,2), nunca float. Escala 2 deliberada para que el '
  'precio canónico no persista fracciones monetarias arbitrarias. La moneda NO '
  'vive acá: es tenants.currency. 0 significa GRATIS, no "sin precio".';

COMMENT ON COLUMN public.menu_items.published IS
  'Fase 3E-C3A1: visibilidad pública. Distinto de available. DEFAULT false, '
  'como properties.published: un item a medio cargar no se filtra al menú.';

COMMENT ON COLUMN public.menu_items.available IS
  'Fase 3E-C3A1: si se puede pedir AHORA. NO es stock — no tiene cantidades, '
  'ni descuento por pedido, ni reposición. published=true + available=false se '
  'va a mostrar como "No disponible", no se va a ocultar.';

COMMENT ON COLUMN public.menu_items.deleted_at IS
  'Fase 3E-C3A1: archivado, reversible (Restaurar → deleted_at=NULL). Nunca '
  'DELETE físico desde el dashboard: el día que existan order_items, su FK con '
  'ON DELETE RESTRICT necesita que esta fila siga existiendo.';


-- ── Coherencia de tenant, garantizada por la base ───────────────────────────
--
-- La FK garantiza que la categoría EXISTE, no que sea del MISMO tenant que el
-- item. Sin esto, un writer que nadie recuerde proteger podría crear un item
-- del tenant A colgado de una categoría del tenant B — ambas filas existen y la
-- FK queda contenta. Mismo criterio que trg_guard_table_reservation_tenant y
-- trg_units_tenant_consistency: la garantía vive en la base, no en el código.
--
-- Se dispara en todo INSERT y todo UPDATE (sin lista de columnas): esta es una
-- tabla de ABM donde category_id puede moverse legítimamente, y el costo es una
-- sola búsqueda por índice.
CREATE OR REPLACE FUNCTION public.guard_menu_item_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.menu_categories c
    WHERE c.id = NEW.category_id AND c.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'La categoría % no pertenece al tenant %', NEW.category_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_menu_item_tenant ON public.menu_items;
CREATE TRIGGER trg_guard_menu_item_tenant
  BEFORE INSERT OR UPDATE ON public.menu_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_item_tenant();

DROP TRIGGER IF EXISTS set_menu_categories_updated_at ON public.menu_categories;
CREATE TRIGGER set_menu_categories_updated_at
  BEFORE UPDATE ON public.menu_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_menu_items_updated_at ON public.menu_items;
CREATE TRIGGER set_menu_items_updated_at
  BEFORE UPDATE ON public.menu_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auditoría: se reutiliza audit_table_change → audit_logs, el mismo sistema que
-- ya tienen properties, reservations, operation_requests, property_visits y
-- table_reservations. Un cambio de precio es exactamente la clase de hecho que
-- después hay que poder reconstruir.
DROP TRIGGER IF EXISTS trg_audit_menu_categories ON public.menu_categories;
CREATE TRIGGER trg_audit_menu_categories
  AFTER INSERT OR UPDATE OR DELETE ON public.menu_categories
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();

DROP TRIGGER IF EXISTS trg_audit_menu_items ON public.menu_items;
CREATE TRIGGER trg_audit_menu_items
  AFTER INSERT OR UPDATE OR DELETE ON public.menu_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_table_change();


-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- A diferencia de property_visits y table_reservations, acá NO hay RPC
-- SECURITY DEFINER. Esas son evidencia y máquina de estados: tienen
-- transiciones prohibidas, actores que se congelan y una solicitud inmutable
-- detrás. Un catálogo es ABM — crear, editar, publicar, ordenar, archivar. No
-- hay historia que proteger acá: la historia de los pedidos la va a proteger el
-- snapshot de order_items, no esta tabla. Ocho RPC para un ABM serían MÁS
-- superficie, no menos.
--
-- El precedente es properties, que se escribe con el cliente del usuario a
-- través del repositorio. La diferencia es que acá el permiso va DENTRO de la
-- policy (properties usa policies FOR ALL por rol) y los grants nacen
-- revocados, que es justo lo que a properties le falta.

ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items      ENABLE ROW LEVEL SECURITY;

-- Lectura del tenant. Deliberadamente SIN filtro de permiso: cualquier miembro
-- activo puede VER la carta; can_manage_menu gobierna modificarla.
DROP POLICY IF EXISTS tenant_select_menu_categories ON public.menu_categories;
CREATE POLICY tenant_select_menu_categories
  ON public.menu_categories
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS tenant_select_menu_items ON public.menu_items;
CREATE POLICY tenant_select_menu_items
  ON public.menu_items
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

-- Impersonación de plataforma: SOLO lectura, espejando lo que la tabla concede
-- al tenant. Un operador de setup puede mirar la carta, nunca tocarla.
DROP POLICY IF EXISTS sa_imp_select_menu_categories ON public.menu_categories;
CREATE POLICY sa_imp_select_menu_categories
  ON public.menu_categories
  FOR SELECT TO authenticated
  USING (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());

DROP POLICY IF EXISTS sa_imp_select_menu_items ON public.menu_items;
CREATE POLICY sa_imp_select_menu_items
  ON public.menu_items
  FOR SELECT TO authenticated
  USING (public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id());

-- Escritura: tenant REAL del usuario (auth_tenant_id(), nunca el impersonado) y
-- owner o can_manage_menu. El permiso vive en la policy, no solo en el código:
-- la UI puede esconder botones, pero la autoridad es esta condición.
DROP POLICY IF EXISTS tenant_insert_menu_categories ON public.menu_categories;
CREATE POLICY tenant_insert_menu_categories
  ON public.menu_categories
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.auth_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.id        = auth.uid()
        AND tu.tenant_id = public.auth_tenant_id()
        AND tu.active    = true
        AND (tu.role = 'owner' OR tu.can_manage_menu = true)
    )
  );

DROP POLICY IF EXISTS tenant_update_menu_categories ON public.menu_categories;
CREATE POLICY tenant_update_menu_categories
  ON public.menu_categories
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.auth_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.id        = auth.uid()
        AND tu.tenant_id = public.auth_tenant_id()
        AND tu.active    = true
        AND (tu.role = 'owner' OR tu.can_manage_menu = true)
    )
  )
  -- WITH CHECK también, si no un UPDATE podría mudar la fila a otro tenant.
  WITH CHECK (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS tenant_insert_menu_items ON public.menu_items;
CREATE POLICY tenant_insert_menu_items
  ON public.menu_items
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.auth_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.id        = auth.uid()
        AND tu.tenant_id = public.auth_tenant_id()
        AND tu.active    = true
        AND (tu.role = 'owner' OR tu.can_manage_menu = true)
    )
  );

DROP POLICY IF EXISTS tenant_update_menu_items ON public.menu_items;
CREATE POLICY tenant_update_menu_items
  ON public.menu_items
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.auth_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.id        = auth.uid()
        AND tu.tenant_id = public.auth_tenant_id()
        AND tu.active    = true
        AND (tu.role = 'owner' OR tu.can_manage_menu = true)
    )
  )
  WITH CHECK (tenant_id = public.auth_tenant_id());

-- Ninguna policy de DELETE, para nadie. Se archiva con deleted_at.


-- ── Grants reales ───────────────────────────────────────────────────────────
--
-- Supabase concede INSERT/UPDATE/DELETE (y REFERENCES/TRIGGER) a anon y
-- authenticated en toda tabla nueva de public vía ALTER DEFAULT PRIVILEGES. RLS
-- los frena hoy, pero apoyarse solo en eso significa que el día que alguien
-- agregue una policy el grant ya está puesto. Se revoca TODO y se concede solo
-- lo que estas tablas realmente usan.
--
-- REFERENCES y TRIGGER no se conceden: REFERENCES solo hace falta para CREAR
-- una FK que apunte a la tabla (la de menu_items la crea el owner del schema en
-- esta migración, no `authenticated`), y TRIGGER para crear triggers sobre
-- ella. Ninguna de las dos ocurre en runtime.
--
-- service_role queda como está: los validadores y los fixtures lo usan.

REVOKE ALL ON TABLE public.menu_categories FROM anon;
REVOKE ALL ON TABLE public.menu_categories FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.menu_categories TO authenticated;

REVOKE ALL ON TABLE public.menu_items FROM anon;
REVOKE ALL ON TABLE public.menu_items FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.menu_items TO authenticated;

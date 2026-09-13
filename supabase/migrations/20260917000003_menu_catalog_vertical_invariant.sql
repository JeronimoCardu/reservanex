-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3A1 — invariante de dominio: el catálogo es SOLO de food_service
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL AGUJERO QUE CIERRA ───────────────────────────────────────────────────
--
-- menu_categories y menu_items se escriben por CRUD directo con el cliente del
-- usuario: authenticated tiene SELECT/INSERT/UPDATE y RLS decide. Eso significa
-- que las Server Actions NO son la única puerta de escritura — cualquier usuario
-- autenticado puede hablarle a PostgREST directamente.
--
-- Y las policies de escritura de 20260917000002 exigen tenant propio Y
-- (owner OR can_manage_menu). Ninguna de las dos condiciones mira el RUBRO. Así
-- que el owner de un tenant real_estate las cumple: aunque /dashboard/menu le dé
-- 404 y las actions le rechacen el rubro, un POST directo a
--
--   /rest/v1/menu_categories  { tenant_id: <su tenant real_estate>, name: ... }
--
-- entraba. No es cross-tenant —es su propio tenant— pero viola el dominio: un
-- tenant inmobiliario no tiene carta.
--
-- ── POR QUÉ UN TRIGGER Y NO OTRA CAPA ───────────────────────────────────────
--
-- Un trigger cubre TODAS las puertas a la vez, incluidas las que no existen
-- todavía: browser/PostgREST, Server Actions, service_role, scripts, y cualquier
-- writer futuro que nadie se acuerde de proteger. Es el mismo criterio con el que
-- este repo puso trg_guard_table_reservation_tenant y check_unit_tenant_consistency
-- en la base en vez de en el código.
--
-- Y es un INVARIANTE DE DOMINIO, no una autorización. Por eso también frena a
-- service_role: no es "este usuario no puede", es "esta fila no puede existir".
-- Una policy de RLS no podría dar esa garantía ni queriendo, porque service_role
-- la saltea por diseño.
--
-- ── POR QUÉ SECURITY DEFINER ────────────────────────────────────────────────
--
-- La función lee public.tenants, que TIENE RLS. Sus policies de SELECT para
-- authenticated son owner_select_own_tenant y receptionist_select_own_tenant
-- (is_owner()/is_receptionist() AND id = auth_tenant_id()). O sea: hoy un
-- tenant_user ve su propia fila, pero eso depende de quién escribe.
--
-- Con SECURITY INVOKER, un writer sin SELECT sobre tenants recibiría un rechazo
-- espurio: el guard no podría VER el rubro y tendría que asumir lo peor. Falla
-- cerrado, que es la dirección correcta, pero con un error que miente sobre la
-- causa. Un invariante que puede volverse "no evaluable" no es un invariante.
--
-- Mismo criterio y mismo precedente que check_unit_tenant_consistency y
-- auth_tenant_id(), que son DEFINER por esta razón exacta. La superficie es
-- mínima: lee una columna de una fila y devuelve una decisión booleana.
--
-- ── NO REEMPLAZA A guard_menu_item_tenant ───────────────────────────────────
--
-- Son DOS invariantes distintos y los dos tienen que valer:
--
--   1. guard_menu_item_tenant      el item y su categoría son del MISMO tenant
--   2. guard_menu_tenant_vertical  ese tenant es food_service
--
-- Y el ORDEN entre ellos no hace de la garantía una casualidad. Postgres dispara
-- los BEFORE ... FOR EACH ROW en orden alfabético de nombre de trigger, así que
-- acá corre primero _tenant y después _vertical. No importa: cada función
-- comprueba su propia condición de forma independiente y lanza si se viola.
-- Ninguna depende de que la otra haya corrido, ni de que haya pasado. Si las dos
-- condiciones se violan a la vez, gana el mensaje de la primera y la escritura se
-- rechaza igual — que es el único resultado que interesa.
--
-- ── SIN BACKFILL ────────────────────────────────────────────────────────────
--
-- Verificado contra la base antes de aplicar esto: 0 filas en menu_categories y
-- 0 en menu_items, en TODO el proyecto. No hay nada que migrar, mover ni borrar,
-- y el trigger no toca filas existentes porque no hay ninguna.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_menu_tenant_vertical()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_vertical TEXT;
BEGIN
  SELECT t.vertical INTO v_vertical
  FROM public.tenants t
  WHERE t.id = NEW.tenant_id;

  -- Un BEFORE trigger corre ANTES de que se chequee la FK, así que acá el tenant
  -- todavía puede no existir. Se distingue del caso "existe con otro rubro"
  -- porque son problemas distintos y merecen mensajes distintos: esto es un
  -- problema de REFERENCIA, y lleva el mismo SQLSTATE que le pondría la FK.
  IF v_vertical IS NULL THEN
    RAISE EXCEPTION 'El tenant % no existe', NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Y esto es el invariante de dominio. check_violation (23514) y no
  -- foreign_key_violation: el tenant EXISTE y la referencia está bien, lo que no
  -- se cumple es una regla del dominio — exactamente lo que diría un CHECK si el
  -- rubro viviera en esta misma fila. Además lo hace distinguible del 23503 de
  -- guard_menu_item_tenant, así que quien lea el error sabe qué capa lo frenó.
  IF v_vertical <> 'food_service' THEN
    RAISE EXCEPTION
      'El catálogo de menú es exclusivo de tenants food_service; el tenant % es %',
      NEW.tenant_id, v_vertical
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_menu_tenant_vertical() IS
  'Fase 3E-C3A1: invariante de dominio. menu_categories y menu_items solo pueden '
  'existir para tenants con vertical = food_service. Cubre TODA puerta de '
  'escritura —PostgREST, Server Actions, service_role, writers futuros— porque el '
  'CRUD del catálogo es directo y las policies de RLS no miran el rubro. No '
  'reemplaza a guard_menu_item_tenant(): ese garantiza que el item y su categoría '
  'sean del mismo tenant, este que ese tenant sea gastronómico. SECURITY DEFINER '
  'porque lee public.tenants, que tiene RLS: si no, la garantía dependería de que '
  'el writer tenga SELECT sobre su tenant.';

-- menu_categories: no tenía guard de tenant (su tenant_id es la única referencia
-- y la FK alcanza), así que este es su primer trigger de invariante.
DROP TRIGGER IF EXISTS trg_guard_menu_category_vertical ON public.menu_categories;
CREATE TRIGGER trg_guard_menu_category_vertical
  BEFORE INSERT OR UPDATE ON public.menu_categories
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_tenant_vertical();

-- menu_items: convive con trg_guard_menu_item_tenant, que se mantiene tal cual.
DROP TRIGGER IF EXISTS trg_guard_menu_item_vertical ON public.menu_items;
CREATE TRIGGER trg_guard_menu_item_vertical
  BEFORE INSERT OR UPDATE ON public.menu_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_menu_tenant_vertical();

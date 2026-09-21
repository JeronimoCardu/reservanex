-- ════════════════════════════════════════════════════════════════════════════
-- Onboarding multi-tipo: Inmobiliaria · Particular · Gastronomía
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── QUÉ SE AGREGA Y POR QUÉ ASÍ ─────────────────────────────────────────────
--
-- El producto pasa a tener TRES tipos comerciales, pero siguen siendo DOS
-- verticales. Particular no es un vertical nuevo: es una inmobiliaria con otro
-- tamaño. Meterlo en `vertical` habría duplicado todo el sistema de módulos,
-- guards y formularios por intent para no ganar nada.
--
-- Antes de agregar la columna se buscó un campo equivalente ya existente
-- (tenant_type / client_type / business_type / account_type / plan_type): no
-- hay ninguno. `plan` / `plan_code` / `plan_label` sí existen, pero significan
-- otra cosa —el tier comercial contratado— y usarlos para el rubro mezclaría
-- "qué clase de negocio es" con "cuánto paga".
--
-- El par (vertical, client_type) es total y sin ambigüedad:
--
--   real_estate  + 'agency'         → Inmobiliaria
--   real_estate  + 'private_owner'  → Particular
--   food_service + NULL             → Gastronomía
--
-- client_type es NULL para food_service a propósito: no es "sin definir", es
-- "no aplica". Un CHECK de coherencia lo vuelve obligatorio del lado
-- inmobiliario e imposible del lado gastronómico, así que la combinación
-- inválida no existe en la base, no sólo en el código.
--
-- ── LÍMITES: SE REUSA LO QUE YA HABÍA ───────────────────────────────────────
--
-- tenants ya tenía max_properties / max_users / max_owners / max_receptionists.
-- max_users, max_owners y max_receptionists se aplican hoy en
-- actions/users.ts; max_properties estaba muerta —ninguna lectura en todo el
-- repo— pero la semántica ya estaba nombrada, así que se la revive en vez de
-- inventar un campo nuevo.
--
-- Las cuatro pasan a ser NULLABLE, y NULL significa SIN LÍMITE. Hoy son NOT
-- NULL con default 5/1/4/10, o sea que una inmobiliaria grande está topeada en
-- 5 usuarios: eso deja de ser cierto para 'agency' por decisión de producto.
--
-- OJO al leerlas desde el código: `max_users ?? 5` interpretaría NULL como
-- "cinco" y toparía justo a quien no debe estar topeado. La lectura tiene que
-- tratar NULL como infinito explícitamente.
--
-- ── CONCURRENCIA: EL LÍMITE VIVE EN LA BASE ─────────────────────────────────
--
-- Contar en la aplicación y después insertar es exactamente el patrón que dos
-- requests simultáneas rompen: ambas leen 4, ambas insertan, quedan 6. Por eso
-- el límite se aplica con TRIGGERS que bloquean la fila del tenant
-- (SELECT ... FOR UPDATE) antes de contar. Dos inserciones concurrentes sobre
-- el mismo tenant se serializan; la segunda cuenta el efecto de la primera.
--
-- Los chequeos de actions/users.ts se mantienen: dan un mensaje lindo. Pero la
-- autoridad es esta, y vale para CUALQUIER camino de inserción —RPC, script,
-- service_role, un import futuro— no sólo para el que hoy pasa por la UI.
--
-- ── CAPABILITIES GASTRONÓMICAS ──────────────────────────────────────────────
--
-- Tres booleanos explícitos, no un JSON. `site_config jsonb` existe y está sin
-- usar (0 tenants con contenido), pero el resto del modelo expresa los
-- interruptores como columnas —public_site_enabled, receipt_show_logo,
-- active— y un booleano en columna se puede indexar, chequear y leer desde SQL
-- sin desarmar un documento. Se sigue el patrón que ya está.
--
-- Default true en los tres: un restaurante nuevo arranca con todo disponible y
-- apaga lo que no ofrece. No había comportamiento previo que preservar —estas
-- capacidades no existían— así que el default lo fija el onboarding.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Tipo de cliente ──────────────────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS client_type TEXT;

COMMENT ON COLUMN public.tenants.client_type IS
  'Tipo comercial dentro del vertical. real_estate: agency | private_owner. '
  'food_service: NULL (no aplica). El par (vertical, client_type) identifica '
  'los tres tipos de cliente del producto.';

-- Backfill ANTES de los CHECK: todo lo inmobiliario que ya existe es agency.
-- Es la interpretación segura — hasta hoy sólo se podían crear inmobiliarias.
UPDATE public.tenants SET client_type = 'agency'
  WHERE vertical = 'real_estate' AND client_type IS NULL;

-- food_service no se toca: su client_type correcto es NULL.
UPDATE public.tenants SET client_type = NULL
  WHERE vertical = 'food_service';

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_client_type_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_client_type_check
  CHECK (client_type IS NULL OR client_type IN ('agency', 'private_owner'));

-- La coherencia con el vertical, para que la combinación inválida no exista.
ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_client_type_vertical_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_client_type_vertical_check
  CHECK (
    (vertical = 'real_estate'  AND client_type IN ('agency', 'private_owner'))
    OR
    (vertical = 'food_service' AND client_type IS NULL)
  );

-- ── 2. Capabilities gastronómicas ───────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS delivery_enabled           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS takeaway_enabled           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS table_reservations_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tenants.delivery_enabled IS
  'food_service: acepta pedidos con envío. Gobierna operaciones NUEVAS; los '
  'pedidos ya aceptados conservan su fulfillment y su ciclo de vida.';
COMMENT ON COLUMN public.tenants.takeaway_enabled IS
  'food_service: acepta pedidos para retirar en el local. Si delivery y '
  'takeaway están en false no se pueden generar pedidos nuevos, pero la carta '
  'pública sigue visible y las consultas siguen funcionando.';
COMMENT ON COLUMN public.tenants.table_reservations_enabled IS
  'food_service: acepta reservas de mesa. Apagarlo oculta el CTA, cierra la '
  'ruta pública y esconde el módulo del dashboard. NO borra reservas '
  'históricas ni altera su ciclo de vida.';

-- ── 3. Los límites pasan a admitir "sin límite" ─────────────────────────────

ALTER TABLE public.tenants ALTER COLUMN max_properties    DROP NOT NULL;
ALTER TABLE public.tenants ALTER COLUMN max_users         DROP NOT NULL;
ALTER TABLE public.tenants ALTER COLUMN max_owners        DROP NOT NULL;
ALTER TABLE public.tenants ALTER COLUMN max_receptionists DROP NOT NULL;

ALTER TABLE public.tenants ALTER COLUMN max_properties    DROP DEFAULT;
ALTER TABLE public.tenants ALTER COLUMN max_users         DROP DEFAULT;
ALTER TABLE public.tenants ALTER COLUMN max_owners        DROP DEFAULT;
ALTER TABLE public.tenants ALTER COLUMN max_receptionists DROP DEFAULT;

COMMENT ON COLUMN public.tenants.max_properties IS
  'Máximo de propiedades vigentes (deleted_at IS NULL). NULL = sin límite.';
COMMENT ON COLUMN public.tenants.max_users IS
  'Máximo de usuarios activos del tenant, owner incluido. NULL = sin límite.';
COMMENT ON COLUMN public.tenants.max_owners IS
  'Máximo de owners activos. NULL = sin límite.';
COMMENT ON COLUMN public.tenants.max_receptionists IS
  'Máximo de recepcionistas activos. NULL = sin límite.';

-- Los tenants que ya existen quedan sin límite: hasta hoy eran todos
-- inmobiliarias, y una agency no tiene tope de producto.
UPDATE public.tenants
SET max_properties = NULL, max_users = NULL, max_owners = NULL, max_receptionists = NULL
WHERE client_type IS DISTINCT FROM 'private_owner';

-- ── 4. El límite de propiedades, aplicado en la base ────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_tenant_property_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_max    INT;
  v_actual INT;
BEGIN
  -- El lock es el punto entero de esta función: sin él, dos inserciones
  -- simultáneas cuentan las dos lo mismo y las dos pasan.
  SELECT t.max_properties INTO v_max
  FROM public.tenants t
  WHERE t.id = NEW.tenant_id
  FOR UPDATE;

  IF v_max IS NULL THEN
    RETURN NEW;  -- sin límite
  END IF;

  -- Sólo cuentan las vigentes: properties usa deleted_at como archivado, y una
  -- propiedad archivada no ocupa lugar.
  SELECT count(*) INTO v_actual
  FROM public.properties p
  WHERE p.tenant_id = NEW.tenant_id AND p.deleted_at IS NULL;

  IF v_actual >= v_max THEN
    RAISE EXCEPTION 'TENANT_LIMIT_PROPERTIES:%', v_max
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_tenant_property_limit ON public.properties;
CREATE TRIGGER trg_enforce_tenant_property_limit
  BEFORE INSERT ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_property_limit();

-- Desarchivar también consume cupo, si no el límite se esquiva archivando y
-- restaurando.
CREATE OR REPLACE FUNCTION public.enforce_tenant_property_limit_restore()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_max    INT;
  v_actual INT;
BEGIN
  IF NOT (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN
    RETURN NEW;
  END IF;

  SELECT t.max_properties INTO v_max
  FROM public.tenants t WHERE t.id = NEW.tenant_id FOR UPDATE;

  IF v_max IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_actual
  FROM public.properties p
  WHERE p.tenant_id = NEW.tenant_id AND p.deleted_at IS NULL AND p.id <> NEW.id;

  IF v_actual >= v_max THEN
    RAISE EXCEPTION 'TENANT_LIMIT_PROPERTIES:%', v_max
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_tenant_property_limit_restore ON public.properties;
CREATE TRIGGER trg_enforce_tenant_property_limit_restore
  BEFORE UPDATE OF deleted_at ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_property_limit_restore();

-- ── 5. El límite de usuarios, aplicado en la base ───────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_tenant_user_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_max_total INT;
  v_max_own   INT;
  v_max_rec   INT;
  v_total     INT;
  v_owners    INT;
  v_recep     INT;
  v_excluir   UUID;
BEGIN
  -- Sólo interesan las filas que pasan a contar: un alta activa, o una
  -- reactivación. Desactivar o editar otra cosa no consume cupo.
  IF TG_OP = 'INSERT' THEN
    IF NEW.active IS NOT TRUE THEN RETURN NEW; END IF;
    v_excluir := NULL;
  ELSE
    IF NOT (OLD.active IS DISTINCT FROM TRUE AND NEW.active IS TRUE)
       AND NOT (NEW.active IS TRUE AND NEW.role IS DISTINCT FROM OLD.role)
    THEN
      RETURN NEW;
    END IF;
    v_excluir := NEW.id;  -- su fila vieja no se cuenta dos veces
  END IF;

  SELECT t.max_users, t.max_owners, t.max_receptionists
  INTO v_max_total, v_max_own, v_max_rec
  FROM public.tenants t
  WHERE t.id = NEW.tenant_id
  FOR UPDATE;

  SELECT
    count(*) FILTER (WHERE tu.active),
    count(*) FILTER (WHERE tu.active AND tu.role = 'owner'),
    count(*) FILTER (WHERE tu.active AND tu.role = 'receptionist')
  INTO v_total, v_owners, v_recep
  FROM public.tenant_users tu
  WHERE tu.tenant_id = NEW.tenant_id
    AND (v_excluir IS NULL OR tu.id <> v_excluir);

  IF v_max_total IS NOT NULL AND v_total >= v_max_total THEN
    RAISE EXCEPTION 'TENANT_LIMIT_USERS:%', v_max_total
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.role = 'owner' AND v_max_own IS NOT NULL AND v_owners >= v_max_own THEN
    RAISE EXCEPTION 'TENANT_LIMIT_OWNERS:%', v_max_own
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.role = 'receptionist' AND v_max_rec IS NOT NULL AND v_recep >= v_max_rec THEN
    RAISE EXCEPTION 'TENANT_LIMIT_RECEPTIONISTS:%', v_max_rec
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_tenant_user_limit ON public.tenant_users;
CREATE TRIGGER trg_enforce_tenant_user_limit
  BEFORE INSERT OR UPDATE OF active, role ON public.tenant_users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_user_limit();

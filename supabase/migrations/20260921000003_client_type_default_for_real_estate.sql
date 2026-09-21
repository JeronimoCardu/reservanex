-- ════════════════════════════════════════════════════════════════════════════
-- Un real_estate sin client_type es agency: default condicional por trigger
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── CÓMO APARECIÓ ───────────────────────────────────────────────────────────
--
-- Al cerrar el CHECK de coherencia (20260921000002) empezaron a fallar
-- validate:forms y validate:food-orders con:
--
--   new row for relation "tenants" violates check constraint
--   "tenants_client_type_vertical_check"
--
-- No es un bug del CHECK: es el CHECK funcionando. Esos validadores —y
-- cualquier otro camino que inserte un tenant directo— escriben
-- vertical='real_estate' sin decir client_type, porque hasta ayer esa columna
-- no existía. Lo mismo va a pasar con cualquier INSERT futuro que alguien
-- escriba sin acordarse.
--
-- ── POR QUÉ UN TRIGGER Y NO UN DEFAULT DE COLUMNA ───────────────────────────
--
-- Un DEFAULT de columna no puede depender de otra columna: 'agency' sería
-- default también para food_service, y ahí el valor correcto es NULL. El
-- default correcto es CONDICIONAL —agency si es inmobiliario, nada si es
-- gastronómico— y eso sólo se expresa con un BEFORE INSERT.
--
-- ── POR QUÉ ES SEGURO RELLENAR EN SILENCIO ──────────────────────────────────
--
-- Es la misma regla que aplicó el backfill de 20260921000001 a lo histórico:
-- "todo lo inmobiliario que no dice otra cosa es agency". Y agency es el tipo
-- SIN topes, o sea que el peor caso de un INSERT despistado es comportarse
-- como se comportaban todos los tenants antes de esta fase. Un particular —el
-- tipo con límites— NUNCA se crea por omisión: hay que pedirlo.
--
-- El CHECK sigue siendo la autoridad: food_service + 'agency' se rechaza,
-- real_estate + 'invalido' se rechaza. El trigger sólo completa el caso
-- ambiguo con la interpretación que el producto ya había fijado.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.default_tenant_client_type()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.vertical = 'real_estate' AND NEW.client_type IS NULL THEN
    NEW.client_type := 'agency';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_default_tenant_client_type ON public.tenants;
CREATE TRIGGER trg_default_tenant_client_type
  BEFORE INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.default_tenant_client_type();

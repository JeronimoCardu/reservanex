-- ════════════════════════════════════════════════════════════════════════════
-- El CHECK de coherencia tiene que rechazar el NULL, no dejarlo pasar
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL BUG, ENCONTRADO POR EL VALIDADOR FÍSICO ──────────────────────────────
--
-- 20260921000001 dejó esta restricción:
--
--   CHECK (
--     (vertical = 'real_estate'  AND client_type IN ('agency','private_owner'))
--     OR
--     (vertical = 'food_service' AND client_type IS NULL)
--   )
--
-- Parece total, y no lo es. Con vertical='real_estate' y client_type=NULL:
--
--   rama 1:  TRUE  AND (NULL IN (...))  →  TRUE AND NULL  →  NULL
--   rama 2:  FALSE AND ...              →  FALSE
--   total:   NULL OR FALSE              →  NULL
--
-- Y un CHECK sólo rechaza cuando la expresión da FALSE. Con NULL, PASA. Así
-- que la combinación que la restricción existía para impedir —una inmobiliaria
-- sin tipo de cliente— entraba sin protestar.
--
-- Lo detectó validate:tenant-kinds intentando exactamente eso contra la base
-- real: el caso decía "y rechaza un real_estate sin client_type" y falló. Un
-- test unitario no podía verlo, porque el defecto está en la lógica ternaria
-- de SQL, no en el código de la aplicación.
--
-- ── LA CORRECCIÓN ───────────────────────────────────────────────────────────
--
-- Un CASE, que devuelve un booleano de verdad en las tres ramas. El
-- `client_type IS NOT NULL AND ...` es lo que fuerza FALSE en vez de NULL, y
-- el ELSE false cierra la puerta a un vertical futuro que nadie haya
-- considerado acá.
--
-- Se sanea antes de aplicar: cualquier fila que se haya colado con NULL vuelve
-- a 'agency', que es lo que era todo lo inmobiliario. En una base sin filas
-- coladas no toca nada.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE public.tenants
SET client_type = 'agency'
WHERE vertical = 'real_estate' AND client_type IS NULL;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_client_type_vertical_check;

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_client_type_vertical_check
  CHECK (
    CASE vertical
      WHEN 'real_estate'  THEN client_type IS NOT NULL
                           AND client_type IN ('agency', 'private_owner')
      WHEN 'food_service' THEN client_type IS NULL
      ELSE false
    END
  );

-- =============================================================================
-- 20260803000002_harden_admin_purge_tenant_permissions.sql
-- Corrección de seguridad para public.admin_purge_tenant(uuid)
-- =============================================================================
-- La función fue aplicada con search_path incompleto y sin REVOKE explícito
-- sobre los roles anon/authenticated. Esta migración corrige ambos puntos
-- sin alterar el comportamiento funcional del purge.
-- =============================================================================

-- 1. Fijar search_path seguro: public primero, pg_temp al final.
--    Con pg_temp al final las tablas permanentes siempre tienen prioridad
--    sobre tablas temporales del mismo nombre (previene shadowing).
ALTER FUNCTION public.admin_purge_tenant(uuid)
  SET search_path = public, pg_temp;

-- 2. Revocar cualquier permiso heredado de PUBLIC (incluye anon y authenticated).
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM PUBLIC;

-- 3. Revocar explícitamente de anon y authenticated por si tienen grants directos.
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM authenticated;

-- 4. Solo service_role puede ejecutar esta función.
GRANT EXECUTE ON FUNCTION public.admin_purge_tenant(uuid) TO service_role;

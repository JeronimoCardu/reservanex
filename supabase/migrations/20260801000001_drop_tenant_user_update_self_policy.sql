-- =============================================================================
-- 20260801000001_drop_tenant_user_update_self_policy.sql
-- Fix C-01: eliminar escalada de privilegios en tenant_users
-- =============================================================================
-- La policy "tenant_user_update_self" permitía que cualquier tenant_user
-- actualizara su propia fila sin restricción de columnas, incluyendo role,
-- can_access_settings y demás permisos, usando el Supabase browser client.
--
-- Los permisos son leídos fresh del DB en cada requireTenantContext(),
-- por lo que la escalada era inmediata para los campos de permiso.
-- Para role (owner), tomaba efecto en el siguiente refresh de JWT (~1h).
--
-- Fix: eliminar la policy. Ninguna Server Action necesita que el usuario
-- actualice su propia fila via session client — las actualizaciones de
-- tenant_users las hace el owner via "owner_all_tenant_users".
-- =============================================================================

DROP POLICY IF EXISTS "tenant_user_update_self" ON public.tenant_users;

-- ============================================================
-- OrderFlow — Infrastructure Validation Checklist
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- Cada query retorna el estado esperado de cada componente.
-- ============================================================


-- ============================================================
-- 1. AUTH HOOK
-- Verifica que el custom_access_token_hook esté registrado.
-- EXPECTED: 1 fila con routine_name = 'custom_access_token_hook'
-- Si 0 filas: ir a Dashboard → Authentication → Hooks → Custom Access Token
-- ============================================================

SELECT
  routine_name,
  routine_type,
  security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name = 'custom_access_token_hook';


-- ============================================================
-- 2. JWT CLAIMS — Simulación del hook
-- Verifica que el hook pueda leer los datos para cada usuario.
-- EXPECTED: cada fila muestra 'WILL RETURN CLAIMS'
-- ============================================================

-- Super Admin
SELECT
  'super_admin' AS user_type,
  pu.id::text,
  pu.email,
  pu.role::text,
  CASE WHEN pu.active THEN 'WILL RETURN CLAIMS' ELSE 'SKIP — INACTIVE' END AS hook_result,
  jsonb_build_object(
    'user_type', 'platform_user',
    'role', pu.role::text
  ) AS expected_jwt_app_metadata
FROM public.platform_users pu
WHERE pu.role = 'super_admin';

-- Owner Demo
SELECT
  'tenant_user (owner)' AS user_type,
  tu.id::text,
  tu.email,
  tu.role::text,
  tu.tenant_id::text,
  ARRAY_AGG(uwa.workspace_id)::text AS workspace_ids_in_jwt,
  CASE WHEN tu.active THEN 'WILL RETURN CLAIMS' ELSE 'SKIP — INACTIVE' END AS hook_result
FROM public.tenant_users tu
LEFT JOIN public.user_workspace_assignments uwa ON uwa.user_id = tu.id
WHERE tu.role = 'owner'
GROUP BY tu.id, tu.email, tu.role, tu.tenant_id, tu.active;

-- Receptionists (si existen)
SELECT
  'tenant_user (receptionist)' AS user_type,
  tu.id::text,
  tu.email,
  tu.tenant_id::text,
  ARRAY_AGG(uwa.workspace_id)::text AS workspace_ids_in_jwt,
  CASE
    WHEN ARRAY_AGG(uwa.workspace_id) IS NULL THEN 'NULL → all workspaces'
    ELSE 'scoped to ' || ARRAY_LENGTH(ARRAY_AGG(uwa.workspace_id), 1)::text || ' workspace(s)'
  END AS scope,
  CASE WHEN tu.active THEN 'WILL RETURN CLAIMS' ELSE 'SKIP — INACTIVE' END AS hook_result
FROM public.tenant_users tu
LEFT JOIN public.user_workspace_assignments uwa ON uwa.user_id = tu.id
WHERE tu.role = 'receptionist'
GROUP BY tu.id, tu.email, tu.tenant_id, tu.active;


-- ============================================================
-- 3. RLS — Verificar que todas las tablas tienen RLS habilitado
-- EXPECTED: todas las filas muestran rls_enabled = true
-- Si alguna fila es false: ejecutar ALTER TABLE ... ENABLE ROW LEVEL SECURITY
-- ============================================================

SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled,
  CASE WHEN rowsecurity THEN 'OK' ELSE 'MISSING — RLS DISABLED' END AS status
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename NOT IN ('tenants_public')  -- view, no RLS
ORDER BY tablename;


-- ============================================================
-- 4. RLS POLICIES — Cantidad de políticas por tabla
-- EXPECTED: cada tabla crítica tiene al menos 1 política
-- workspaces debe tener políticas para SA impersonation, owner, receptionist
-- ============================================================

SELECT
  schemaname,
  tablename,
  COUNT(*) AS policy_count,
  STRING_AGG(policyname, ', ' ORDER BY policyname) AS policies
FROM pg_policies
WHERE schemaname = 'public'
GROUP BY schemaname, tablename
ORDER BY tablename;


-- ============================================================
-- 5. TENANT ISOLATION — Verificar datos del tenant demo
-- EXPECTED: cada query retorna datos del tenant a0000000...
-- ============================================================

SELECT
  'tenants' AS entity,
  id::text,
  name,
  slug,
  status::text,
  plan::text,
  CASE WHEN deleted_at IS NULL THEN 'ACTIVE' ELSE 'DELETED' END AS state
FROM public.tenants
WHERE id = 'a0000000-0000-0000-0000-000000000001';

SELECT
  'tenant_users' AS entity,
  COUNT(*) AS total_users,
  COUNT(*) FILTER (WHERE role = 'owner') AS owners,
  COUNT(*) FILTER (WHERE role = 'receptionist') AS receptionists,
  COUNT(*) FILTER (WHERE active = true) AS active_users
FROM public.tenant_users
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001';

SELECT
  'workspaces' AS entity,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE active = true) AS active,
  STRING_AGG(name || ' (' || type::text || ')', ', ' ORDER BY created_at) AS workspace_list
FROM public.workspaces
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001';


-- ============================================================
-- 6. WORKSPACE ISOLATION — Receptionist assignment integrity
-- EXPECTED: todas las asignaciones tienen user y workspace del mismo tenant
-- Si 0 filas: integridad confirmada (no hay cross-tenant assignments)
-- ============================================================

SELECT
  uwa.id::text AS assignment_id,
  uwa.user_id::text,
  uwa.workspace_id::text,
  tu.tenant_id::text AS user_tenant,
  w.tenant_id::text  AS workspace_tenant,
  CASE
    WHEN tu.tenant_id = w.tenant_id THEN 'OK'
    ELSE 'CROSS-TENANT VIOLATION'
  END AS isolation_status
FROM public.user_workspace_assignments uwa
JOIN public.tenant_users tu ON tu.id = uwa.user_id
JOIN public.workspaces w    ON w.id  = uwa.workspace_id
WHERE tu.tenant_id <> w.tenant_id;  -- must return 0 rows


-- ============================================================
-- 7. WORKSPACE ASSIGNMENT — auth_workspace_ids() logic simulation
-- Simulates what the Auth Hook puts in the JWT for each user
-- EXPECTED: owners → NULL (no restriction), receptionists → NULL or UUID[]
-- ============================================================

SELECT
  tu.id::text,
  tu.name,
  tu.role::text,
  CASE tu.role
    WHEN 'owner' THEN 'NULL (full access by role)'
    WHEN 'receptionist' THEN
      CASE
        WHEN COUNT(uwa.workspace_id) = 0
          THEN 'NULL (no assignments → all workspaces)'
        ELSE '[' || STRING_AGG(uwa.workspace_id::text, ', ') || ']'
      END
  END AS workspace_ids_in_jwt
FROM public.tenant_users tu
LEFT JOIN public.user_workspace_assignments uwa ON uwa.user_id = tu.id
WHERE tu.tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND tu.active = true
GROUP BY tu.id, tu.name, tu.role;


-- ============================================================
-- 8. SERVICE ROLE — Verificar funciones helper
-- EXPECTED: cada función existe en public schema
-- ============================================================

SELECT
  routine_name,
  routine_type,
  security_type,
  CASE WHEN security_type = 'DEFINER' THEN 'OK' ELSE 'WARN — should be SECURITY DEFINER' END AS status
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'auth_user_type',
    'auth_tenant_id',
    'auth_user_role',
    'auth_workspace_ids',
    'auth_impersonating_tenant_id',
    'is_super_admin',
    'is_owner',
    'is_receptionist',
    'is_tenant_user',
    'verify_hook_configured',
    'custom_access_token_hook'
  )
ORDER BY routine_name;


-- ============================================================
-- 9. IMPERSONATION — Sesiones activas (debe estar vacío en producción limpia)
-- EXPECTED: 0 filas activas (ended_at IS NULL)
-- ============================================================

SELECT
  id::text,
  platform_user_id::text,
  target_tenant_id::text,
  reason,
  started_at,
  CASE WHEN ended_at IS NULL THEN 'ACTIVE — session open' ELSE 'CLOSED' END AS status
FROM public.impersonation_sessions
WHERE ended_at IS NULL;


-- ============================================================
-- 10. RESUMEN GENERAL
-- Snapshot completo del estado del sistema
-- EXPECTED: ver conteos consistentes con el bootstrap
-- ============================================================

SELECT
  (SELECT COUNT(*) FROM public.platform_users WHERE active = true)             AS active_platform_users,
  (SELECT COUNT(*) FROM public.platform_users WHERE role = 'super_admin')      AS super_admins,
  (SELECT COUNT(*) FROM public.tenants WHERE deleted_at IS NULL)               AS active_tenants,
  (SELECT COUNT(*) FROM public.workspaces WHERE active = true)                 AS active_workspaces,
  (SELECT COUNT(*) FROM public.tenant_users WHERE active = true)               AS active_tenant_users,
  (SELECT COUNT(*) FROM public.user_workspace_assignments)                     AS workspace_assignments,
  (SELECT COUNT(*) FROM public.impersonation_sessions WHERE ended_at IS NULL)  AS open_impersonation_sessions,
  (SELECT COUNT(*) FROM public.properties WHERE deleted_at IS NULL)            AS properties,
  (SELECT COUNT(*) FROM public.contacts WHERE deleted_at IS NULL)              AS contacts,
  (SELECT COUNT(*) FROM public.conversations)                                  AS conversations,
  (SELECT COUNT(*) FROM public.reservations WHERE deleted_at IS NULL)          AS reservations;

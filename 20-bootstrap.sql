-- ============================================================
-- OrderFlow — Bootstrap Inicial
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- Prerequisito: 16-supabase-schema-v3.sql y 17-rls-policies-v2.sql
--               ya aplicados en el proyecto.
-- ============================================================

-- UUIDs fijos para facilitar debugging:
--   Tenant Demo:      a0000000-0000-0000-0000-000000000001
--   Workspace General b0000000-0000-0000-0000-000000000001
--   Owner Demo:       c0000000-0000-0000-0000-000000000001

BEGIN;


-- ============================================================
-- 1. SUPER ADMIN
-- Convierte el usuario existente en platform_user con role super_admin.
-- Lee nombre y email directamente de auth.users para evitar inconsistencias.
-- ============================================================

INSERT INTO public.platform_users (id, name, email, role, active)
SELECT
  id,
  COALESCE(
    raw_user_meta_data->>'full_name',
    raw_user_meta_data->>'name',
    split_part(email, '@', 1)
  ),
  email,
  'super_admin'::platform_role,
  true
FROM auth.users
WHERE id = 'faf1cbb7-02a8-4ca1-b2f9-a2854f547d81'
ON CONFLICT (id) DO UPDATE SET
  role       = EXCLUDED.role,
  active     = true,
  updated_at = now();


-- ============================================================
-- 2. TENANT DEMO
-- ============================================================

INSERT INTO public.tenants (
  id,
  name,
  slug,
  status,
  plan,
  max_properties,
  max_users,
  primary_color,
  secondary_color,
  site_config
)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'OrderFlow Demo',
  'orderflow-demo',
  'active'::tenant_status,
  'pro'::plan_tier,
  50,
  20,
  '#2563EB',
  '#1E40AF',
  jsonb_build_object(
    'template',         'modern',
    'hero_title',       'Tu próxima propiedad te espera',
    'hero_subtitle',    'Alquileres temporarios en los mejores destinos',
    'about_text',       'OrderFlow Demo es una agencia de alquileres temporarios.',
    'seo_title',        'OrderFlow Demo | Alquileres Temporarios',
    'seo_description',  'Encontrá tu próximo alquiler con OrderFlow Demo.',
    'font',             'inter',
    'show_prices',      true,
    'contact_email',    'demo@orderflow.app'
  )
)
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- 3. WORKSPACE GENERAL
-- Se crea automáticamente en el onboarding real. Aquí lo creamos
-- manualmente para el bootstrap.
-- ============================================================

INSERT INTO public.workspaces (
  id,
  tenant_id,
  name,
  type,
  active
)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'General',
  'general'::workspace_type,
  true
)
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- 4. AUTH USER — OWNER DEMO
-- Crea el usuario en auth.users con email confirmado y password conocida.
-- Password: Demo2026!
-- Solo se ejecuta si el usuario no existe (idempotente).
-- ============================================================

DO $$
DECLARE
  v_owner_id UUID := 'c0000000-0000-0000-0000-000000000001';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_owner_id) THEN
    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      v_owner_id,
      'authenticated',
      'authenticated',
      'owner@orderflowdemo.com',
      crypt('Demo2026!', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"name":"Roberto Giménez"}'::jsonb,
      now(),
      now()
    );
  END IF;
END;
$$;


-- ============================================================
-- 5. TENANT USER — OWNER DEMO
-- tenant_users.id = auth.users.id (mismo UUID).
-- Owner no tiene user_workspace_assignments — acceso total por rol.
-- ============================================================

INSERT INTO public.tenant_users (
  id,
  tenant_id,
  name,
  email,
  role,
  active
)
VALUES (
  'c0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'Roberto Giménez',
  'owner@orderflowdemo.com',
  'owner'::tenant_role,
  true
)
ON CONFLICT (id) DO NOTHING;


COMMIT;


-- ============================================================
-- VERIFICACIÓN
-- Ejecutar estas queries después del COMMIT para confirmar el estado.
-- ============================================================

-- 1. Super Admin creado correctamente
SELECT
  pu.id,
  pu.name,
  pu.email,
  pu.role::text,
  pu.active,
  CASE WHEN au.id IS NOT NULL THEN 'OK' ELSE 'MISSING IN AUTH.USERS' END AS auth_status
FROM public.platform_users pu
LEFT JOIN auth.users au ON au.id = pu.id
WHERE pu.role = 'super_admin';

-- 2. Tenant y estado
SELECT id, name, slug, status::text, plan::text, max_properties, max_users
FROM public.tenants
WHERE id = 'a0000000-0000-0000-0000-000000000001';

-- 3. Workspace General
SELECT w.id, w.name, w.type::text, w.active, t.name AS tenant_name
FROM public.workspaces w
JOIN public.tenants t ON t.id = w.tenant_id
WHERE w.id = 'b0000000-0000-0000-0000-000000000001';

-- 4. Owner demo
SELECT
  tu.id,
  tu.name,
  tu.email,
  tu.role::text,
  tu.active,
  CASE WHEN au.id IS NOT NULL THEN 'OK' ELSE 'MISSING IN AUTH.USERS' END AS auth_status,
  CASE WHEN au.email_confirmed_at IS NOT NULL THEN 'CONFIRMED' ELSE 'NOT CONFIRMED' END AS email_status
FROM public.tenant_users tu
LEFT JOIN auth.users au ON au.id = tu.id
WHERE tu.id = 'c0000000-0000-0000-0000-000000000001';

-- 5. Workspace assignments del owner (debe estar vacío — acceso total por rol)
SELECT COUNT(*) AS assignments_count
FROM public.user_workspace_assignments
WHERE user_id = 'c0000000-0000-0000-0000-000000000001';

-- 6. Resumen del estado del sistema
SELECT
  (SELECT COUNT(*) FROM public.platform_users)             AS platform_users,
  (SELECT COUNT(*) FROM public.tenants)                    AS tenants,
  (SELECT COUNT(*) FROM public.workspaces)                 AS workspaces,
  (SELECT COUNT(*) FROM public.tenant_users)               AS tenant_users,
  (SELECT COUNT(*) FROM public.user_workspace_assignments) AS workspace_assignments;

-- 7. Verificar que el Auth Hook puede leer los datos de cada usuario
--    (simula lo que el hook haría en el login)

-- Super Admin:
SELECT
  'super_admin_hook_sim' AS test,
  pu.role::text,
  'platform_user' AS expected_user_type,
  CASE WHEN pu.active THEN 'WILL RETURN CLAIMS' ELSE 'WILL SKIP — INACTIVE' END AS hook_result
FROM public.platform_users pu
WHERE pu.id = 'faf1cbb7-02a8-4ca1-b2f9-a2854f547d81';

-- Owner Demo:
SELECT
  'owner_hook_sim' AS test,
  tu.role::text,
  tu.tenant_id::text,
  ARRAY_AGG(uwa.workspace_id) AS workspace_ids_in_jwt,
  'tenant_user' AS expected_user_type,
  CASE
    WHEN tu.active THEN 'WILL RETURN CLAIMS'
    ELSE 'WILL SKIP — INACTIVE'
  END AS hook_result
FROM public.tenant_users tu
LEFT JOIN public.user_workspace_assignments uwa ON uwa.user_id = tu.id
WHERE tu.id = 'c0000000-0000-0000-0000-000000000001'
GROUP BY tu.id, tu.role, tu.tenant_id, tu.active;

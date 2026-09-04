-- =============================================================================
-- custom_access_token_hook
-- Injects OrderFlow claims into every JWT issued by Supabase Auth.
-- =============================================================================
-- WHY:
--   requireTenantContext() decodes the access_token JWT and reads app_metadata
--   to get user_type, role, tenant_id, and workspace_ids.  Without this hook
--   the JWT has no custom claims and every authenticated user is rejected,
--   causing an infinite /dashboard ↔ /login redirect loop.
--
-- AFTER APPLYING:
--   1. Supabase Dashboard → Authentication → Hooks → Custom Access Token
--      → enable → select public.custom_access_token_hook
--   2. Sign out and sign back in (old tokens don't get the new claims
--      until they are refreshed or re-issued).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
  auth_user_id  uuid;
  claims        jsonb;
  app_meta      jsonb;
  pu_role       text;
  tu_role       text;
  tu_tenant_id  uuid;
  ws_ids        uuid[];
BEGIN
  auth_user_id := (event ->> 'user_id')::uuid;
  claims       := event -> 'claims';
  app_meta     := COALESCE(claims -> 'app_metadata', '{}'::jsonb);

  -- ── 1. Platform user ────────────────────────────────────────────────────────
  SELECT role::text INTO pu_role
  FROM public.platform_users
  WHERE id = auth_user_id
    AND active = true
  LIMIT 1;

  IF pu_role IS NOT NULL THEN
    app_meta := app_meta || jsonb_build_object(
      'user_type', 'platform_user',
      'role',      pu_role
    );
    RETURN jsonb_set(event, '{claims}', jsonb_set(claims, '{app_metadata}', app_meta));
  END IF;

  -- ── 2. Tenant user ──────────────────────────────────────────────────────────
  SELECT role::text, tenant_id INTO tu_role, tu_tenant_id
  FROM public.tenant_users
  WHERE id = auth_user_id
    AND active = true
  LIMIT 1;

  IF tu_role IS NOT NULL THEN
    -- Workspace assignments: NULL for owners (= see all), array for receptionists.
    SELECT ARRAY_AGG(uwa.workspace_id) INTO ws_ids
    FROM public.user_workspace_assignments uwa
    WHERE uwa.user_id = auth_user_id;

    app_meta := app_meta || jsonb_build_object(
      'user_type',     'tenant_user',
      'role',          tu_role,
      'tenant_id',     tu_tenant_id,
      'workspace_ids', to_jsonb(ws_ids)
    );
    RETURN jsonb_set(event, '{claims}', jsonb_set(claims, '{app_metadata}', app_meta));
  END IF;

  -- ── 3. Unknown user — return event unchanged ────────────────────────────────
  RETURN event;
END;
$$;

-- Allow supabase_auth_admin (the auth service role) to call this function.
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
-- Prevent anonymous/public invocations.
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;

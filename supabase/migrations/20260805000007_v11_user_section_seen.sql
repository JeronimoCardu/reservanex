-- =============================================================================
-- 20260805000007_v11_user_section_seen.sql
-- v1.1 — Tabla para tracking de badges de secciones por usuario/tenant.
--
-- Seguridad:
--   - RLS habilitada con policy USING (false): ningún rol autenticado puede
--     leer/escribir directamente. service_role bypass RLS por diseño de Supabase.
--   - REVOKE ALL de anon y authenticated: bloqueo a nivel de privilegio también.
--   - El acceso legítimo es exclusivamente vía Server Actions con createAdminClient().
--
-- IDEMPOTENTE: CREATE TABLE IF NOT EXISTS + DO $$ para policy
-- =============================================================================

BEGIN;

-- ── Tabla ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_section_seen (
  tenant_id     UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES public.tenant_users(id) ON DELETE CASCADE,
  section       TEXT        NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, user_id, section)
);

-- CHECK idempotente para section
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_section_seen_section_check'
      AND conrelid = 'public.user_section_seen'::regclass
  ) THEN
    ALTER TABLE public.user_section_seen
      ADD CONSTRAINT user_section_seen_section_check
      CHECK (section IN ('conversations', 'reservations', 'tasks', 'payments'));
  END IF;
END $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_section_seen ENABLE ROW LEVEL SECURITY;

-- Policy de denegación total: ningún row pasa el filtro para anon/authenticated.
-- service_role no está sujeto a RLS y accede libremente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_section_seen'
      AND policyname = 'user_section_seen_deny_all'
  ) THEN
    CREATE POLICY user_section_seen_deny_all
      ON public.user_section_seen
      FOR ALL
      USING (false);
  END IF;
END $$;

-- ── Privilegios ───────────────────────────────────────────────────────────────

-- Revocar privilegios de tabla de todos los roles que acceden vía JWT.
-- service_role tiene acceso total por defecto en Supabase y no necesita GRANT explícito.
REVOKE ALL ON public.user_section_seen FROM anon;
REVOKE ALL ON public.user_section_seen FROM authenticated;

COMMIT;

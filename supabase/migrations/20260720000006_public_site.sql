-- =============================================================================
-- public_site
-- Agrega campos de sitio público a tenants y properties.
-- =============================================================================

BEGIN;

-- ── 1. tenants: campos de sitio público ──────────────────────────────────────
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS public_slug             TEXT,
  ADD COLUMN IF NOT EXISTS public_site_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_name             TEXT,
  ADD COLUMN IF NOT EXISTS public_description      TEXT,
  ADD COLUMN IF NOT EXISTS public_cover_image_url  TEXT,
  ADD COLUMN IF NOT EXISTS public_primary_color    TEXT,
  ADD COLUMN IF NOT EXISTS public_phone            TEXT,
  ADD COLUMN IF NOT EXISTS public_email            TEXT,
  ADD COLUMN IF NOT EXISTS public_instagram_url    TEXT,
  ADD COLUMN IF NOT EXISTS public_website_url      TEXT;

-- Unique index: public_slug es único entre tenants activos
CREATE UNIQUE INDEX IF NOT EXISTS tenants_public_slug_unique
  ON public.tenants (public_slug)
  WHERE public_slug IS NOT NULL AND deleted_at IS NULL;

-- Format check: solo lowercase alfanumérico + guiones, mínimo 3 chars
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_public_slug_format'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_public_slug_format
      CHECK (
        public_slug IS NULL
        OR (
          public_slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'
          AND length(public_slug) >= 3
          AND public_slug NOT IN (
            'dashboard','login','auth','api','admin','site',
            'platform','settings','properties','property'
          )
        )
      );
  END IF;
END $$;

-- ── 2. properties: campos de sitio público ───────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS slug                      TEXT,
  ADD COLUMN IF NOT EXISTS public_code               TEXT,
  ADD COLUMN IF NOT EXISTS show_exact_address_public BOOLEAN NOT NULL DEFAULT false;

-- Unique: slug por tenant
CREATE UNIQUE INDEX IF NOT EXISTS properties_slug_unique
  ON public.properties (tenant_id, slug)
  WHERE slug IS NOT NULL AND deleted_at IS NULL;

-- Unique: public_code por tenant
CREATE UNIQUE INDEX IF NOT EXISTS properties_public_code_unique
  ON public.properties (tenant_id, public_code)
  WHERE public_code IS NOT NULL;

-- ── 3. Recrear tenants_public view con nuevos campos ─────────────────────────
DROP VIEW IF EXISTS public.tenants_public;

CREATE VIEW public.tenants_public AS
  SELECT
    id,
    name,
    slug,
    logo_url,
    primary_color,
    secondary_color,
    site_config,
    custom_domain,
    public_slug,
    public_site_enabled,
    public_name,
    public_description,
    public_cover_image_url,
    public_primary_color,
    public_phone,
    public_email,
    public_instagram_url,
    public_website_url
  FROM public.tenants
  WHERE deleted_at IS NULL;

COMMENT ON VIEW public.tenants_public IS
  'Public-safe tenant fields for anon access (public website). Excludes plan, billing, and limit fields.';

-- Restore GRANT (view recreation removes grants)
GRANT SELECT ON public.tenants_public TO anon;
GRANT SELECT ON public.tenants_public TO authenticated;

COMMIT;

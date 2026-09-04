BEGIN;

-- Add logo/cover upload fields to tenants
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS public_logo_url              TEXT,
  ADD COLUMN IF NOT EXISTS public_logo_storage_path     TEXT,
  ADD COLUMN IF NOT EXISTS public_cover_image_storage_path TEXT;

-- Create public bucket for tenant assets (logo, cover image)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tenant-public-assets',
  'tenant-public-assets',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Backfill public_code for any published properties that don't have one yet
UPDATE public.properties
SET public_code = 'OF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))
WHERE public_code IS NULL;

COMMIT;

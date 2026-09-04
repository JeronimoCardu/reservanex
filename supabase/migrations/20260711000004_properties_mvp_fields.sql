-- =============================================================================
-- properties_mvp_fields
-- Agrega campos MVP a properties y alt a property_images.
-- No toca RLS, worker, units, ni migraciones ya aplicadas.
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS + DO $$ para constraints.
-- =============================================================================

-- ── properties ────────────────────────────────────────────────────────────────
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS cover_image_url  TEXT,
  ADD COLUMN IF NOT EXISTS location_label   TEXT,
  ADD COLUMN IF NOT EXISTS internal_address TEXT,
  ADD COLUMN IF NOT EXISTS capacity         INTEGER,
  ADD COLUMN IF NOT EXISTS area_m2          NUMERIC,
  ADD COLUMN IF NOT EXISTS custom_fields    JSONB NOT NULL DEFAULT '[]'::jsonb;

-- CHECK: capacity debe ser positivo si se especifica
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_capacity_positive'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_capacity_positive
      CHECK (capacity IS NULL OR capacity > 0);
  END IF;
END $$;

-- CHECK: area_m2 debe ser positivo si se especifica
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_area_m2_positive'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_area_m2_positive
      CHECK (area_m2 IS NULL OR area_m2 > 0);
  END IF;
END $$;

-- CHECK: custom_fields debe ser un array JSON (nunca objeto u otro tipo)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'properties_custom_fields_is_array'
      AND conrelid = 'public.properties'::regclass
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_custom_fields_is_array
      CHECK (jsonb_typeof(custom_fields) = 'array');
  END IF;
END $$;

-- ── property_images ───────────────────────────────────────────────────────────
-- La tabla ya existe en el schema base con (id, property_id, image_url,
-- sort_order, is_cover, created_at). Solo agregamos alt para texto alternativo.
ALTER TABLE public.property_images
  ADD COLUMN IF NOT EXISTS alt TEXT;

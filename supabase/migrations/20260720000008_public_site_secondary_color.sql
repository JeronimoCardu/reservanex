ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS public_secondary_color TEXT;

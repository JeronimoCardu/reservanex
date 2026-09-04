-- =============================================================================
-- property_images_storage_and_rls
-- 1. Agrega columna alt a property_images (idempotente con 000004).
-- 2. Recrea policies de property_images sin lógica legacy de workspaces.
-- 3. Crea bucket property-images en Supabase Storage.
-- 4. Crea policies de storage para el bucket.
--
-- MVP: RLS tenant-level, sin workspaces. Owner tiene full access.
-- Receptionist puede SELECT siempre; INSERT/UPDATE/DELETE solo si
-- can_create_properties = true.
-- =============================================================================

-- ── 1. alt en property_images ─────────────────────────────────────────────────
ALTER TABLE public.property_images
  ADD COLUMN IF NOT EXISTS alt TEXT;


-- ── 2. RLS property_images — eliminar policies legacy con workspaces ──────────

DROP POLICY IF EXISTS "sa_imp_all_property_images"          ON public.property_images;
DROP POLICY IF EXISTS "owner_all_property_images"           ON public.property_images;
DROP POLICY IF EXISTS "receptionist_all_property_images"    ON public.property_images;
DROP POLICY IF EXISTS "anon_select_property_images"         ON public.property_images;
-- New names (por si se ejecutó 000005 y después se vuelve a correr)
DROP POLICY IF EXISTS "receptionist_select_property_images" ON public.property_images;
DROP POLICY IF EXISTS "receptionist_insert_property_images" ON public.property_images;
DROP POLICY IF EXISTS "receptionist_update_property_images" ON public.property_images;
DROP POLICY IF EXISTS "receptionist_delete_property_images" ON public.property_images;

-- Super admin impersonation — sin cambios respecto al original
CREATE POLICY "sa_imp_all_property_images"
ON public.property_images FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
);

-- Owner: acceso total a imágenes de propiedades de su tenant
CREATE POLICY "owner_all_property_images"
ON public.property_images FOR ALL TO authenticated
USING (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
)
WITH CHECK (
  public.is_owner()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
);

-- Receptionist SELECT: cualquier recepcionista puede ver imágenes de propiedades
-- activas de su tenant (para el CRM y la vista de detalle).
CREATE POLICY "receptionist_select_property_images"
ON public.property_images FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
      AND p.deleted_at IS NULL
  )
);

-- Receptionist INSERT: solo con can_create_properties = true
CREATE POLICY "receptionist_insert_property_images"
ON public.property_images FOR INSERT TO authenticated
WITH CHECK (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND tu.can_create_properties = true
  )
);

-- Receptionist UPDATE: mismo guard que INSERT
CREATE POLICY "receptionist_update_property_images"
ON public.property_images FOR UPDATE TO authenticated
USING (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND tu.can_create_properties = true
  )
)
WITH CHECK (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND tu.can_create_properties = true
  )
);

-- Receptionist DELETE: mismo guard que INSERT
CREATE POLICY "receptionist_delete_property_images"
ON public.property_images FOR DELETE TO authenticated
USING (
  public.is_receptionist()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_images.property_id
      AND p.tenant_id = public.auth_tenant_id()
  )
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND tu.can_create_properties = true
  )
);

-- Anon SELECT: solo imágenes de propiedades publicadas (para sitio público)
CREATE POLICY "anon_select_property_images"
ON public.property_images FOR SELECT TO anon
USING (
  EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id         = property_images.property_id
      AND p.published  = true
      AND p.deleted_at IS NULL
  )
);


-- ── 3. Bucket property-images ─────────────────────────────────────────────────
-- Público: las URLs son accesibles sin auth. Uploads restringidos por policies.
-- file_size_limit: 5 MB. allowed_mime_types: JPG, PNG, WebP.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-images',
  'property-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public             = true,
  file_size_limit    = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];


-- ── 4. Policies de storage.objects ────────────────────────────────────────────
-- Path convention: property-images/{tenant_id}/{uuid}.{ext}
-- storage.foldername(name) devuelve el array de segmentos del path sin el filename.
-- (storage.foldername(name))[1] es el tenant_id.

DROP POLICY IF EXISTS "public_read_property_images_storage"       ON storage.objects;
DROP POLICY IF EXISTS "tenant_insert_property_images_storage"     ON storage.objects;
DROP POLICY IF EXISTS "tenant_update_property_images_storage"     ON storage.objects;
DROP POLICY IF EXISTS "tenant_delete_property_images_storage"     ON storage.objects;

-- SELECT público (el bucket ya es público, pero la policy es explícita para anon)
CREATE POLICY "public_read_property_images_storage"
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'property-images');

-- INSERT: owner o receptionist con can_create_properties
-- El primer segmento del path debe ser el tenant_id del usuario.
CREATE POLICY "tenant_insert_property_images_storage"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'property-images'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_create_properties = true)
  )
);

-- UPDATE: mismo guard que INSERT
CREATE POLICY "tenant_update_property_images_storage"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'property-images'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_create_properties = true)
  )
)
WITH CHECK (
  bucket_id = 'property-images'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
);

-- DELETE: mismo guard que INSERT
CREATE POLICY "tenant_delete_property_images_storage"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'property-images'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_create_properties = true)
  )
);

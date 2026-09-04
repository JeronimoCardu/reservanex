-- =============================================================================
-- property_videos
-- Tabla y bucket privado para videos cortos de propiedades (sitio público).
-- Máximo 2 videos por propiedad, max 60 segundos, max 80 MB.
-- Servidos vía /api/property-videos/[videoId] (sin URLs firmadas).
-- =============================================================================

-- ── Tabla ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.property_videos (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES public.tenants(id)    ON DELETE CASCADE,
  property_id      UUID        NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  storage_path     TEXT        NOT NULL,
  title            TEXT,
  mime_type        TEXT        NOT NULL,
  file_size_bytes  BIGINT      NOT NULL,
  duration_seconds INTEGER     CHECK (duration_seconds IS NULL OR duration_seconds <= 60),
  sort_order       INTEGER     NOT NULL DEFAULT 0,
  created_by       UUID        REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_property_videos_property ON public.property_videos (property_id, sort_order ASC);
CREATE INDEX idx_property_videos_tenant   ON public.property_videos (tenant_id);

ALTER TABLE public.property_videos ENABLE ROW LEVEL SECURITY;


-- ── RLS ───────────────────────────────────────────────────────────────────────

-- Super admin impersonation
CREATE POLICY "sa_imp_all_property_videos"
ON public.property_videos FOR ALL TO authenticated
USING (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_videos.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
)
WITH CHECK (
  public.is_super_admin()
  AND EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id        = property_videos.property_id
      AND p.tenant_id = public.auth_impersonating_tenant_id()
  )
);

-- Owner: acceso completo a videos de su tenant
CREATE POLICY "owner_all_property_videos"
ON public.property_videos FOR ALL TO authenticated
USING (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
)
WITH CHECK (
  public.is_owner()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionist SELECT: puede ver videos de propiedades de su tenant
CREATE POLICY "receptionist_select_property_videos"
ON public.property_videos FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
);

-- Receptionist INSERT: requiere can_create_properties = true
CREATE POLICY "receptionist_insert_property_videos"
ON public.property_videos FOR INSERT TO authenticated
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND tu.can_create_properties = true
  )
);

-- Receptionist DELETE: requiere can_create_properties = true
CREATE POLICY "receptionist_delete_property_videos"
ON public.property_videos FOR DELETE TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND tu.can_create_properties = true
  )
);

-- Anon: sin acceso directo — los videos se sirven via API route con admin client.


-- ── Bucket property-videos (privado) ─────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-videos',
  'property-videos',
  false,
  83886080,
  ARRAY['video/mp4', 'video/webm', 'video/quicktime']
)
ON CONFLICT (id) DO UPDATE SET
  public             = false,
  file_size_limit    = 83886080,
  allowed_mime_types = ARRAY['video/mp4', 'video/webm', 'video/quicktime'];


-- ── Policies de storage.objects ───────────────────────────────────────────────
-- Path convention: property-videos/{tenant_id}/{uuid}.{ext}

DROP POLICY IF EXISTS "tenant_select_property_videos_storage" ON storage.objects;
DROP POLICY IF EXISTS "tenant_insert_property_videos_storage" ON storage.objects;
DROP POLICY IF EXISTS "tenant_delete_property_videos_storage" ON storage.objects;

-- SELECT: usuarios autenticados del tenant (para vista previa en dashboard)
CREATE POLICY "tenant_select_property_videos_storage"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'property-videos'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
);

-- INSERT: owner o receptionist con can_create_properties
CREATE POLICY "tenant_insert_property_videos_storage"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'property-videos'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_create_properties = true)
  )
);

-- DELETE: mismo guard que INSERT
CREATE POLICY "tenant_delete_property_videos_storage"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'property-videos'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_create_properties = true)
  )
);

-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3A2 — imagen opcional por producto del menú
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── UNA IMAGEN POR ITEM, EN LA PROPIA FILA ──────────────────────────────────
--
-- Sin tabla menu_item_images. property_images existe porque una propiedad tiene
-- una GALERÍA; un plato tiene una foto. Una tabla hija para una relación 1–1
-- sería una junta en cada lectura del menú público a cambio de nada.
--
-- ── POR QUÉ LAS DOS COLUMNAS VAN JUNTAS (y esto es MÁS estricto que properties) ─
--
-- Auditado antes de decidirlo, no asumido:
--
--   · No existe NINGÚN CHECK de coherencia url/storage_path en todo el proyecto.
--   · property_images.storage_path es NULLABLE y propertyImageSchema lo declara
--     optional, o sea que el esquema de propiedades SÍ admite una URL suelta.
--   · Pero el único writer real de imágenes de propiedades es
--     uploadPropertyImageAction(), que siempre devuelve las dos cosas. La
--     nullability es una puerta que nadie usa.
--
-- Acá las imágenes las gestiona ReservaNex: el único writer va a ser
-- uploadMenuImageAction(), que sube al bucket y devuelve url + path juntos. No
-- hay forma de pegar una URL externa, ni se planea. Entonces la coherencia se
-- vuelve un invariante REAL y conviene que la base lo sostenga:
--
--   · un image_url sin storage_path sería un archivo que la purga de tenant no
--     puede encontrar — basura permanente en Storage;
--   · un storage_path sin image_url sería un archivo pago que nadie muestra.
--
-- Las dos, o ninguna. Es deliberadamente más estricto que property_images, y la
-- diferencia está justificada por quién escribe cada tabla.
--
-- Sin backfill: menu_items no tiene ninguna fila con imagen porque las columnas
-- no existían.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS image_url          TEXT,
  ADD COLUMN IF NOT EXISTS image_storage_path TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_items_image_coherence_check'
                 AND conrelid='public.menu_items'::regclass) THEN
    ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_image_coherence_check
      CHECK (
        (image_url IS NULL     AND image_storage_path IS NULL) OR
        (image_url IS NOT NULL AND image_storage_path IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_items_image_url_length_check'
                 AND conrelid='public.menu_items'::regclass) THEN
    ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_image_url_length_check
      CHECK (image_url IS NULL OR (length(image_url) > 0 AND length(image_url) <= 1000));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='menu_items_image_path_length_check'
                 AND conrelid='public.menu_items'::regclass) THEN
    ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_image_path_length_check
      CHECK (image_storage_path IS NULL OR (length(image_storage_path) > 0 AND length(image_storage_path) <= 500));
  END IF;
END $$;

COMMENT ON COLUMN public.menu_items.image_url IS
  'Fase 3E-C3A2: URL pública de la foto del producto, en el bucket menu-images. '
  'Va SIEMPRE junto con image_storage_path (menu_items_image_coherence_check). '
  'Es el único de los dos que puede viajar al browser.';

COMMENT ON COLUMN public.menu_items.image_storage_path IS
  'Fase 3E-C3A2: ruta dentro del bucket menu-images, con el formato '
  '{tenant_id}/{uuid}.{ext}. NUNCA se expone en el sitio público: es interna y '
  'sirve para reemplazar, borrar y purgar el archivo cuando se elimina el '
  'tenant. Sin ella, el archivo quedaría huérfano para siempre porque Storage '
  'no tiene ON DELETE CASCADE.';


-- ── Bucket ──────────────────────────────────────────────────────────────────
--
-- Propio, y no tenant-public-assets, por lo que dice §3: ese bucket NO tiene ni
-- una policy en storage.objects —se escribe con service_role desde el server
-- action— así que reutilizarlo significaría renunciar a la defensa en la base.
-- menu-images espeja property-images, que es el patrón con policies reales.
--
-- Público en lectura: la carta es pública por definición. Mismos límites que
-- property-images (5 MB, jpeg/png/webp), que son los que el producto ya validó.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'menu-images',
  'menu-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public             = true,
  file_size_limit    = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];


-- ── Policies de storage.objects ─────────────────────────────────────────────
--
-- Convención de path: menu-images/{tenant_id}/{uuid}.{ext}
-- (storage.foldername(name))[1] es el tenant_id.
--
-- NO hay policy de UPDATE, y es deliberado: cada subida usa un uuid nuevo con
-- upsert:false, así que nunca se sobreescribe un objeto existente. Reemplazar
-- una imagen es subir otra y borrar la anterior. Conceder UPDATE sería
-- superficie para una operación que el producto no hace.
--
-- Tampoco hay policies de operador de setup. property-images las tiene porque un
-- operador carga propiedades durante el onboarding; el catálogo gastronómico lo
-- administra el tenant, y §4 lo fija: la impersonación de plataforma NO escribe.

DROP POLICY IF EXISTS "public_read_menu_images_storage"   ON storage.objects;
DROP POLICY IF EXISTS "tenant_insert_menu_images_storage" ON storage.objects;
DROP POLICY IF EXISTS "tenant_delete_menu_images_storage" ON storage.objects;

-- Lectura pública. El bucket ya es público; la policy lo hace explícito para anon.
CREATE POLICY "public_read_menu_images_storage"
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'menu-images');

-- Escritura: el primer segmento del path tiene que ser el tenant REAL del
-- usuario (auth_tenant_id(), que para un platform_user es NULL), y el usuario
-- tiene que ser owner o tener can_manage_menu. El mismo par de condiciones que
-- las policies de menu_items.
CREATE POLICY "tenant_insert_menu_images_storage"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'menu-images'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_manage_menu = true)
  )
);

-- DELETE: hace falta de verdad — para "Quitar imagen" y para borrar la anterior
-- al reemplazar. Mismo guard.
CREATE POLICY "tenant_delete_menu_images_storage"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'menu-images'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_manage_menu = true)
  )
);

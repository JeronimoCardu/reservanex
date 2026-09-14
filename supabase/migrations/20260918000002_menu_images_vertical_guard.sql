-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3A2 — el bucket menu-images también es solo de food_service
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── LO QUE FALTABA ──────────────────────────────────────────────────────────
--
-- Las policies de 20260918000001 exigen tenant propio Y (owner OR
-- can_manage_menu). Ninguna de las dos condiciones mira el RUBRO, así que el
-- owner de un tenant inmobiliario las cumple: podía subir archivos a
-- menu-images/{su_tenant}/ aunque el catálogo no exista para él.
--
-- El daño era acotado —el archivo caía en su propia carpeta y no podía
-- colgarlo de ningún menu_item, porque guard_menu_tenant_vertical impide crear
-- filas de catálogo en un tenant real_estate— pero es basura que alguien paga y
-- que nadie puede mostrar. Y sobre todo es una incoherencia: la misma pregunta
-- ("¿este tenant tiene menú?") contestada distinto por la tabla y por el bucket.
--
-- ── MISMO INVARIANTE, MISMA RESPUESTA ───────────────────────────────────────
--
-- Se agrega la condición de rubro a las dos policies de escritura. Es la
-- traducción a storage de guard_menu_tenant_vertical: el catálogo —filas y
-- archivos— es exclusivo de food_service.
--
-- La lectura pública NO cambia: sigue abierta para anon sobre todo el bucket,
-- porque las cartas son públicas y porque un archivo de un tenant que cambió de
-- rubro tiene que seguir siendo legible hasta que se purgue.
--
-- Se usa una subconsulta a tenants dentro de la policy, no una función: es una
-- sola fila por id primaria, y mantenerlo inline deja la condición completa a la
-- vista de quien audite la policy.
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "tenant_insert_menu_images_storage" ON storage.objects;
CREATE POLICY "tenant_insert_menu_images_storage"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'menu-images'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.id = public.auth_tenant_id()
      AND t.vertical = 'food_service'
  )
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_manage_menu = true)
  )
);

DROP POLICY IF EXISTS "tenant_delete_menu_images_storage" ON storage.objects;
CREATE POLICY "tenant_delete_menu_images_storage"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'menu-images'
  AND (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  AND EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.id = public.auth_tenant_id()
      AND t.vertical = 'food_service'
  )
  AND EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND (tu.role = 'owner' OR tu.can_manage_menu = true)
  )
);

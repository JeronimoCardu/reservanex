-- =============================================================================
-- property_image_storage_paths_and_delete_cleanup
-- 1. Agrega storage_path a property_images (path dentro del bucket property-images).
-- 2. Agrega cover_image_storage_path a properties.
--
-- Estos paths se usan para borrar objetos de Supabase Storage cuando el usuario
-- reemplaza o elimina imágenes desde la UI.
--
-- Columnas existentes (image_url / cover_image_url) se mantienen — son URLs públicas
-- que se siguen usando para renderizar. Los paths son datos operativos internos.
-- =============================================================================

ALTER TABLE public.property_images
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS cover_image_storage_path TEXT;

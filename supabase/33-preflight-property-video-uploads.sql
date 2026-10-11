-- ════════════════════════════════════════════════════════════════════════════
-- Property Videos 2B1 — preflight de SOLO LECTURA antes de aplicar
-- 20261009000001_property_video_uploads.sql
-- ════════════════════════════════════════════════════════════════════════════
--
-- No escribe nada: abre una transacción READ ONLY y termina con ROLLBACK.
-- Devuelve UNA fila con conteos y booleanos (nunca valores de datos).
--
-- Para aplicar la migración tiene que dar:
--   duplicated_paths = 0, tenant_mismatch = 0, foreign_prefix = 0,
--   over_capacity = 0, uploads_table_exists = false,
--   conflicting_constraints = 0, conflicting_functions = 0,
--   created_by_fkey_exists = true, storage_identity_columns = 4,
--   tenant_status_enum_ok = true
--
-- admin_purge_tenant_md5 tiene que ser IGUAL al que da este mismo script en el
-- lab ANTES de aplicar la migración: la migración reemplaza la función con el
-- cuerpo de 20260920000006 + un DELETE, y si producción tuviera otro cuerpo,
-- ese cambio se perdería.

BEGIN TRANSACTION READ ONLY;

SELECT jsonb_build_object(
  'duplicated_paths', (
    SELECT count(*) FROM (
      SELECT storage_path FROM public.property_videos GROUP BY storage_path HAVING count(*) > 1
    ) d),
  'tenant_mismatch', (
    SELECT count(*) FROM public.property_videos v
    JOIN public.properties p ON p.id = v.property_id
    WHERE p.tenant_id <> v.tenant_id),
  'foreign_prefix', (
    SELECT count(*) FROM public.property_videos v
    WHERE v.storage_path !~ ('^' || v.tenant_id::text || '/[A-Za-z0-9._-]+$')),
  'over_capacity', (
    SELECT count(*) FROM (
      SELECT property_id FROM public.property_videos GROUP BY property_id HAVING count(*) > 2
    ) o),
  'property_videos_total', (SELECT count(*) FROM public.property_videos),
  'uploads_table_exists', to_regclass('public.property_video_uploads') IS NOT NULL,
  'conflicting_constraints', (
    SELECT count(*) FROM pg_constraint
    WHERE conname IN (
      'properties_id_tenant_id_key',
      'property_videos_storage_path_key',
      'property_videos_storage_path_tenant_check',
      'property_videos_property_tenant_fkey')),
  'conflicting_functions', (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'reserve_property_video_upload', 'cancel_property_video_upload',
      'fail_property_video_upload', 'get_property_video_upload_object',
      'finalize_property_video_upload', 'property_videos_enforce_capacity',
      'property_videos_guard_identity')),
  'conflicting_triggers', (
    SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'public.property_videos'::regclass AND NOT tgisinternal),
  'created_by_fkey_exists', EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'property_videos_created_by_fkey'
      AND conrelid = 'public.property_videos'::regclass),
  -- Las RPCs leen la identidad del objeto vigente con estas 4 columnas.
  'storage_identity_columns', (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'objects'
      AND column_name IN ('version', 'metadata', 'archived_at', 'is_delete_marker')),
  'tenant_status_enum_ok', (
    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) @> ARRAY['trial', 'active']
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'tenant_status'),
  'property_videos_bucket_private', (
    SELECT NOT public FROM storage.buckets WHERE id = 'property-videos'),
  'admin_purge_tenant_md5', (
    SELECT md5(pg_get_functiondef('public.admin_purge_tenant(uuid)'::regprocedure)))
) AS preflight;

ROLLBACK;

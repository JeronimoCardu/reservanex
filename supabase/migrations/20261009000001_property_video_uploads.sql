-- ════════════════════════════════════════════════════════════════════════════
-- Property Videos 2B1 — reservas de subida (prepare → TUS → finalize) e
-- invariantes de property_videos en la base
-- ════════════════════════════════════════════════════════════════════════════
--
-- COMPATIBLE CON EL UPLOADER LEGACY. uploadPropertyVideoAction sigue siendo la
-- subida productiva hasta la Fase 2B7: esta migración NO toca las policies que
-- usa (INSERT de property_videos y de storage.objects). Lo que sí cierra YA,
-- para cualquier escritor (legacy, finalize o PostgREST directo):
--
--   · property_id de otro tenant      → FK compuesta (property_id, tenant_id);
--   · storage_path de otro tenant     → CHECK: el path vive en la carpeta del tenant;
--   · mismo objeto registrado 2 veces → UNIQUE (storage_path);
--   · más de 2 videos por propiedad   → trigger BEFORE INSERT con la propiedad
--                                       como mutex (cuenta videos + reservas vivas);
--   · cambiar tenant/propiedad/path   → trigger BEFORE UPDATE que los vuelve inmutables;
--   · created_by que impide borrar un usuario de auth → ON DELETE SET NULL.
--
-- El endurecimiento final (authenticated sólo SELECT sobre property_videos, sin
-- INSERT en storage.objects) queda para la migración de la Fase 2B7, cuando se
-- retire el legacy.
--
-- ORDEN GLOBAL DE LOCKS (todas las funciones, el trigger y admin_purge_tenant
-- lo respetan):
--
--   properties (FOR UPDATE)  →  property_video_uploads (FOR UPDATE)  →  property_videos (INSERT)
--
-- La propiedad es el mutex del cupo: quien cuenta, la tiene bloqueada.
--
-- TTL: la reserva NO congela 2 h 30 min. El backend manda p_expires_at (atado
-- a la vida del token de createSignedUploadUrl) y la base sólo exige un rango
-- defensivo: después de ahora y como mucho 3 horas. Todavía no está verificado
-- si Storage revalida x-signature en cada PATCH de una sesión TUS; cuando se
-- verifique, el valor se ajusta en el backend sin tocar el esquema.
--
-- "Expirada" NO es un estado: es status = 'reserved' AND expires_at <= now().
-- Una reserva vencida no consume cupo y finalize la rechaza.
--
-- TOCTOU de finalize: la acción lee la identidad del objeto vigente en
-- storage.objects (id + version) ANTES de inspeccionarlo por HTTP, y finalize
-- vuelve a leerla DENTRO de su transacción: si cambió (borrado y re-subido,
-- sobrescrito), no registra nada. Medido contra Storage real (2B1.1): un
-- overwrite (upload con upsert o PUT) CONSERVA el id y cambia version; borrar
-- y volver a subir —aunque sea el mismo contenido— cambia los dos. Por eso se
-- comparan id Y version: con id solo, un overwrite pasaría.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 0. Preflight: los datos existentes tienen que cumplir las invariantes ─────
-- Falla con conteos (nunca con valores) si alguna fila es incompatible. La misma
-- consulta, de sólo lectura, está en supabase/33-preflight-property-video-uploads.sql
-- para correrla contra producción antes de aplicar.

DO $$
DECLARE
  v_duplicated_paths   integer;
  v_tenant_mismatch    integer;
  v_foreign_prefix     integer;
  v_over_capacity      integer;
BEGIN
  SELECT count(*) INTO v_duplicated_paths
  FROM (SELECT storage_path FROM public.property_videos GROUP BY storage_path HAVING count(*) > 1) d;

  SELECT count(*) INTO v_tenant_mismatch
  FROM public.property_videos v
  JOIN public.properties p ON p.id = v.property_id
  WHERE p.tenant_id <> v.tenant_id;

  SELECT count(*) INTO v_foreign_prefix
  FROM public.property_videos v
  WHERE v.storage_path !~ ('^' || v.tenant_id::text || '/[A-Za-z0-9._-]+$');

  SELECT count(*) INTO v_over_capacity
  FROM (SELECT property_id FROM public.property_videos GROUP BY property_id HAVING count(*) > 2) o;

  IF v_duplicated_paths + v_tenant_mismatch + v_foreign_prefix + v_over_capacity > 0 THEN
    RAISE EXCEPTION 'preflight property_videos: % storage_path duplicados, % videos con tenant distinto al de su propiedad, % storage_path fuera de la carpeta del tenant, % propiedades con más de 2 videos',
      v_duplicated_paths, v_tenant_mismatch, v_foreign_prefix, v_over_capacity;
  END IF;
END
$$;


-- ── 1. properties: clave (id, tenant_id) para FKs que atan el tenant ─────────

ALTER TABLE public.properties
  ADD CONSTRAINT properties_id_tenant_id_key UNIQUE (id, tenant_id);


-- ── 2. property_video_uploads ────────────────────────────────────────────────

CREATE TABLE public.property_video_uploads (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  property_id    uuid        NOT NULL,
  -- Idempotencia de prepare: el cliente genera un UUID por selección de
  -- archivo; un reintento con el mismo request_id devuelve la misma reserva.
  request_id     uuid        NOT NULL,
  storage_path   text        NOT NULL,
  mime_type      text        NOT NULL,
  status         text        NOT NULL DEFAULT 'reserved',
  failure_reason text,
  expires_at     timestamptz NOT NULL,
  created_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,

  CONSTRAINT property_video_uploads_property_tenant_fkey
    FOREIGN KEY (property_id, tenant_id) REFERENCES public.properties (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT property_video_uploads_storage_path_key UNIQUE (storage_path),
  CONSTRAINT property_video_uploads_request_key UNIQUE (tenant_id, request_id),
  CONSTRAINT property_video_uploads_mime_type_check
    CHECK (mime_type IN ('video/mp4', 'video/webm', 'video/quicktime')),
  CONSTRAINT property_video_uploads_status_check
    CHECK (status IN ('reserved', 'completed', 'cancelled', 'failed')),
  -- El path es una función del id, el tenant y el MIME: <tenant>/<id>.<ext>.
  CONSTRAINT property_video_uploads_storage_path_check
    CHECK (storage_path = tenant_id::text || '/' || id::text || '.' ||
           CASE mime_type
             WHEN 'video/mp4'       THEN 'mp4'
             WHEN 'video/webm'      THEN 'webm'
             WHEN 'video/quicktime' THEN 'mov'
           END),
  CONSTRAINT property_video_uploads_resolved_check
    CHECK ((status = 'reserved') = (resolved_at IS NULL)),
  CONSTRAINT property_video_uploads_failure_check
    CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT property_video_uploads_failure_reason_check
    CHECK (failure_reason IS NULL OR failure_reason IN (
      'invalid_size', 'empty_file', 'file_too_large', 'mime_not_allowed',
      'content_mismatch', 'unrecognized_container', 'truncated_container',
      'malformed_container', 'invalid_timescale', 'duration_unavailable',
      'duration_invalid', 'duration_too_long', 'inspection_budget_exceeded',
      'object_mismatch', 'property_unavailable', 'tenant_unavailable', 'limit_reached'
    )),
  -- Rango defensivo del TTL (el valor real lo decide el backend).
  CONSTRAINT property_video_uploads_expiry_check
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '3 hours')
);

-- Reservas vivas por propiedad (conteo de cupo).
CREATE INDEX property_video_uploads_live_idx
  ON public.property_video_uploads (property_id, expires_at) WHERE status = 'reserved';
CREATE INDEX property_video_uploads_tenant_idx
  ON public.property_video_uploads (tenant_id);
-- Candidatas a limpieza (Fase 2B3): no completadas, por vencimiento.
CREATE INDEX property_video_uploads_cleanup_idx
  ON public.property_video_uploads (expires_at) WHERE status <> 'completed';
-- Retención de completadas (idempotencia de finalize).
CREATE INDEX property_video_uploads_completed_idx
  ON public.property_video_uploads (resolved_at) WHERE status = 'completed';

-- Sin acceso directo para nadie del lado del browser: ni policies ni grants.
-- service_role sólo puede LEER; toda escritura pasa por las funciones de abajo.
ALTER TABLE public.property_video_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.property_video_uploads FROM PUBLIC;
REVOKE ALL ON TABLE public.property_video_uploads FROM anon;
REVOKE ALL ON TABLE public.property_video_uploads FROM authenticated;
REVOKE ALL ON TABLE public.property_video_uploads FROM service_role;
GRANT SELECT ON TABLE public.property_video_uploads TO service_role;


-- ── 3. property_videos: invariantes (sin romper el legacy) ────────────────────

ALTER TABLE public.property_videos
  ADD CONSTRAINT property_videos_storage_path_key UNIQUE (storage_path),
  ADD CONSTRAINT property_videos_storage_path_tenant_check
    CHECK (storage_path ~ ('^' || tenant_id::text || '/[A-Za-z0-9._-]+$')),
  ADD CONSTRAINT property_videos_property_tenant_fkey
    FOREIGN KEY (property_id, tenant_id) REFERENCES public.properties (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE public.property_videos
  DROP CONSTRAINT property_videos_created_by_fkey,
  ADD CONSTRAINT property_videos_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Máximo 2 por propiedad, para CUALQUIER INSERT. SECURITY DEFINER: tiene que
-- contar todas las filas (incluidas las reservas, que authenticated no ve).
CREATE OR REPLACE FUNCTION public.property_videos_enforce_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_videos integer;
  v_live   integer;
BEGIN
  -- Mutex del cupo: la misma fila que bloquean reserve y finalize.
  PERFORM 1 FROM public.properties p
  WHERE p.id = NEW.property_id AND p.tenant_id = NEW.tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'property_video_property_mismatch' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*) INTO v_videos FROM public.property_videos v WHERE v.property_id = NEW.property_id;
  SELECT count(*) INTO v_live
  FROM public.property_video_uploads u
  WHERE u.property_id = NEW.property_id AND u.status = 'reserved' AND u.expires_at > now();

  IF v_videos + v_live >= 2 THEN
    RAISE EXCEPTION 'property_video_limit_reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER property_videos_enforce_capacity
  BEFORE INSERT ON public.property_videos
  FOR EACH ROW EXECUTE FUNCTION public.property_videos_enforce_capacity();

-- Identidad inmutable: tenant, propiedad y objeto no cambian después del INSERT.
CREATE OR REPLACE FUNCTION public.property_videos_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.tenant_id    IS DISTINCT FROM OLD.tenant_id
  OR NEW.property_id  IS DISTINCT FROM OLD.property_id
  OR NEW.storage_path IS DISTINCT FROM OLD.storage_path THEN
    RAISE EXCEPTION 'property_video_identity_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER property_videos_guard_identity
  BEFORE UPDATE ON public.property_videos
  FOR EACH ROW EXECUTE FUNCTION public.property_videos_guard_identity();


-- ── 4. reserve_property_video_upload ─────────────────────────────────────────
-- service_role-only. El tenant y el usuario los resuelve el servidor
-- (requireTenantContext); nada de esto viene del browser salvo property_id,
-- request_id y el MIME, que se validan acá.

CREATE OR REPLACE FUNCTION public.reserve_property_video_upload(
  p_tenant_id   uuid,
  p_property_id uuid,
  p_user_id     uuid,
  p_request_id  uuid,
  p_mime_type   text,
  p_expires_at  timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ext      text;
  v_existing public.property_video_uploads%ROWTYPE;
  v_videos   integer;
  v_live     integer;
  v_id       uuid;
  v_path     text;
BEGIN
  IF p_tenant_id IS NULL OR p_property_id IS NULL OR p_request_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  v_ext := CASE p_mime_type
             WHEN 'video/mp4'       THEN 'mp4'
             WHEN 'video/webm'      THEN 'webm'
             WHEN 'video/quicktime' THEN 'mov'
           END;
  IF v_ext IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_mime');
  END IF;

  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '3 hours' THEN
    RETURN jsonb_build_object('outcome', 'invalid_expiry');
  END IF;

  PERFORM 1 FROM public.tenants t
  WHERE t.id = p_tenant_id AND t.deleted_at IS NULL AND t.status IN ('trial', 'active');
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'tenant_unavailable');
  END IF;

  -- 1º lock: la propiedad (mutex del cupo).
  PERFORM 1 FROM public.properties p
  WHERE p.id = p_property_id AND p.tenant_id = p_tenant_id AND p.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'property_not_found');
  END IF;

  -- Reintento del mismo prepare (bajo el lock): misma reserva, sin otro cupo.
  SELECT * INTO v_existing
  FROM public.property_video_uploads u
  WHERE u.tenant_id = p_tenant_id AND u.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.property_id <> p_property_id
       OR v_existing.mime_type <> p_mime_type
       OR v_existing.created_by IS DISTINCT FROM p_user_id THEN
      RETURN jsonb_build_object('outcome', 'request_conflict');
    END IF;
    IF v_existing.status = 'reserved' AND v_existing.expires_at > now() THEN
      RETURN jsonb_build_object(
        'outcome', 'reserved', 'already', true,
        'upload_id', v_existing.id, 'storage_path', v_existing.storage_path, 'expires_at', v_existing.expires_at);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_already_used');
  END IF;

  SELECT count(*) INTO v_videos FROM public.property_videos v WHERE v.property_id = p_property_id;
  SELECT count(*) INTO v_live
  FROM public.property_video_uploads u
  WHERE u.property_id = p_property_id AND u.status = 'reserved' AND u.expires_at > now();
  IF v_videos + v_live >= 2 THEN
    RETURN jsonb_build_object('outcome', 'limit_reached');
  END IF;

  v_id   := gen_random_uuid();
  v_path := p_tenant_id::text || '/' || v_id::text || '.' || v_ext;

  INSERT INTO public.property_video_uploads
    (id, tenant_id, property_id, request_id, storage_path, mime_type, status, expires_at, created_by)
  VALUES
    (v_id, p_tenant_id, p_property_id, p_request_id, v_path, p_mime_type, 'reserved', p_expires_at, p_user_id);

  RETURN jsonb_build_object(
    'outcome', 'reserved', 'already', false,
    'upload_id', v_id, 'storage_path', v_path, 'expires_at', p_expires_at);
EXCEPTION
  -- Mismo request_id reusado para OTRA propiedad en paralelo: no hay lock común.
  WHEN unique_violation THEN
    RETURN jsonb_build_object('outcome', 'request_conflict');
END;
$$;


-- ── 5. cancel_property_video_upload ──────────────────────────────────────────
-- reserved → cancelled. Idempotente; nunca deshace un completed.

CREATE OR REPLACE FUNCTION public.cancel_property_video_upload(
  p_tenant_id uuid,
  p_upload_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_property_id uuid;
  v_upload      public.property_video_uploads%ROWTYPE;
BEGIN
  SELECT u.property_id INTO v_property_id
  FROM public.property_video_uploads u
  WHERE u.id = p_upload_id AND u.tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  PERFORM 1 FROM public.properties p WHERE p.id = v_property_id FOR UPDATE;
  SELECT * INTO v_upload FROM public.property_video_uploads u WHERE u.id = p_upload_id FOR UPDATE;
  -- Pudo desaparecer mientras se esperaba el lock (purge del tenant, borrado
  -- de la propiedad en cascada).
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_upload.status = 'reserved' THEN
    UPDATE public.property_video_uploads
    SET status = 'cancelled', resolved_at = now()
    WHERE id = p_upload_id;
    RETURN jsonb_build_object('outcome', 'cancelled', 'already', false, 'storage_path', v_upload.storage_path);
  ELSIF v_upload.status = 'cancelled' THEN
    RETURN jsonb_build_object('outcome', 'cancelled', 'already', true, 'storage_path', v_upload.storage_path);
  ELSIF v_upload.status = 'completed' THEN
    RETURN jsonb_build_object('outcome', 'already_completed');
  ELSE
    RETURN jsonb_build_object('outcome', 'already_failed');
  END IF;
END;
$$;


-- ── 6. fail_property_video_upload ────────────────────────────────────────────
-- reserved → failed(reason), con razones de un conjunto cerrado. Idempotente:
-- un failed conserva su primera razón.

CREATE OR REPLACE FUNCTION public.fail_property_video_upload(
  p_tenant_id uuid,
  p_upload_id uuid,
  p_reason    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_property_id uuid;
  v_upload      public.property_video_uploads%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN (
    'invalid_size', 'empty_file', 'file_too_large', 'mime_not_allowed',
    'content_mismatch', 'unrecognized_container', 'truncated_container',
    'malformed_container', 'invalid_timescale', 'duration_unavailable',
    'duration_invalid', 'duration_too_long', 'inspection_budget_exceeded',
    'object_mismatch', 'property_unavailable', 'tenant_unavailable', 'limit_reached'
  ) THEN
    RETURN jsonb_build_object('outcome', 'invalid_reason');
  END IF;

  SELECT u.property_id INTO v_property_id
  FROM public.property_video_uploads u
  WHERE u.id = p_upload_id AND u.tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  PERFORM 1 FROM public.properties p WHERE p.id = v_property_id FOR UPDATE;
  SELECT * INTO v_upload FROM public.property_video_uploads u WHERE u.id = p_upload_id FOR UPDATE;
  -- Pudo desaparecer mientras se esperaba el lock (purge del tenant, borrado
  -- de la propiedad en cascada).
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_upload.status = 'reserved' THEN
    UPDATE public.property_video_uploads
    SET status = 'failed', failure_reason = p_reason, resolved_at = now()
    WHERE id = p_upload_id;
    RETURN jsonb_build_object('outcome', 'failed', 'already', false, 'reason', p_reason, 'storage_path', v_upload.storage_path);
  ELSIF v_upload.status = 'failed' THEN
    RETURN jsonb_build_object('outcome', 'failed', 'already', true, 'reason', v_upload.failure_reason, 'storage_path', v_upload.storage_path);
  ELSIF v_upload.status = 'completed' THEN
    RETURN jsonb_build_object('outcome', 'already_completed');
  ELSE
    RETURN jsonb_build_object('outcome', 'already_cancelled');
  END IF;
END;
$$;


-- ── 7. get_property_video_upload_object ──────────────────────────────────────
-- Lectura previa a la inspección: estado de la reserva e IDENTIDAD del objeto
-- vigente en storage.objects (id + version + tamaño + MIME). finalize vuelve a
-- leer la misma identidad dentro de su transacción (ver TOCTOU arriba).

CREATE OR REPLACE FUNCTION public.get_property_video_upload_object(
  p_tenant_id uuid,
  p_upload_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_upload public.property_video_uploads%ROWTYPE;
  v_object jsonb;
BEGIN
  SELECT * INTO v_upload
  FROM public.property_video_uploads u
  WHERE u.id = p_upload_id AND u.tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  SELECT jsonb_build_object(
           'id', o.id,
           'version', o.version,
           'size', (o.metadata ->> 'size')::bigint,
           'mimetype', o.metadata ->> 'mimetype')
  INTO v_object
  FROM storage.objects o
  WHERE o.bucket_id = 'property-videos'
    AND o.name = v_upload.storage_path
    AND o.archived_at IS NULL
    AND NOT o.is_delete_marker;

  RETURN jsonb_build_object(
    'outcome', 'found',
    'status', v_upload.status,
    'expired', v_upload.status = 'reserved' AND v_upload.expires_at <= now(),
    'storage_path', v_upload.storage_path,
    'mime_type', v_upload.mime_type,
    'expires_at', v_upload.expires_at,
    'object', v_object);
END;
$$;


-- ── 8. finalize_property_video_upload ────────────────────────────────────────
-- Registra el video. p_object_id / p_object_version son la identidad que la
-- acción leyó ANTES de inspeccionar; p_size_bytes / p_duration_seconds son
-- resultados de la inspección server-side, nunca declaraciones del browser.
-- Idempotente: un segundo llamado devuelve el mismo video con already = true.

CREATE OR REPLACE FUNCTION public.finalize_property_video_upload(
  p_tenant_id        uuid,
  p_upload_id        uuid,
  p_object_id        uuid,
  p_object_version   text,
  p_size_bytes       bigint,
  p_duration_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_property_id uuid;
  v_property    record;
  v_upload      public.property_video_uploads%ROWTYPE;
  v_object      record;
  v_videos      integer;
  v_others      integer;
  v_video_id    uuid;
  v_reason      text;
BEGIN
  SELECT u.property_id INTO v_property_id
  FROM public.property_video_uploads u
  WHERE u.id = p_upload_id AND u.tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Locks en el orden global: propiedad → reserva.
  SELECT p.tenant_id, p.deleted_at INTO v_property
  FROM public.properties p WHERE p.id = v_property_id FOR UPDATE;
  SELECT * INTO v_upload FROM public.property_video_uploads u WHERE u.id = p_upload_id FOR UPDATE;
  -- Pudo desaparecer mientras se esperaba el lock (purge del tenant, borrado
  -- de la propiedad en cascada).
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_upload.status = 'completed' THEN
    SELECT v.id INTO v_video_id FROM public.property_videos v WHERE v.storage_path = v_upload.storage_path;
    RETURN jsonb_build_object('outcome', 'completed', 'already', true, 'video_id', v_video_id);
  ELSIF v_upload.status = 'cancelled' THEN
    RETURN jsonb_build_object('outcome', 'cancelled');
  ELSIF v_upload.status = 'failed' THEN
    RETURN jsonb_build_object('outcome', 'failed', 'already', true, 'reason', v_upload.failure_reason);
  END IF;

  -- reserved
  IF v_upload.expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'expired');
  END IF;

  IF p_object_id IS NULL
     OR p_size_bytes IS NULL OR p_size_bytes < 1 OR p_size_bytes > 52428800
     OR p_duration_seconds IS NULL OR p_duration_seconds < 1 OR p_duration_seconds > 60 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  -- Propiedad y tenant todavía vigentes.
  IF v_property.deleted_at IS NOT NULL THEN
    v_reason := 'property_unavailable';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.id = p_tenant_id AND t.deleted_at IS NULL AND t.status IN ('trial', 'active')
  ) THEN
    v_reason := 'tenant_unavailable';
  END IF;

  IF v_reason IS NULL THEN
    -- Identidad del objeto: tiene que ser EXACTAMENTE el que se inspeccionó.
    SELECT o.id, o.version, (o.metadata ->> 'size')::bigint AS size, o.metadata ->> 'mimetype' AS mimetype
    INTO v_object
    FROM storage.objects o
    WHERE o.bucket_id = 'property-videos'
      AND o.name = v_upload.storage_path
      AND o.archived_at IS NULL
      AND NOT o.is_delete_marker;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'object_missing');
    END IF;
    IF v_object.id <> p_object_id OR v_object.version IS DISTINCT FROM p_object_version THEN
      -- Cambió entre la inspección y ahora: no se registra; la acción re-inspecciona.
      RETURN jsonb_build_object('outcome', 'object_changed');
    END IF;
    IF v_object.size IS DISTINCT FROM p_size_bytes OR v_object.mimetype IS DISTINCT FROM v_upload.mime_type THEN
      v_reason := 'object_mismatch';
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    SELECT count(*) INTO v_videos FROM public.property_videos v WHERE v.property_id = v_property_id;
    SELECT count(*) INTO v_others
    FROM public.property_video_uploads u
    WHERE u.property_id = v_property_id AND u.status = 'reserved' AND u.expires_at > now() AND u.id <> p_upload_id;
    IF v_videos + v_others >= 2 THEN
      v_reason := 'limit_reached';
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    UPDATE public.property_video_uploads
    SET status = 'failed', failure_reason = v_reason, resolved_at = now()
    WHERE id = p_upload_id;
    RETURN jsonb_build_object('outcome', 'failed', 'already', false, 'reason', v_reason);
  END IF;

  -- La reserva deja de contar ANTES del INSERT (el trigger de cupo cuenta
  -- videos + reservas vivas). Si el INSERT falla, se revierte todo.
  UPDATE public.property_video_uploads
  SET status = 'completed', resolved_at = now()
  WHERE id = p_upload_id;

  INSERT INTO public.property_videos
    (tenant_id, property_id, storage_path, mime_type, file_size_bytes, duration_seconds, sort_order, created_by)
  VALUES
    (p_tenant_id, v_property_id, v_upload.storage_path, v_upload.mime_type, p_size_bytes, p_duration_seconds,
     v_videos, v_upload.created_by)
  RETURNING id INTO v_video_id;

  RETURN jsonb_build_object('outcome', 'completed', 'already', false, 'video_id', v_video_id);
END;
$$;


-- ── 9. Grants ────────────────────────────────────────────────────────────────
-- Los default privileges de Supabase dan EXECUTE directo a anon y
-- authenticated sobre toda función nueva de public: REVOKE FROM PUBLIC no
-- alcanza (precedente: 20260908000004). Revocar explícito y dar sólo a
-- service_role. Las funciones de trigger no las ejecuta nadie directamente.

REVOKE ALL ON FUNCTION public.reserve_property_video_upload(uuid, uuid, uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_property_video_upload(uuid, uuid)                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_property_video_upload(uuid, uuid, text)                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_property_video_upload_object(uuid, uuid)                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_property_video_upload(uuid, uuid, uuid, text, bigint, integer)  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_property_video_upload(uuid, uuid, uuid, uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_property_video_upload(uuid, uuid)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_property_video_upload(uuid, uuid, text)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.get_property_video_upload_object(uuid, uuid)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_property_video_upload(uuid, uuid, uuid, text, bigint, integer)  TO service_role;

REVOKE ALL ON FUNCTION public.property_videos_enforce_capacity() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.property_videos_guard_identity()   FROM PUBLIC, anon, authenticated, service_role;


-- ── 10. admin_purge_tenant: también las reservas ─────────────────────────────
-- Cuerpo idéntico a 20260920000006 + un bloque justo antes del DELETE de
-- properties: bloquear las propiedades del tenant y borrar property_video_uploads
-- (antes de properties, para que el reporte cuente filas: sus FKs a
-- properties/tenants son CASCADE). El lock va primero por el orden global
-- PROPIEDAD → RESERVA; ver el comentario en el cuerpo. CREATE OR REPLACE
-- conserva los privilegios ya endurecidos de la función.

CREATE OR REPLACE FUNCTION public.admin_purge_tenant(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb := '{}';
  v_n      int;
BEGIN
  PERFORM set_config('reservanex.skip_audit', 'true', true);

  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant % not found', p_tenant_id;
  END IF;

  -- ── Pedidos y catálogo gastronómico (Fase 3E-C3C) ───────────────────────
  --
  -- VAN PRIMERO, y el orden acá no es cosmético: son las dos FK RESTRICT que
  -- introdujo C3C, y una de ellas rompía el purge entero.
  --
  --   order_items.menu_item_id           → menu_items          RESTRICT
  --   orders.source_operation_request_id → operation_requests  RESTRICT
  --
  -- Medido contra la base antes de escribir esto: con un pedido aceptado, el
  -- DELETE de operation_requests —que era la PRIMERA sentencia de esta función—
  -- fallaba con 23503 y abortaba la transacción completa. Un tenant
  -- gastronómico con un solo pedido no se podía borrar de ninguna manera.
  --
  -- La corrección es el ORDEN, no aflojar las FK: RESTRICT está puesto a
  -- propósito para que un pedido no se pueda perder por un borrado accidental
  -- de catálogo o de solicitudes. Lo que tiene que saber el orden es este
  -- purge, que es la única eliminación deliberada y total de un tenant.
  --
  --   order_items → orders → menu_items → menu_categories → (sigue el resto)
  --
  -- menu_items y menu_categories además NUNCA se borraban acá: quedaban para el
  -- CASCADE de tenants del final. Funcionaba, pero dependía del orden en que
  -- Postgres resuelve dos cascadas hermanas, y RESTRICT se evalúa de inmediato
  -- (a diferencia de NO ACTION, que se difiere al final de la sentencia). Ahora
  -- es explícito, y de paso quedan contados en el resultado.
  DELETE FROM public.order_items
    WHERE order_id IN (SELECT id FROM public.orders WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('order_items', v_n);

  DELETE FROM public.orders WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('orders', v_n);

  -- menu_items antes que menu_categories: menu_items.category_id es RESTRICT.
  DELETE FROM public.menu_items WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('menu_items', v_n);

  DELETE FROM public.menu_categories WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('menu_categories', v_n);

  -- ── Entidades materializadas desde una solicitud (Fase 3E — cierre) ─────
  --
  -- VAN ANTES de operation_requests y de contacts, y por la misma razón por la
  -- que C3C tuvo que mover el catálogo gastronómico: son hijas que esta función
  -- NUNCA nombraba, y sus FK hacia lo que sí se borra son NO ACTION y NOT
  -- DEFERRABLE, o sea que se verifican al cerrar la sentencia.
  --
  --   table_reservations.source_operation_request_id → operation_requests
  --   table_reservations.contact_id                  → contacts
  --   property_visits.source_operation_request_id    → operation_requests
  --   property_visits.contact_id                     → contacts
  --   property_visits.property_id                    → properties
  --
  -- Las dos tienen tenant_id → tenants ON DELETE CASCADE, y esa cascada es
  -- justamente la que hacía parecer que estaban cubiertas: como tenants se
  -- borra en la ÚLTIMA sentencia de esta función, para cuando llegaba el
  -- CASCADE la transacción ya había abortado mucho antes.
  --
  -- Medido sobre la definición desplegada: un tenant gastronómico con UNA
  -- reserva de mesa aceptada fallaba con 23503 en el DELETE de
  -- operation_requests de acá abajo, y no se borraba nada. Lo mismo para un
  -- tenant inmobiliario con una visita agendada. Ambos caminos son los
  -- normales: decide_operation_request escribe siempre
  -- source_operation_request_id = p_operation_id, que nunca es NULL.
  --
  -- La corrección es el ORDEN, no aflojar las FK: NO ACTION está puesto para
  -- que una reserva de mesa o una visita no queden colgando de una solicitud
  -- borrada por accidente. Quien tiene que conocer el orden es este purge, que
  -- es la única eliminación deliberada y total de un tenant.
  --
  -- Ninguna otra tabla las referencia a ellas (verificado contra pg_constraint
  -- antes de escribir esto), así que son hojas y se borran directo.
  DELETE FROM public.table_reservations WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('table_reservations', v_n);

  DELETE FROM public.property_visits WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_visits', v_n);

  -- operation_requests se borra MÁS ABAJO, después de reservations. La nota
  -- está acá porque este era su lugar histórico y el orden de arriba se lee
  -- como si siguiera estándolo.

  DELETE FROM public.reservation_events WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('reservation_events', v_n);

  DELETE FROM public.conversation_reservation_drafts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('conversation_reservation_drafts', v_n);

  DELETE FROM public.property_availability_blocks WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_availability_blocks', v_n);

  DELETE FROM public.availability_blocks WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('availability_blocks', v_n);

  DELETE FROM public.unit_images
    WHERE unit_id IN (SELECT id FROM public.units WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('unit_images', v_n);

  DELETE FROM public.property_images
    WHERE property_id IN (SELECT id FROM public.properties WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_images', v_n);

  -- Moved here (was after `properties`) — property_videos.property_id →
  -- properties is ON DELETE CASCADE, so it must be counted before properties
  -- is deleted or the subquery below finds nothing left to match.
  DELETE FROM public.property_videos
    WHERE property_id IN (SELECT id FROM public.properties WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_videos', v_n);

  DELETE FROM public.documents WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('documents', v_n);

  DELETE FROM public.notifications WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('notifications', v_n);

  DELETE FROM public.notes WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('notes', v_n);

  DELETE FROM public.tasks WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tasks', v_n);

  DELETE FROM public.message_queue WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('message_queue', v_n);

  DELETE FROM public.ai_usage_log WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('ai_usage_log', v_n);

  -- Must precede messages/conversations/whatsapp_accounts — all three
  -- reference them with ON DELETE NO ACTION (the bug this migration's
  -- predecessor, 20260831000001, fixed).
  DELETE FROM public.messaging_outbox WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('messaging_outbox', v_n);

  DELETE FROM public.media_events WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('media_events', v_n);

  DELETE FROM public.inbound_rejections WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('inbound_rejections', v_n);

  DELETE FROM public.messages WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('messages', v_n);

  -- audit_logs se borra al FINAL, no aquí.

  DELETE FROM public.impersonation_sessions WHERE target_tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('impersonation_sessions', v_n);

  DELETE FROM public.reservations WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('reservations', v_n);

  -- ── Las solicitudes, DESPUÉS de todo lo que se materializó desde ellas ───
  --
  -- Cuatro tablas nacen de una operation_request aceptada, y las cuatro la
  -- referencian:
  --
  --   orders.source_operation_request_id              RESTRICT
  --   reservations.source_operation_request_id        RESTRICT
  --   table_reservations.source_operation_request_id  NO ACTION
  --   property_visits.source_operation_request_id     NO ACTION
  --
  -- Las tres primeras ya estaban resueltas —orders por 20260920000003, las dos
  -- de NO ACTION por 20260920000005— pero reservations no: se borraba mucho
  -- después, y con RESTRICT eso es un 23503 garantizado.
  --
  -- Medido sobre datos reales: el tenant demo tenía UNA reserva materializada
  -- desde un formulario, y el purge productivo falló con
  -- "violates foreign key constraint reservations_source_operation_request_id_fkey".
  -- No se pudo borrar hasta este cambio.
  --
  -- ¿Por qué mover operation_requests hacia abajo y no reservations hacia
  -- arriba? Porque reservations tiene hijas propias —availability_blocks,
  -- documents, notes, tasks, todas NO ACTION— que se borran antes que ella.
  -- Subirla crearía cuatro violaciones nuevas para arreglar una. Bajar
  -- operation_requests no rompe nada: sus propias FK apuntan a contacts,
  -- conversations, tenant_users y form_submissions, y las cuatro se borran
  -- después de este punto.
  --
  -- Verificado con una consulta sobre pg_constraint que compara la posición de
  -- cada DELETE dentro de este cuerpo: después de este cambio no queda NINGUNA
  -- FK restrictiva cuya hija se borre después de su padre.
  DELETE FROM public.operation_requests WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('operation_requests', v_n);

  DELETE FROM public.conversations WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('conversations', v_n);

  DELETE FROM public.monthly_rental_payments WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_payments', v_n);

  DELETE FROM public.monthly_rental_charges WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_charges', v_n);

  DELETE FROM public.monthly_rental_contracts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_contracts', v_n);

  -- Fase 3A. Antes que contacts: form_submissions.contact_id apunta ahí.
  -- (El FK tenant_id es ON DELETE CASCADE, así que sin este DELETE las filas
  -- igual desaparecerían — pero no saldrían en el reporte, que es justamente
  -- lo que arregló 20260831000002.)
  DELETE FROM public.form_submissions WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('form_submissions', v_n);

  DELETE FROM public.contacts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('contacts', v_n);

  DELETE FROM public.units WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('units', v_n);

  -- Property Videos 2B1 — orden de locks del dominio de videos: PROPIEDAD →
  -- RESERVA. reserve/cancel/fail/finalize bloquean la propiedad y después la
  -- reserva; borrar las reservas antes de tomar las propiedades invertía ese
  -- orden (deadlock reproducido en el lab: purge ‖ finalize). Las propiedades
  -- se toman en el mismo punto en que ya las tomaba el DELETE de abajo —sin
  -- adelantarlas respecto del resto de los dominios— y recién entonces se
  -- borran las reservas.
  PERFORM 1 FROM public.properties WHERE tenant_id = p_tenant_id ORDER BY id FOR UPDATE;

  DELETE FROM public.property_video_uploads WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_video_uploads', v_n);

  DELETE FROM public.properties WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('properties', v_n);

  DELETE FROM public.whatsapp_accounts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('whatsapp_accounts', v_n);

  DELETE FROM public.ai_settings WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('ai_settings', v_n);

  DELETE FROM public.workspaces WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('workspaces', v_n);

  DELETE FROM public.seller_clients WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('seller_clients', v_n);

  -- Moved here (was after `tenant_users`) — user_section_seen.user_id →
  -- tenant_users is ON DELETE CASCADE, so it must be counted before
  -- tenant_users is deleted or the row is already gone by the time we get here.
  DELETE FROM public.user_section_seen WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('user_section_seen', v_n);

  DELETE FROM public.tenant_users WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_users', v_n);

  -- These two only cascade from tenants directly (deleted at the very end of
  -- this function), so their position here was already correct.
  DELETE FROM public.tenant_setup_assignments WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_setup_assignments', v_n);

  DELETE FROM public.tenant_receipt_counters WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_receipt_counters', v_n);

  DELETE FROM public.audit_logs WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('audit_logs', v_n);

  DELETE FROM public.tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenants', v_n);

  RETURN v_result;
END;
$function$
;

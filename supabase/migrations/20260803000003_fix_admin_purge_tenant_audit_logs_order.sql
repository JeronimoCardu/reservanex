-- =============================================================================
-- 20260803000003_fix_admin_purge_tenant_audit_logs_order.sql
-- Corrección: audit triggers re-insertaban en audit_logs después de borrarlos,
-- causando FK violation al intentar DELETE FROM tenants.
-- =============================================================================
-- Problema raíz:
--   1. admin_purge_tenant borraba audit_logs en el medio de la función (pos. 14).
--   2. Los triggers trg_audit_reservations, trg_audit_properties y
--      trg_audit_tenant_users (AFTER DELETE) re-insertaban en audit_logs
--      con tenant_id = p_tenant_id para los DELETEs posteriores.
--   3. Al llegar a DELETE FROM tenants, PostgreSQL detectaba audit_logs
--      apuntando al tenant y levantaba:
--        "FK constraint audit_logs_tenant_id_fkey on table audit_logs"
--   4. Incluso moviendo audit_logs justo antes de tenants, el trigger
--      trg_audit_tenants (AFTER DELETE) intentaría INSERT INTO audit_logs
--      con un tenant_id ya inexistente.
--
-- Solución:
--   A. audit_table_change() ahora lee el setting local 'reservanex.skip_audit'.
--      Si vale 'true', retorna inmediatamente sin insertar en audit_logs.
--      El setting es transaction-local: desaparece al hacer commit/rollback.
--   B. admin_purge_tenant activa el setting al inicio de la transacción.
--   C. DELETE FROM audit_logs se mueve al final, justo antes de DELETE FROM tenants,
--      para limpiar cualquier log previo que existiera antes del purge.
-- =============================================================================

-- ── A. audit_table_change: agregar guard de skip_audit ────────────────────────

CREATE OR REPLACE FUNCTION public.audit_table_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row_new      JSONB;
  v_row_old      JSONB;
  v_tenant_id    UUID;
  v_entity_id    UUID;
  v_actor_id     UUID;
  v_actor_type   audit_actor_type;
  v_impersonated UUID;
  v_action       TEXT;
BEGIN
  -- Guard: si estamos dentro de un purge de admin, no auditar.
  -- El setting es transaction-local (set_config(..., true)) y desaparece
  -- al terminar la transacción; nunca afecta otras sesiones o transacciones.
  IF current_setting('reservanex.skip_audit', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN v_row_new := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN v_row_old := to_jsonb(OLD); END IF;

  IF TG_TABLE_NAME = 'tenants' THEN
    v_tenant_id := COALESCE(
      (v_row_new ->> 'id')::UUID,
      (v_row_old ->> 'id')::UUID
    );
  ELSE
    v_tenant_id := COALESCE(
      (v_row_new ->> 'tenant_id')::UUID,
      (v_row_old ->> 'tenant_id')::UUID
    );
  END IF;

  v_entity_id := COALESCE(
    (v_row_new ->> 'id')::UUID,
    (v_row_old ->> 'id')::UUID
  );

  v_actor_id := auth.uid();

  IF v_actor_id IS NULL THEN
    v_actor_type   := 'system';
    v_impersonated := NULL;
    v_action       := 'system.' || TG_TABLE_NAME || '.' || LOWER(TG_OP);
  ELSE
    v_action := TG_TABLE_NAME || '.' || LOWER(TG_OP);

    IF public.auth_user_type() = 'platform_user' THEN
      v_actor_type := 'platform_user';
      -- D4: check if this SA has an active impersonation session (DB query, not JWT)
      PERFORM 1
      FROM public.impersonation_sessions
      WHERE platform_user_id = v_actor_id AND ended_at IS NULL;
      -- impersonated_by = actor_id: flags this row as "done during impersonation"
      v_impersonated := CASE WHEN FOUND THEN v_actor_id ELSE NULL END;
    ELSE
      v_actor_type   := 'tenant_user';
      v_impersonated := NULL;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_row_new = v_row_old THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (
      tenant_id, actor_id, actor_type, impersonated_by,
      action, entity_type, entity_id, old_value, new_value
    ) VALUES (
      v_tenant_id, v_actor_id, v_actor_type, v_impersonated,
      v_action, TG_TABLE_NAME, v_entity_id, v_row_old, v_row_new
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_table_change failed for % on table % (entity %): %',
      TG_OP, TG_TABLE_NAME, v_entity_id, SQLERRM;
  END;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


-- ── B. admin_purge_tenant: activar skip_audit + mover audit_logs al final ─────

CREATE OR REPLACE FUNCTION public.admin_purge_tenant(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb := '{}';
  v_n      int;
BEGIN
  -- Desactivar auditoría para toda esta transacción.
  -- is_local = true → el setting desaparece al hacer commit o rollback;
  -- nunca afecta otras transacciones ni sesiones concurrentes.
  PERFORM set_config('reservanex.skip_audit', 'true', true);

  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant % not found', p_tenant_id;
  END IF;

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

  DELETE FROM public.messages WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('messages', v_n);

  -- audit_logs se borra al FINAL (ver abajo), no aquí.

  DELETE FROM public.impersonation_sessions WHERE target_tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('impersonation_sessions', v_n);

  DELETE FROM public.reservations WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('reservations', v_n);

  DELETE FROM public.conversations WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('conversations', v_n);

  DELETE FROM public.contacts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('contacts', v_n);

  -- CASCADE borra unit_images si quedaron
  DELETE FROM public.units WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('units', v_n);

  -- CASCADE borra property_images si quedaron
  DELETE FROM public.properties WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('properties', v_n);

  DELETE FROM public.whatsapp_accounts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('whatsapp_accounts', v_n);

  DELETE FROM public.ai_settings WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('ai_settings', v_n);

  -- CASCADE borra user_workspace_assignments
  DELETE FROM public.workspaces WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('workspaces', v_n);

  DELETE FROM public.seller_clients WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('seller_clients', v_n);

  -- CASCADE borra user_workspace_assignments si quedaron
  DELETE FROM public.tenant_users WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_users', v_n);

  -- audit_logs va AQUÍ, al final de todo antes que tenants.
  -- Limpia tanto los logs pre-existentes como cualquier log residual.
  -- Con skip_audit activo, los triggers de las tablas anteriores no
  -- generaron nuevas filas, así que este DELETE es solo limpieza preventiva.
  DELETE FROM public.audit_logs WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('audit_logs', v_n);

  -- Último paso. FK check pasa porque audit_logs ya no referencia este tenant.
  -- El trigger trg_audit_tenants (AFTER DELETE) intenta insertar en audit_logs
  -- pero skip_audit lo suprime antes de ejecutar el INSERT.
  DELETE FROM public.tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenants', v_n);

  RETURN v_result;
END;
$$;


-- ── C. Permisos: mantener REVOKE total + GRANT solo a service_role ─────────────

REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_purge_tenant(uuid) TO service_role;

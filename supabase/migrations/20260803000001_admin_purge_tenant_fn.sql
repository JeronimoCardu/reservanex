-- =============================================================================
-- 20260803000001_admin_purge_tenant_fn.sql
-- Función transaccional para borrar un tenant completo y todos sus datos
-- =============================================================================
-- Solo puede ser ejecutada por service_role (admin client de las Server Actions).
-- El borrado es atómico: si cualquier step falla, se hace rollback completo.
-- Devuelve jsonb con el conteo de filas eliminadas por tabla.
--
-- Orden de borrado respeta todas las FK constraints:
--   1.  reservation_events        (tenant_id directo)
--   2.  conversation_reservation_drafts (tenant_id directo)
--   3.  property_availability_blocks    (tenant_id directo)
--   4.  availability_blocks        (tenant_id directo)
--   5.  unit_images               (vía units → tenant)
--   6.  property_images           (vía properties → tenant)
--   7.  documents                 (tenant_id directo)
--   8.  notifications             (tenant_id directo)
--   9.  notes                     (tenant_id directo)
--  10.  tasks                     (tenant_id directo)
--  11.  message_queue             (tenant_id directo)
--  12.  ai_usage_log              (tenant_id directo)
--  13.  messages                  (tenant_id directo)
--  14.  audit_logs                (tenant_id nullable)
--  15.  impersonation_sessions    (target_tenant_id)
--  16.  reservations              (tenant_id directo)
--  17.  conversations             (tenant_id directo)
--  18.  contacts                  (tenant_id directo)
--  19.  units                     (tenant_id, cascade → unit_images)
--  20.  properties                (tenant_id, cascade → property_images)
--  21.  whatsapp_accounts         (tenant_id directo)
--  22.  ai_settings               (tenant_id directo)
--  23.  workspaces                (tenant_id, cascade → user_workspace_assignments)
--  24.  seller_clients            (tenant_id directo)
--  25.  tenant_users              (tenant_id, cascade → user_workspace_assignments)
--  26.  tenants                   (root)
-- =============================================================================

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

  DELETE FROM public.audit_logs WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('audit_logs', v_n);

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

  DELETE FROM public.tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenants', v_n);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_purge_tenant(uuid) TO service_role;

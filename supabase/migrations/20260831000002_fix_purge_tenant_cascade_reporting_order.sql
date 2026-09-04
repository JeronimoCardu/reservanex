-- =============================================================================
-- 20260831000002_fix_purge_tenant_cascade_reporting_order.sql
-- Corrección de la migración anterior (20260831000001): dos de las 4 tablas
-- agregadas "solo para reporting" estaban posicionadas DESPUÉS de la tabla
-- de la que dependen vía ON DELETE CASCADE, así que para cuando llegaban a
-- ejecutarse ya no quedaban filas que borrar (el CASCADE ya las había
-- eliminado) — el DELETE explícito siempre reportaba 0, aunque los datos sí
-- se borraban correctamente. Detectado por validate:purge-tenant (test 3:
-- "Result completeness"), no un problema de integridad de datos.
--
--   property_videos    → cascadea desde properties (property_id) — estaba
--                         DESPUÉS de "DELETE FROM properties". Se mueve junto
--                         a property_images (también vía subquery), ANTES.
--   user_section_seen  → cascadea desde tenant_users (user_id) — estaba
--                         DESPUÉS de "DELETE FROM tenant_users". Se mueve a
--                         justo ANTES.
--
-- tenant_setup_assignments y tenant_receipt_counters solo cascadean desde
-- tenants directamente (que se borra al final de toda la función), así que
-- su posición ya era correcta — no se tocan.
--
-- Ninguna FK cambia. Solo se reordenan 2 DELETE dentro de la misma función.
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

  DELETE FROM public.contacts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('contacts', v_n);

  DELETE FROM public.units WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('units', v_n);

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
$$;

REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_purge_tenant(uuid) TO service_role;

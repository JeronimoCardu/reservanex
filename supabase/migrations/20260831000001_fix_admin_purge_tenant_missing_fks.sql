-- =============================================================================
-- 20260831000001_fix_admin_purge_tenant_missing_fks.sql
-- Corrección: admin_purge_tenant no borraba 3 tablas agregadas por las Fases
-- de AutoResponder (messaging_outbox, media_events, inbound_rejections),
-- causando FK violation al intentar DELETE FROM messages:
--
--   update or delete on table "messages" violates foreign key constraint
--   "messaging_outbox_message_id_fkey" on table "messaging_outbox"
--
-- =============================================================================
-- AUDITORÍA COMPLETA (pg_constraint / information_schema contra el proyecto
-- akvaswvkdqfguksinrwa, no asumida desde migraciones históricas — ver Fase 8
-- "purge fix" report para el detalle):
--
-- Tablas con tenant_id: 32 en total. Comparadas contra las 26 que la versión
-- anterior (20260817000007) borraba explícitamente, faltaban 7:
--
--   BLOQUEANTES (FK "NO ACTION" hacia messages/conversations/whatsapp_accounts
--   — deben borrarse ANTES de esas tres, o el DELETE falla):
--     - messaging_outbox   (message_id→messages, conversation_id→conversations,
--                            account_id→whatsapp_accounts, tenant_id→tenants)
--     - media_events       (mismas 4 referencias que messaging_outbox)
--     - inbound_rejections (account_id→whatsapp_accounts, tenant_id→tenants)
--
--   YA SEGURAS vía ON DELETE CASCADE (no bloqueaban nada, pero no se
--   reportaban en el jsonb de resultado — se agregan explícitamente para
--   reporting/defensividad, mismo criterio ya usado en este función para
--   property_images/unit_images/reservation_events, que también son CASCADE
--   y sin embargo se borran explícitamente):
--     - property_videos          (property_id→properties, tenant_id→tenants)
--     - user_section_seen        (tenant_id→tenants, user_id→tenant_users)
--     - tenant_setup_assignments (tenant_id→tenants)
--     - tenant_receipt_counters  (tenant_id→tenants)
--
-- No se modifica NINGUNA foreign key existente — todas las relaciones NO
-- ACTION/RESTRICT/CASCADE se respetan tal como están. Este fix es puramente
-- de ORDEN de borrado dentro de la función, más las 3 tablas bloqueantes que
-- faltaban.
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
  -- Desactivar auditoría para toda esta transacción.
  -- is_local = true → el setting desaparece al hacer commit o rollback.
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

  -- documents antes que monthly_rental_payments: ON DELETE SET NULL limpia
  -- payments.receipt_document_id y payments.proof_document_id automáticamente.
  DELETE FROM public.documents WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('documents', v_n);

  DELETE FROM public.notifications WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('notifications', v_n);

  -- notes/tasks antes que monthly_rental_contracts: ON DELETE SET NULL limpia
  -- el campo monthly_rental_contract_id en las filas restantes.
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

  -- ── NUEVO: deben borrarse ANTES de messages/conversations/whatsapp_accounts,
  -- que referencian con ON DELETE NO ACTION (bloqueante). Ninguna otra tabla
  -- referencia a estas tres, así que pueden borrarse aquí sin más dependencias.
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

  -- ── Alquiler mensual ─────────────────────────────────────────────────────────
  -- Deben borrarse ANTES de contacts/properties porque monthly_rental_contracts
  -- las referencia con ON DELETE RESTRICT.

  DELETE FROM public.monthly_rental_payments WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_payments', v_n);

  DELETE FROM public.monthly_rental_charges WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_charges', v_n);

  DELETE FROM public.monthly_rental_contracts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_contracts', v_n);

  -- ── Entidades base ───────────────────────────────────────────────────────────

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

  DELETE FROM public.tenant_users WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_users', v_n);

  -- ── NUEVO: las 4 tablas siguientes ya estaban protegidas por ON DELETE
  -- CASCADE (no bloqueaban el purge) pero no se reportaban explícitamente.
  -- Se agregan aquí solo para visibilidad en el resultado — el mismo criterio
  -- que ya aplica esta función a property_images/unit_images/reservation_events.
  DELETE FROM public.property_videos
    WHERE property_id IN (SELECT id FROM public.properties WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_videos', v_n);

  DELETE FROM public.user_section_seen WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('user_section_seen', v_n);

  DELETE FROM public.tenant_setup_assignments WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_setup_assignments', v_n);

  DELETE FROM public.tenant_receipt_counters WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_receipt_counters', v_n);

  -- audit_logs al final: limpia logs pre-existentes. Con skip_audit activo,
  -- los triggers de las tablas anteriores no generaron nuevas filas.
  DELETE FROM public.audit_logs WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('audit_logs', v_n);

  DELETE FROM public.tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenants', v_n);

  RETURN v_result;
END;
$$;

-- Mantener permisos: solo service_role puede ejecutar esta función.
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_purge_tenant(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_purge_tenant(uuid) TO service_role;

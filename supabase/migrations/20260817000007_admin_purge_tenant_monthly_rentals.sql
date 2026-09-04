-- =============================================================================
-- 20260817000007_admin_purge_tenant_monthly_rentals.sql
--
-- Agrega el borrado explícito de las tablas de alquiler mensual dentro de
-- admin_purge_tenant, en el orden correcto de dependencias FK.
--
-- Problema:
--   monthly_rental_contracts.contact_id  → contacts.id  ON DELETE RESTRICT
--   monthly_rental_contracts.property_id → properties.id ON DELETE RESTRICT
--   La función anterior intentaba DELETE FROM contacts con monthly_rental_contracts
--   aún presentes → FK violation "monthly_rental_contracts_contact_id_fkey".
--
-- Orden de borrado de alquiler mensual insertado ANTES de contacts/properties:
--   1. monthly_rental_payments  (referencia charges + contracts vía ON DELETE CASCADE)
--   2. monthly_rental_charges   (referencia contracts vía ON DELETE CASCADE)
--   3. monthly_rental_contracts (referencia contacts/properties vía ON DELETE RESTRICT)
--
-- Notas de FK ya resueltas antes de llegar a este bloque:
--   - documents.monthly_rental_contract_id  → ON DELETE SET NULL  (documents ya borrados)
--   - notes.monthly_rental_contract_id      → ON DELETE SET NULL  (notes ya borradas)
--   - tasks.monthly_rental_contract_id      → ON DELETE SET NULL  (tasks ya borradas)
--   - payments.receipt_document_id          → ON DELETE SET NULL  (documents ya borrados)
--   - tenant_receipt_counters.tenant_id     → ON DELETE CASCADE   (se limpia con tenants)
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
  -- el campo monthly_rental_contract_id en las filas restantes (no las del tenant,
  -- que ya fueron borradas aquí).
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

  -- ── Alquiler mensual ─────────────────────────────────────────────────────────
  -- Deben borrarse ANTES de contacts/properties porque monthly_rental_contracts
  -- las referencia con ON DELETE RESTRICT.

  -- 1. Pagos primero: dependen de charges y contracts.
  DELETE FROM public.monthly_rental_payments WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_payments', v_n);

  -- 2. Cuotas: dependen de contracts.
  DELETE FROM public.monthly_rental_charges WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_charges', v_n);

  -- 3. Contratos: referencia contacts + properties con RESTRICT → ahora seguros.
  DELETE FROM public.monthly_rental_contracts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_contracts', v_n);

  -- ── Entidades base ───────────────────────────────────────────────────────────

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

  -- audit_logs al final: limpia logs pre-existentes.
  -- Con skip_audit activo, los triggers no generaron nuevas filas.
  -- tenant_receipt_counters se limpia via ON DELETE CASCADE al borrar tenants.
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

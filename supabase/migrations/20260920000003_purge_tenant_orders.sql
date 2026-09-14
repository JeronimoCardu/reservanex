-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3C — admin_purge_tenant aprende a borrar pedidos
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL BUG, MEDIDO ──────────────────────────────────────────────────────────
--
-- Se creó un tenant temporal por el flujo real (submission → operation_request
-- → aceptar → order + order_items) y se lo purgó con el mecanismo PRODUCTIVO,
-- purgeTenantWithStorage(), que es lo que llama platform-danger.ts:
--
--   dbError: update or delete on table "operation_requests" violates foreign
--            key constraint "orders_source_operation_request_id_fkey"
--            on table "orders"
--
-- Resultado: 0 filas borradas, tenant intacto, Storage correctamente NO tocado.
-- O sea: desde C3C, un tenant gastronómico con UN pedido aceptado no se podía
-- eliminar de la plataforma. No era un riesgo teórico.
--
-- ── POR QUÉ PASABA ──────────────────────────────────────────────────────────
--
-- admin_purge_tenant() empezaba borrando operation_requests, y no sabía que
-- existieran orders, order_items, menu_items ni menu_categories: la función es
-- anterior al catálogo (3E-C3A1) y a los pedidos (3E-C3C). El catálogo
-- sobrevivía porque tenants CASCADE lo arrastraba al final; los pedidos, no.
--
-- ── LA CORRECCIÓN ───────────────────────────────────────────────────────────
--
-- Se corrige el ORDEN de esta función, NO las FK. RESTRICT en
-- order_items.menu_item_id y en orders.source_operation_request_id es
-- deliberado: protege la evidencia de un pedido frente a un borrado accidental
-- de catálogo o de solicitudes. Cambiarlo a CASCADE para que pase el purge
-- sería quitar la protección justamente donde importa.
--
-- El purge es la ÚNICA eliminación deliberada y total de un tenant, así que es
-- el único lugar que tiene que conocer el orden.
--
-- ── MISMA FIRMA ─────────────────────────────────────────────────────────────
--
-- Auditado: existe UNA sola firma, admin_purge_tenant(uuid). Este archivo la
-- reproduce exacta a partir de la definición DESPLEGADA y solo inserta el
-- bloque nuevo — el resto queda byte a byte igual.
-- ════════════════════════════════════════════════════════════════════════════

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

  DELETE FROM public.operation_requests WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('operation_requests', v_n);

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

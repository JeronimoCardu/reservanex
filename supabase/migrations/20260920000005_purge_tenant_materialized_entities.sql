-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E — cierre food_service: el purge aprende a borrar lo materializado
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL HALLAZGO, MEDIDO EN LA AUDITORÍA TRANSVERSAL ─────────────────────────
--
-- admin_purge_tenant() borra 40 tablas por nombre. Dos faltaban:
--
--   table_reservations   (food_service, materializada por C3A)
--   property_visits      (real_estate,  materializada por 3D)
--
-- Las dos apuntan con NO ACTION —y NOT DEFERRABLE— a operation_requests y a
-- contacts, que esta función sí borra. Como NO ACTION se verifica al cerrar la
-- sentencia, el DELETE de operation_requests levantaba 23503 y abortaba el
-- purge entero.
--
-- Efecto real: un tenant gastronómico que hubiera confirmado UNA reserva de
-- mesa no se podía eliminar de ninguna manera. Idem un tenant inmobiliario con
-- una visita agendada. Falla seguro —la transacción revierte y el tenant queda
-- intacto, no hay pérdida de datos— pero la eliminación era imposible.
--
-- ── POR QUÉ NO SE VIO ANTES ─────────────────────────────────────────────────
--
-- 20260920000003 arregló exactamente este bug para orders, pero sólo auditó las
-- dos FK que C3C acababa de introducir. Las de C3A y 3D ya estaban ahí desde
-- antes y nadie las había mirado: validate-purge-tenant.ts tenía cero
-- referencias a table_reservations y a property_visits.
--
-- Esta migración viene con esa cobertura: dos escenarios nuevos que construyen
-- una reserva de mesa y una visita por el flujo productivo completo y purgan
-- con purgeTenantWithStorage(), no con un DELETE directo.
--
-- ── LA CORRECCIÓN ───────────────────────────────────────────────────────────
--
-- Dos DELETE más, ubicados antes de operation_requests. No se toca ninguna FK:
-- NO ACTION sigue protegiendo contra borrados accidentales, que es su trabajo.
-- El purge es la excepción deliberada y por eso es el que conoce el orden.
--
-- Misma firma exacta que la desplegada —admin_purge_tenant(p_tenant_id uuid)
-- RETURNS jsonb, SECURITY DEFINER, search_path=public,pg_temp— para que sea un
-- REPLACE y no un overload nuevo. El cuerpo de abajo es la definición que
-- devolvió pg_get_functiondef() sobre el proyecto, con el bloque insertado.
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

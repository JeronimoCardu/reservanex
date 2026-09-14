-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-C3C — la auditoría de order_items aprende su tenant
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL HALLAZGO, MEDIDO DURANTE LA EVIDENCIA DE CIERRE ──────────────────────
--
-- Al revisar los audit_logs de los pedidos reales apareció esto:
--
--   entity_type='order_items'  →  140 filas, las 140 con tenant_id NULL
--   y es la ÚNICA tabla del proyecto con filas de auditoría sin tenant
--
-- La causa es simple: audit_table_change() saca el tenant de NEW.tenant_id, y
-- order_items no tiene esa columna — se llega a su tenant por el pedido.
--
-- ── POR QUÉ IMPORTA ─────────────────────────────────────────────────────────
--
-- admin_purge_tenant() borra audit_logs WHERE tenant_id = p_tenant_id. Con
-- tenant_id NULL, esas filas NO se borran nunca: sobreviven al tenant y quedan
-- fuera del alcance de cualquier limpieza por tenant. Y no son filas vacías —
-- new_value lleva name_snapshot, unit_price_snapshot y las aclaraciones del
-- cliente ("sin cebolla"). Medido en este proyecto: 16 de esas filas contenían
-- notas de cliente.
--
-- ── LA CORRECCIÓN ───────────────────────────────────────────────────────────
--
-- Una rama más en audit_table_change(), con la misma forma que el caso especial
-- que ya existía para 'tenants'. No se toca ninguna otra tabla auditada: el
-- ELSE genérico sigue siendo el de siempre.
--
-- Más el saneamiento de lo ya escrito:
--   · las filas cuyo order_item TODAVÍA existe se reasignan a su tenant;
--   · las que apuntan a un order_item ya borrado se eliminan — son residuo de
--     corridas de validadores cuyos tenants ya se purgaron, no hay tenant al
--     que devolvérselas y ninguna limpieza futura podría alcanzarlas.
--
-- En una base limpia las dos sentencias no tocan nada.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.audit_table_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Fase 3E-C3C — order_items es la ÚNICA tabla auditada sin tenant_id propio:
  -- se llega a su tenant por el pedido. Sin esta rama, sus filas de auditoría
  -- nacían con tenant_id NULL, y eso tiene dos consecuencias reales:
  --
  --   1. admin_purge_tenant borra audit_logs WHERE tenant_id = p_tenant_id,
  --      así que esas filas SOBREVIVÍAN al borrado del tenant, para siempre y
  --      sin forma de alcanzarlas. Y llevan datos del cliente en new_value
  --      (name_snapshot, notes: "sin cebolla", precios).
  --   2. cualquier lectura de auditoría por tenant las dejaba afuera.
  --
  -- Se resuelve igual que el caso 'tenants' de arriba: un caso especial
  -- explícito, no una convención implícita.
  --
  -- En un DELETE por CASCADE desde orders el pedido ya puede no existir y esto
  -- queda NULL, igual que antes — pero ese camino solo ocurre borrando el
  -- pedido, y dentro de un purge el guard de skip_audit ya cortó antes. Lo que
  -- importa —el INSERT, que es donde viaja el dato del cliente— siempre
  -- resuelve, porque la FK garantiza que el pedido existe.
  ELSIF TG_TABLE_NAME = 'order_items' THEN
    SELECT o.tenant_id INTO v_tenant_id
    FROM public.orders o
    WHERE o.id = COALESCE(
      (v_row_new ->> 'order_id')::UUID,
      (v_row_old ->> 'order_id')::UUID
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
$function$
;


-- ── Saneamiento de lo ya auditado ───────────────────────────────────────────

-- 1. Lo que todavía se puede resolver, se resuelve.
UPDATE public.audit_logs a
SET tenant_id = o.tenant_id
FROM public.order_items oi
JOIN public.orders o ON o.id = oi.order_id
WHERE a.entity_type = 'order_items'
  AND a.tenant_id IS NULL
  AND a.entity_id = oi.id;

-- 2. Lo que quedó apuntando a un order_item inexistente se elimina: es residuo
--    de tenants ya purgados, sin dueño posible y fuera del alcance de cualquier
--    limpieza por tenant.
DELETE FROM public.audit_logs a
WHERE a.entity_type = 'order_items'
  AND a.tenant_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = a.entity_id);

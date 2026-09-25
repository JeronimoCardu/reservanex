-- ════════════════════════════════════════════════════════════════════════════
-- Permisos V2 — las RLS de receptionist dejan de ser FOR ALL sin permiso
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── EL PROBLEMA ──────────────────────────────────────────────────────────────
--
-- Cuatro policies de receptionist eran FOR ALL con la sola condición de ser
-- recepcionista del tenant:
--
--   receptionist_all_properties
--   receptionist_all_units
--   receptionist_all_contacts
--   receptionist_all_tasks
--
-- Las server actions SÍ chequeaban el permiso (can_create_properties), pero la
-- base no. Un receptionist con el switch APAGADO podía abrir el navegador,
-- tomar su propio access_token y el anon key —los dos están en el cliente— y
-- hacer POST/PATCH/DELETE directo a PostgREST: crear propiedades, cambiarles el
-- precio, publicarlas o borrarlas (soft delete). El permiso era una decisión de
-- UI, no una garantía.
--
-- Contactos y tareas ni siquiera tenían permiso: cualquier recepcionista podía
-- crear, editar y borrar, incluido el PII de los contactos.
--
-- El patrón correcto YA existía en el repo: property_images comprueba
-- can_create_properties dentro de la policy. Acá se aplica el mismo criterio a
-- la propiedad misma — hasta hoy las fotos estaban mejor protegidas que la
-- propiedad que ilustran.
--
-- ── LA FORMA ─────────────────────────────────────────────────────────────────
--
-- Cada tabla pasa de UNA policy FOR ALL a:
--
--   receptionist_select_<t>   SELECT  — el MISMO alcance de lectura de antes
--   receptionist_insert_<t>   INSERT  ─┐
--   receptionist_update_<t>   UPDATE   ├─ + el permiso correspondiente
--   receptionist_delete_<t>   DELETE  ─┘
--
-- La lectura no cambia en nada: una recepcionista necesita ver propiedades para
-- atender, contactos para operar un pedido y tareas para saber qué hacer. Lo
-- que pasa a requerir permiso es ESCRIBIR.
--
-- El soft delete queda cubierto porque es un UPDATE de deleted_at: cae bajo la
-- policy de UPDATE, que ahora exige permiso.
--
-- ── QUÉ NO CAMBIA ────────────────────────────────────────────────────────────
--
--   · owner_all_*            intactas — el owner ignora los flags, por diseño.
--   · sa_imp_*               intactas — impersonación de super admin.
--   · operator_setup_*       intactas — el operator de setup no es un tenant_user.
--   · service_role           no pasa por RLS: worker, inbound, IA y crons siguen
--                            exactamente igual. La IA nunca depende de los
--                            permisos de una recepcionista.
--   · tenant_users           intacta: el receptionist sigue viendo SOLO su fila
--                            y no puede modificarla. Sin escalada de privilegios.
--
-- ── EL MAPA DE PERMISOS ──────────────────────────────────────────────────────
--
--   properties, units   → can_create_properties        ("Gestionar propiedades")
--   contacts, tasks,    → can_assign_conversations     ("Atender clientes")
--   conversations
--
-- can_assign_conversations se REUTILIZA en vez de crear una columna nueva: es
-- el permiso que ya existía para el trabajo de atender, y que había quedado sin
-- efecto al retirarse la bandeja de conversaciones. Ahora gobierna lo que de
-- verdad hace una recepcionista atendiendo: cerrar una atención, anotar una
-- tarea y corregir los datos de un contacto. El label público cambia; la
-- columna no, porque renombrarla exigiría reescribir policies y código sin
-- ganar nada funcional.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Helpers ─────────────────────────────────────────────────────────────────
--
-- Mismo patrón que is_owner()/is_receptionist(): SQL, STABLE, SECURITY DEFINER
-- y search_path fijo. SECURITY DEFINER es necesario porque la consulta lee
-- tenant_users, que tiene RLS propia; sin él, evaluar el permiso dentro de una
-- policy dependería de otra policy.
--
-- Las dos devuelven TRUE sólo para un receptionist ACTIVO del tenant del JWT
-- con el flag encendido. El owner no pasa por acá: tiene su propia policy.

CREATE OR REPLACE FUNCTION public.receptionist_can_manage_properties()
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND tu.role      = 'receptionist'
      AND tu.can_create_properties = true
  );
$function$;

CREATE OR REPLACE FUNCTION public.receptionist_can_attend_customers()
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.id        = auth.uid()
      AND tu.tenant_id = public.auth_tenant_id()
      AND tu.active    = true
      AND tu.role      = 'receptionist'
      AND tu.can_assign_conversations = true
  );
$function$;

COMMENT ON FUNCTION public.receptionist_can_manage_properties() IS
  'Permisos V2: el receptionist activo del tenant tiene can_create_properties '
  '("Gestionar propiedades"). El owner NO pasa por acá — tiene su propia policy.';

COMMENT ON FUNCTION public.receptionist_can_attend_customers() IS
  'Permisos V2: el receptionist activo del tenant tiene can_assign_conversations '
  '("Atender clientes"): cerrar atenciones, tareas y datos de contacto.';

-- ── properties ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS receptionist_all_properties ON public.properties;

CREATE POLICY receptionist_select_properties
  ON public.properties FOR SELECT TO authenticated
  USING (
    public.is_receptionist()
    AND tenant_id = public.auth_tenant_id()
    AND deleted_at IS NULL
    AND (public.auth_workspace_ids() IS NULL
         OR workspace_id IS NULL
         OR workspace_id = ANY (public.auth_workspace_ids()))
  );

CREATE POLICY receptionist_insert_properties
  ON public.properties FOR INSERT TO authenticated
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_manage_properties()
    AND tenant_id = public.auth_tenant_id()
    AND (public.auth_workspace_ids() IS NULL
         OR workspace_id IS NULL
         OR workspace_id = ANY (public.auth_workspace_ids()))
  );

-- Cubre también el soft delete: archivar es UPDATE de deleted_at.
CREATE POLICY receptionist_update_properties
  ON public.properties FOR UPDATE TO authenticated
  USING (
    public.is_receptionist()
    AND public.receptionist_can_manage_properties()
    AND tenant_id = public.auth_tenant_id()
    AND deleted_at IS NULL
    AND (public.auth_workspace_ids() IS NULL
         OR workspace_id IS NULL
         OR workspace_id = ANY (public.auth_workspace_ids()))
  )
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_manage_properties()
    AND tenant_id = public.auth_tenant_id()
    AND (public.auth_workspace_ids() IS NULL
         OR workspace_id IS NULL
         OR workspace_id = ANY (public.auth_workspace_ids()))
  );

CREATE POLICY receptionist_delete_properties
  ON public.properties FOR DELETE TO authenticated
  USING (
    public.is_receptionist()
    AND public.receptionist_can_manage_properties()
    AND tenant_id = public.auth_tenant_id()
    AND (public.auth_workspace_ids() IS NULL
         OR workspace_id IS NULL
         OR workspace_id = ANY (public.auth_workspace_ids()))
  );

-- ── units ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS receptionist_all_units ON public.units;

CREATE POLICY receptionist_select_units
  ON public.units FOR SELECT TO authenticated
  USING (
    public.is_receptionist()
    AND tenant_id = public.auth_tenant_id()
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.properties p
      WHERE p.id = units.property_id
        AND p.deleted_at IS NULL
        AND (public.auth_workspace_ids() IS NULL
             OR p.workspace_id IS NULL
             OR p.workspace_id = ANY (public.auth_workspace_ids()))
    )
  );

CREATE POLICY receptionist_insert_units
  ON public.units FOR INSERT TO authenticated
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_manage_properties()
    AND tenant_id = public.auth_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.properties p
      WHERE p.id = units.property_id
        AND (public.auth_workspace_ids() IS NULL
             OR p.workspace_id IS NULL
             OR p.workspace_id = ANY (public.auth_workspace_ids()))
    )
  );

CREATE POLICY receptionist_update_units
  ON public.units FOR UPDATE TO authenticated
  USING (
    public.is_receptionist()
    AND public.receptionist_can_manage_properties()
    AND tenant_id = public.auth_tenant_id()
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.properties p
      WHERE p.id = units.property_id
        AND p.deleted_at IS NULL
        AND (public.auth_workspace_ids() IS NULL
             OR p.workspace_id IS NULL
             OR p.workspace_id = ANY (public.auth_workspace_ids()))
    )
  )
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_manage_properties()
    AND tenant_id = public.auth_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.properties p
      WHERE p.id = units.property_id
        AND (public.auth_workspace_ids() IS NULL
             OR p.workspace_id IS NULL
             OR p.workspace_id = ANY (public.auth_workspace_ids()))
    )
  );

CREATE POLICY receptionist_delete_units
  ON public.units FOR DELETE TO authenticated
  USING (
    public.is_receptionist()
    AND public.receptionist_can_manage_properties()
    AND tenant_id = public.auth_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.properties p
      WHERE p.id = units.property_id
        AND (public.auth_workspace_ids() IS NULL
             OR p.workspace_id IS NULL
             OR p.workspace_id = ANY (public.auth_workspace_ids()))
    )
  );

-- ── contacts ────────────────────────────────────────────────────────────────
--
-- Lectura para TODA recepcionista: sin el teléfono y el nombre no se puede
-- despachar un pedido ni confirmar una reserva. Escribir —que incluye corregir
-- PII— pasa a exigir "Atender clientes".
--
-- El borrado queda SIN policy de receptionist, igual que hoy en la práctica:
-- archiveContactAction ya era owner-only. Sólo el owner archiva.

DROP POLICY IF EXISTS receptionist_all_contacts ON public.contacts;

CREATE POLICY receptionist_select_contacts
  ON public.contacts FOR SELECT TO authenticated
  USING (
    public.is_receptionist()
    AND tenant_id = public.auth_tenant_id()
    AND deleted_at IS NULL
  );

CREATE POLICY receptionist_insert_contacts
  ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
  );

CREATE POLICY receptionist_update_contacts
  ON public.contacts FOR UPDATE TO authenticated
  USING (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
    AND deleted_at IS NULL
  )
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
  );

-- ── tasks ───────────────────────────────────────────────────────────────────
--
-- Se conserva EXACTAMENTE el alcance de antes (tareas sin conversación, o de
-- conversaciones que esa recepcionista puede ver) y se le suma el permiso para
-- escribir. Leer la agenda no requiere permiso; crearla, completarla o
-- borrarla, sí.

DROP POLICY IF EXISTS receptionist_all_tasks ON public.tasks;

CREATE POLICY receptionist_select_tasks
  ON public.tasks FOR SELECT TO authenticated
  USING (
    public.is_receptionist()
    AND tenant_id = public.auth_tenant_id()
    AND (
      conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.conversations c
        JOIN public.tenant_users tu
          ON tu.id = auth.uid() AND tu.tenant_id = c.tenant_id AND tu.active = true
        WHERE c.id = tasks.conversation_id
          AND c.tenant_id = tasks.tenant_id
          AND (c.assigned_user_id IS NULL OR c.assigned_user_id = tu.id)
      )
    )
  );

CREATE POLICY receptionist_insert_tasks
  ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
    AND (
      conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.conversations c
        JOIN public.tenant_users tu
          ON tu.id = auth.uid() AND tu.tenant_id = c.tenant_id AND tu.active = true
        WHERE c.id = tasks.conversation_id
          AND c.tenant_id = tasks.tenant_id
          AND (c.assigned_user_id IS NULL OR c.assigned_user_id = tu.id)
      )
    )
  );

CREATE POLICY receptionist_update_tasks
  ON public.tasks FOR UPDATE TO authenticated
  USING (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
    AND (
      conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.conversations c
        JOIN public.tenant_users tu
          ON tu.id = auth.uid() AND tu.tenant_id = c.tenant_id AND tu.active = true
        WHERE c.id = tasks.conversation_id
          AND c.tenant_id = tasks.tenant_id
          AND (c.assigned_user_id IS NULL OR c.assigned_user_id = tu.id)
      )
    )
  )
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
  );

CREATE POLICY receptionist_delete_tasks
  ON public.tasks FOR DELETE TO authenticated
  USING (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
    AND (
      conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.conversations c
        JOIN public.tenant_users tu
          ON tu.id = auth.uid() AND tu.tenant_id = c.tenant_id AND tu.active = true
        WHERE c.id = tasks.conversation_id
          AND c.tenant_id = tasks.tenant_id
          AND (c.assigned_user_id IS NULL OR c.assigned_user_id = tu.id)
      )
    )
  );

-- ── conversations ───────────────────────────────────────────────────────────
--
-- La LECTURA conserva su alcance exacto (sin asignar, o asignadas a quien
-- consulta): es lo que hace funcionar la bandeja de Atención humana, y verla no
-- requiere permiso — es el trabajo de la recepcionista.
--
-- Escribir sí: marcar una atención como atendida reactiva la IA, resetea el
-- contexto y cierra el ciclo. Eso ahora exige "Atender clientes".
--
-- El INSERT no se concede a ningún receptionist: las conversaciones las crea el
-- worker con service_role a partir de un inbound real. Nadie las fabrica a mano
-- desde el dashboard. El DELETE tampoco: el historial es evidencia.

DROP POLICY IF EXISTS receptionist_all_conversations ON public.conversations;

CREATE POLICY receptionist_select_conversations
  ON public.conversations FOR SELECT TO authenticated
  USING (
    public.is_receptionist()
    AND tenant_id = public.auth_tenant_id()
    AND (
      assigned_user_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.tenant_users tu
        WHERE tu.id = auth.uid()
          AND tu.tenant_id = conversations.tenant_id
          AND tu.active = true
          AND conversations.assigned_user_id = tu.id
      )
    )
  );

CREATE POLICY receptionist_update_conversations
  ON public.conversations FOR UPDATE TO authenticated
  USING (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
    AND (
      assigned_user_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.tenant_users tu
        WHERE tu.id = auth.uid()
          AND tu.tenant_id = conversations.tenant_id
          AND tu.active = true
          AND conversations.assigned_user_id = tu.id
      )
    )
  )
  WITH CHECK (
    public.is_receptionist()
    AND public.receptionist_can_attend_customers()
    AND tenant_id = public.auth_tenant_id()
    AND (
      assigned_user_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.tenant_users tu
        WHERE tu.id = auth.uid()
          AND tu.tenant_id = conversations.tenant_id
          AND tu.active = true
          AND conversations.assigned_user_id = tu.id
      )
    )
  );

COMMENT ON POLICY receptionist_select_conversations ON public.conversations IS
  'Permisos V2: leer la bandeja de Atención humana NO requiere permiso — es el '
  'trabajo de la recepcionista. El alcance (sin asignar o propias) no cambió.';

COMMENT ON POLICY receptionist_update_conversations ON public.conversations IS
  'Permisos V2: escribir sobre una conversación (marcar atendida, modo de IA) '
  'exige can_assign_conversations. Sin INSERT ni DELETE para receptionist: las '
  'conversaciones las crea el worker y el historial es evidencia.';

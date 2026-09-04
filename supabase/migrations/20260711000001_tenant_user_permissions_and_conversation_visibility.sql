-- =============================================================================
-- tenant_user_permissions_and_conversation_visibility
-- Fase 1 MVP: permisos simples en tenant_users + visibilidad de conversaciones
-- por asignación (reemplaza filtro por workspace para recepcionistas).
-- =============================================================================
-- CAMBIOS:
--   1. Agrega columnas de permiso a tenant_users.
--   2. Reemplaza "receptionist_all_conversations" — ahora ve solo
--      las conversaciones no asignadas o asignadas a sí mismo.
--   3. Reemplaza las policies de receptionist en messages, notes, tasks y
--      reservations para que sigan la misma lógica de visibilidad.
-- =============================================================================
-- IDEMPOTENCIA:
--   - ADD COLUMN IF NOT EXISTS
--   - DROP POLICY IF EXISTS antes de cada CREATE POLICY
-- =============================================================================

-- ── 1. Columnas de permisos en tenant_users ──────────────────────────────────

ALTER TABLE public.tenant_users
  ADD COLUMN IF NOT EXISTS can_create_properties    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_access_settings      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_confirm_reservations BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_assign_conversations BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Conversaciones: visibilidad por asignación ────────────────────────────
-- Owner: ya tenía "owner_all_conversations" (sin cambios).
-- Receptionist: ve sin asignar + asignadas a sí mismo.

DROP POLICY IF EXISTS "receptionist_all_conversations" ON public.conversations;
CREATE POLICY "receptionist_all_conversations"
ON public.conversations FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    assigned_user_id IS NULL
    OR assigned_user_id = auth.uid()
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    assigned_user_id IS NULL
    OR assigned_user_id = auth.uid()
  )
);

-- ── 3. Messages: siguen la visibilidad de su conversación ────────────────────

DROP POLICY IF EXISTS "receptionist_all_messages" ON public.messages;
CREATE POLICY "receptionist_all_messages"
ON public.messages FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND c.tenant_id = public.auth_tenant_id()
      AND (
        c.assigned_user_id IS NULL
        OR c.assigned_user_id = auth.uid()
      )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND c.tenant_id = public.auth_tenant_id()
      AND (
        c.assigned_user_id IS NULL
        OR c.assigned_user_id = auth.uid()
      )
  )
);

-- ── 4. Notes: siguen la visibilidad de su conversación ───────────────────────

DROP POLICY IF EXISTS "receptionist_all_notes" ON public.notes;
CREATE POLICY "receptionist_all_notes"
ON public.notes FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = notes.conversation_id
      AND c.tenant_id = public.auth_tenant_id()
      AND (
        c.assigned_user_id IS NULL
        OR c.assigned_user_id = auth.uid()
      )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = notes.conversation_id
      AND c.tenant_id = public.auth_tenant_id()
      AND (
        c.assigned_user_id IS NULL
        OR c.assigned_user_id = auth.uid()
      )
  )
);

-- ── 5. Tasks: siguen la visibilidad de su conversación (standalone = visibles) ─

DROP POLICY IF EXISTS "receptionist_all_tasks" ON public.tasks;
CREATE POLICY "receptionist_all_tasks"
ON public.tasks FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    conversation_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = tasks.conversation_id
        AND c.tenant_id = public.auth_tenant_id()
        AND (
          c.assigned_user_id IS NULL
          OR c.assigned_user_id = auth.uid()
        )
    )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    conversation_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = tasks.conversation_id
        AND c.tenant_id = public.auth_tenant_id()
        AND (
          c.assigned_user_id IS NULL
          OR c.assigned_user_id = auth.uid()
        )
    )
  )
);

-- ── 6. Reservations: siguen la visibilidad de su conversación ────────────────
-- Reservations sin conversation_id (standalone) siguen siendo visibles.

DROP POLICY IF EXISTS "receptionist_all_reservations" ON public.reservations;
CREATE POLICY "receptionist_all_reservations"
ON public.reservations FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
  AND (
    conversation_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = reservations.conversation_id
        AND c.tenant_id = public.auth_tenant_id()
        AND (
          c.assigned_user_id IS NULL
          OR c.assigned_user_id = auth.uid()
        )
    )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND deleted_at IS NULL
  AND (
    conversation_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = reservations.conversation_id
        AND c.tenant_id = public.auth_tenant_id()
        AND (
          c.assigned_user_id IS NULL
          OR c.assigned_user_id = auth.uid()
        )
    )
  )
);

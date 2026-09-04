-- =============================================================================
-- fix_assigned_user_id_tenant_user_rls
-- Corrige las policies de receptionist para que assigned_user_id se compare
-- explícitamente contra tenant_users.id via EXISTS, en lugar de auth.uid()
-- directo. Aunque en este schema tenant_users.id = auth.users.id (FK ON CASCADE),
-- el EXISTS hace explícito que estamos comparando contra el registro de
-- tenant_users del usuario autenticado, no contra auth.users directamente.
-- =============================================================================
-- TABLAS:  conversations, messages, notes, tasks, reservations
-- ALCANCE: solo policies de receptionist — owner policies sin cambios.
-- IDEMPOTENTE: DROP POLICY IF EXISTS + CREATE POLICY
-- =============================================================================

-- ── conversations ─────────────────────────────────────────────────────────────
-- Receptionist ve: sin asignar ó asignadas a su tenant_users.id
DROP POLICY IF EXISTS "receptionist_all_conversations" ON public.conversations;
CREATE POLICY "receptionist_all_conversations"
ON public.conversations FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    assigned_user_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.id        = auth.uid()           -- tenant_users.id = auth.users.id
        AND tu.tenant_id = conversations.tenant_id
        AND tu.active    = true
        AND conversations.assigned_user_id = tu.id
    )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    assigned_user_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.id        = auth.uid()
        AND tu.tenant_id = conversations.tenant_id
        AND tu.active    = true
        AND conversations.assigned_user_id = tu.id
    )
  )
);

-- ── messages ──────────────────────────────────────────────────────────────────
-- Siguen la visibilidad de su conversación via JOIN a tenant_users.
DROP POLICY IF EXISTS "receptionist_all_messages" ON public.messages;
CREATE POLICY "receptionist_all_messages"
ON public.messages FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.tenant_users tu
      ON tu.id        = auth.uid()
     AND tu.tenant_id = c.tenant_id
     AND tu.active    = true
    WHERE c.id        = messages.conversation_id
      AND c.tenant_id = messages.tenant_id
      AND (
        c.assigned_user_id IS NULL
        OR c.assigned_user_id = tu.id
      )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.tenant_users tu
      ON tu.id        = auth.uid()
     AND tu.tenant_id = c.tenant_id
     AND tu.active    = true
    WHERE c.id        = messages.conversation_id
      AND c.tenant_id = messages.tenant_id
      AND (
        c.assigned_user_id IS NULL
        OR c.assigned_user_id = tu.id
      )
  )
);

-- ── notes ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "receptionist_all_notes" ON public.notes;
CREATE POLICY "receptionist_all_notes"
ON public.notes FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.tenant_users tu
      ON tu.id        = auth.uid()
     AND tu.tenant_id = c.tenant_id
     AND tu.active    = true
    WHERE c.id        = notes.conversation_id
      AND c.tenant_id = notes.tenant_id
      AND (
        c.assigned_user_id IS NULL
        OR c.assigned_user_id = tu.id
      )
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.tenant_users tu
      ON tu.id        = auth.uid()
     AND tu.tenant_id = c.tenant_id
     AND tu.active    = true
    WHERE c.id        = notes.conversation_id
      AND c.tenant_id = notes.tenant_id
      AND (
        c.assigned_user_id IS NULL
        OR c.assigned_user_id = tu.id
      )
  )
);

-- ── tasks ─────────────────────────────────────────────────────────────────────
-- Tasks sin conversation_id (standalone) son visibles a todos los receptionists.
DROP POLICY IF EXISTS "receptionist_all_tasks" ON public.tasks;
CREATE POLICY "receptionist_all_tasks"
ON public.tasks FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    conversation_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.conversations c
      JOIN public.tenant_users tu
        ON tu.id        = auth.uid()
       AND tu.tenant_id = c.tenant_id
       AND tu.active    = true
      WHERE c.id        = tasks.conversation_id
        AND c.tenant_id = tasks.tenant_id
        AND (
          c.assigned_user_id IS NULL
          OR c.assigned_user_id = tu.id
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
      SELECT 1
      FROM public.conversations c
      JOIN public.tenant_users tu
        ON tu.id        = auth.uid()
       AND tu.tenant_id = c.tenant_id
       AND tu.active    = true
      WHERE c.id        = tasks.conversation_id
        AND c.tenant_id = tasks.tenant_id
        AND (
          c.assigned_user_id IS NULL
          OR c.assigned_user_id = tu.id
        )
    )
  )
);

-- ── reservations ──────────────────────────────────────────────────────────────
-- Reservations sin conversation_id (standalone) son visibles a todos los receptionists.
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
      SELECT 1
      FROM public.conversations c
      JOIN public.tenant_users tu
        ON tu.id        = auth.uid()
       AND tu.tenant_id = c.tenant_id
       AND tu.active    = true
      WHERE c.id        = reservations.conversation_id
        AND c.tenant_id = reservations.tenant_id
        AND (
          c.assigned_user_id IS NULL
          OR c.assigned_user_id = tu.id
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
      SELECT 1
      FROM public.conversations c
      JOIN public.tenant_users tu
        ON tu.id        = auth.uid()
       AND tu.tenant_id = c.tenant_id
       AND tu.active    = true
      WHERE c.id        = reservations.conversation_id
        AND c.tenant_id = reservations.tenant_id
        AND (
          c.assigned_user_id IS NULL
          OR c.assigned_user_id = tu.id
        )
    )
  )
);

-- =============================================================================
-- Fix receptionist notes visibility
-- Problema: "receptionist_all_notes" (FOR ALL) requería conversation_id accesible,
-- bloqueando notas de reserva (conversation_id = NULL, reservation_id IS NOT NULL).
-- Solución: reemplazar con 4 policies granulares (SELECT/INSERT/UPDATE/DELETE).
-- =============================================================================

DROP POLICY IF EXISTS "receptionist_all_notes"        ON public.notes;
DROP POLICY IF EXISTS "receptionist_select_notes"     ON public.notes;
DROP POLICY IF EXISTS "receptionist_insert_notes"     ON public.notes;
DROP POLICY IF EXISTS "receptionist_update_own_notes" ON public.notes;
DROP POLICY IF EXISTS "receptionist_delete_own_notes" ON public.notes;

-- ── SELECT: ve notas de conversaciones accesibles, reservas del tenant, contactos del tenant ─

CREATE POLICY "receptionist_select_notes"
ON public.notes
FOR SELECT
TO authenticated
USING (
  public.is_receptionist()
  AND notes.tenant_id = public.auth_tenant_id()
  AND notes.deleted_at IS NULL
  AND (
    (
      notes.conversation_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.conversations c
        JOIN public.tenant_users tu
          ON tu.id = auth.uid()
         AND tu.tenant_id = c.tenant_id
         AND tu.active = true
        WHERE c.id = notes.conversation_id
          AND c.tenant_id = notes.tenant_id
          AND (
            c.assigned_user_id IS NULL
            OR c.assigned_user_id = tu.id
          )
      )
    )
    OR (
      notes.reservation_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.reservations r
        WHERE r.id = notes.reservation_id
          AND r.tenant_id = notes.tenant_id
          AND r.tenant_id = public.auth_tenant_id()
      )
    )
    OR (
      notes.contact_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.contacts co
        WHERE co.id = notes.contact_id
          AND co.tenant_id = notes.tenant_id
          AND co.tenant_id = public.auth_tenant_id()
      )
    )
  )
);

-- ── INSERT: puede crear notas en recursos válidos del tenant; created_by debe ser el caller ─

CREATE POLICY "receptionist_insert_notes"
ON public.notes
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_receptionist()
  AND notes.tenant_id = public.auth_tenant_id()
  AND notes.created_by = auth.uid()
  AND (
    (
      notes.conversation_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.conversations c
        JOIN public.tenant_users tu
          ON tu.id = auth.uid()
         AND tu.tenant_id = c.tenant_id
         AND tu.active = true
        WHERE c.id = notes.conversation_id
          AND c.tenant_id = notes.tenant_id
          AND (
            c.assigned_user_id IS NULL
            OR c.assigned_user_id = tu.id
          )
      )
    )
    OR (
      notes.reservation_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.reservations r
        WHERE r.id = notes.reservation_id
          AND r.tenant_id = notes.tenant_id
          AND r.tenant_id = public.auth_tenant_id()
      )
    )
    OR (
      notes.contact_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.contacts co
        WHERE co.id = notes.contact_id
          AND co.tenant_id = notes.tenant_id
          AND co.tenant_id = public.auth_tenant_id()
      )
    )
  )
);

-- ── UPDATE: solo puede editar sus propias notas ──────────────────────────────

CREATE POLICY "receptionist_update_own_notes"
ON public.notes
FOR UPDATE
TO authenticated
USING (
  public.is_receptionist()
  AND notes.tenant_id = public.auth_tenant_id()
  AND notes.created_by = auth.uid()
)
WITH CHECK (
  public.is_receptionist()
  AND notes.tenant_id = public.auth_tenant_id()
  AND notes.created_by = auth.uid()
);

-- ── DELETE: solo puede borrar sus propias notas ──────────────────────────────

CREATE POLICY "receptionist_delete_own_notes"
ON public.notes
FOR DELETE
TO authenticated
USING (
  public.is_receptionist()
  AND notes.tenant_id = public.auth_tenant_id()
  AND notes.created_by = auth.uid()
);

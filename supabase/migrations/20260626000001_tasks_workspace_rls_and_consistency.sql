-- =============================================================
-- Migration: 20260626000001_tasks_workspace_rls_and_consistency
-- =============================================================
--
-- Fixes audit findings C-02 and A-04 for the tasks table.
--
-- PART 1 — RLS (C-02):
--   The previous "receptionist_all_tasks" policy allowed any receptionist
--   to read and mutate any task in their tenant, regardless of workspace.
--   The application layer already filters by workspace in listTasks() and
--   getTaskById(), but the RLS was not enforcing it, leaving the direct
--   Supabase API unprotected.
--
--   New policy mirrors the application logic exactly:
--     - auth_workspace_ids() IS NULL  → full access (owner or unscoped receptionist)
--     - workspace_id = ANY(auth_workspace_ids()) → scoped receptionist sees only
--       their workspaces
--     - workspace_id IS NULL is NOT an escape hatch (global tasks remain invisible
--       to scoped receptionists, matching the current .in() filter behavior in the app)
--
-- PART 2 — Consistency trigger (A-04):
--   tasks.workspace_id references workspaces(id) but there was no DB-level
--   guarantee that the workspace belongs to the same tenant as the task.
--   The new trigger check_task_workspace_consistency() follows the same pattern
--   as check_unit_tenant_consistency() and check_availability_block_tenant_consistency().
--   NULL workspace_id is explicitly allowed (global/owner tasks).
--
-- Scope:
--   - 1 RLS policy dropped and recreated
--   - 1 trigger function created
--   - 1 trigger registered on tasks (BEFORE INSERT OR UPDATE)
--   - No data modified, no indexes modified, no tables recreated
-- =============================================================

BEGIN;

-- ============================================================
-- PART 1: Fix RLS policy for receptionists
-- ============================================================

DROP POLICY IF EXISTS "receptionist_all_tasks" ON public.tasks;

CREATE POLICY "receptionist_all_tasks"
ON public.tasks FOR ALL TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    public.auth_workspace_ids() IS NULL
    OR workspace_id = ANY(public.auth_workspace_ids())
  )
)
WITH CHECK (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND (
    public.auth_workspace_ids() IS NULL
    OR workspace_id = ANY(public.auth_workspace_ids())
  )
);

-- ============================================================
-- PART 2: Consistency trigger for tasks.workspace_id
-- ============================================================
-- Validates that when workspace_id is set, the workspace belongs
-- to the same tenant as the task. NULL workspace_id is allowed
-- (owner-created global tasks).
--
-- Pattern: identical to check_unit_tenant_consistency() and
--          check_availability_block_tenant_consistency().

CREATE OR REPLACE FUNCTION public.check_task_workspace_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_tenant UUID;
BEGIN
  -- NULL workspace_id is valid: owner-created global tasks
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO v_workspace_tenant
  FROM public.workspaces
  WHERE id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace % does not exist', NEW.workspace_id;
  END IF;

  IF v_workspace_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'tasks.workspace_id (%) belongs to tenant (%), but task belongs to tenant (%). '
      'Cross-tenant workspace references are not allowed.',
      NEW.workspace_id, v_workspace_tenant, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_workspace_consistency
ON public.tasks;

CREATE TRIGGER trg_task_workspace_consistency
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.check_task_workspace_consistency();

COMMIT;

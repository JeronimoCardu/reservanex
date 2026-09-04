-- =============================================================================
-- 26-add-tasks-workspace.sql
-- Adds workspace_id to tasks for receptionist-level workspace scoping
-- =============================================================================
--
-- Motivo: receptionists only have access to workspaces assigned to them.
-- Tasks must carry a workspace_id so the application layer can enforce this
-- without relying exclusively on RLS.
--
-- Nullable: existing tasks and owner-created "global" tasks have workspace_id = NULL.
-- Receptionists only see tasks where workspace_id IN (their assigned workspaceIds).
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_tasks_workspace;
--   ALTER TABLE tasks DROP COLUMN IF EXISTS workspace_id;
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'tasks'
      AND  column_name  = 'workspace_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN workspace_id UUID NULL REFERENCES workspaces(id);

    -- Backfill: inherit workspace from linked conversation where available
    UPDATE tasks t
    SET    workspace_id = c.workspace_id
    FROM   conversations c
    WHERE  t.conversation_id = c.id
      AND  c.workspace_id    IS NOT NULL
      AND  t.workspace_id    IS NULL;

    RAISE NOTICE 'MIG-4: tasks.workspace_id created and backfilled.';
  ELSE
    RAISE NOTICE 'MIG-4: SKIP — tasks.workspace_id already exists.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_workspace
  ON tasks (tenant_id, workspace_id)
  WHERE workspace_id IS NOT NULL;

-- Verification
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public' AND table_name = 'tasks' AND column_name = 'workspace_id';
-- Expected: 1 row | data_type = uuid | is_nullable = YES

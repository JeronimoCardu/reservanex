-- =============================================================================
-- tasks.workspace_id — workspace scoping for receptionist-level task access
-- =============================================================================
-- Receptionists only have access to workspaces assigned to them.
-- Tasks must carry a workspace_id so the application layer can enforce this
-- without relying exclusively on RLS.
-- Nullable: existing tasks and owner-created "global" tasks have workspace_id = NULL.
-- =============================================================================

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workspace_id UUID NULL REFERENCES workspaces(id);

-- Backfill: inherit workspace from linked conversation where available.
-- On fresh migration this is a no-op (empty table).
UPDATE tasks t
SET    workspace_id = c.workspace_id
FROM   conversations c
WHERE  t.conversation_id = c.id
  AND  c.workspace_id    IS NOT NULL
  AND  t.workspace_id    IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_workspace
  ON tasks (tenant_id, workspace_id)
  WHERE workspace_id IS NOT NULL;

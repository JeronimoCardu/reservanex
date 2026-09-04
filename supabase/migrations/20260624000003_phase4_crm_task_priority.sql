-- Add priority column to tasks table (Phase 4 CRM)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high'));

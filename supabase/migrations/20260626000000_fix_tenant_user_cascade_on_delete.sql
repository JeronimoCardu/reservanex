-- =============================================================
-- Migration: 20260626000000_fix_tenant_user_cascade_on_delete
-- =============================================================
--
-- Problem (audit finding C-01):
--   tenant_users.id references auth.users(id) ON DELETE CASCADE, so deleting
--   an auth user attempts to delete the tenant_users row. However, six FK
--   constraints from other tables reference tenant_users(id) with the default
--   RESTRICT behavior, blocking that cascade. Any user with activity
--   (tasks, notes, messages, conversations, availability blocks) cannot be
--   deleted from Supabase Auth without a manual SQL cleanup.
--
-- Fix:
--   Replace RESTRICT with ON DELETE SET NULL on all historical-reference FKs.
--   Historical data (tasks, messages, notes, etc.) is preserved intact;
--   the user reference becomes NULL, indicating "created/assigned by a user
--   who no longer exists".
--
--   Two columns were NOT NULL and must first be made nullable:
--     - tasks.created_by
--     - notes.created_by
--
--   The messages.sender_id_consistency CHECK must be relaxed:
--     Original: human messages require sender_id IS NOT NULL
--     Relaxed:  only non-human messages are required to have sender_id IS NULL
--               (human messages may have sender_id IS NULL for deleted-user rows)
--
-- Scope:
--   - 6 FK constraints dropped and recreated with ON DELETE SET NULL
--   - 2 columns made nullable (tasks.created_by, notes.created_by)
--   - 1 CHECK constraint relaxed (messages_sender_id_consistency)
--   - No data modified, no indexes modified, no RLS modified, no triggers modified
-- =============================================================

BEGIN;

-- ============================================================
-- STEP 1: tasks.created_by
--   NOT NULL → nullable, then FK recreated with ON DELETE SET NULL
-- ============================================================

ALTER TABLE public.tasks
  ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_created_by_fkey;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES public.tenant_users(id)
    ON DELETE SET NULL;

-- ============================================================
-- STEP 2: tasks.assigned_to
--   Already nullable — FK recreated with ON DELETE SET NULL
-- ============================================================

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_assigned_to_fkey;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_assigned_to_fkey
    FOREIGN KEY (assigned_to)
    REFERENCES public.tenant_users(id)
    ON DELETE SET NULL;

-- ============================================================
-- STEP 3: notes.created_by
--   NOT NULL → nullable, then FK recreated with ON DELETE SET NULL
-- ============================================================

ALTER TABLE public.notes
  ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_created_by_fkey;

ALTER TABLE public.notes
  ADD CONSTRAINT notes_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES public.tenant_users(id)
    ON DELETE SET NULL;

-- ============================================================
-- STEP 4: messages.sender_id
--   Relax the consistency CHECK, then recreate FK with ON DELETE SET NULL
--
--   Original CHECK:
--     (sender_type = 'human'  AND sender_id IS NOT NULL) OR
--     (sender_type <> 'human' AND sender_id IS NULL)
--
--   Relaxed CHECK (semantics preserved for non-human senders):
--     sender_type = 'human' OR sender_id IS NULL
--
--   This means:
--     - human   + sender_id NOT NULL  → valid (active user sent it)
--     - human   + sender_id IS NULL   → valid (deleted user sent it — new case)
--     - bot/ai  + sender_id IS NULL   → valid (AI/bot message)
--     - bot/ai  + sender_id NOT NULL  → INVALID (bot must not have a sender)
--
--   No existing rows are affected: the new CHECK is strictly more permissive
--   than the original for human senders, and identical for non-human senders.
-- ============================================================

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_sender_id_consistency;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_id_consistency CHECK (
    sender_type = 'human' OR sender_id IS NULL
  );

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_id_fkey
    FOREIGN KEY (sender_id)
    REFERENCES public.tenant_users(id)
    ON DELETE SET NULL;

-- ============================================================
-- STEP 5: conversations.assigned_user_id
--   Already nullable — FK recreated with ON DELETE SET NULL
-- ============================================================

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_assigned_user_id_fkey;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_assigned_user_id_fkey
    FOREIGN KEY (assigned_user_id)
    REFERENCES public.tenant_users(id)
    ON DELETE SET NULL;

-- ============================================================
-- STEP 6: availability_blocks.created_by
--   Already nullable — FK recreated with ON DELETE SET NULL
-- ============================================================

ALTER TABLE public.availability_blocks
  DROP CONSTRAINT IF EXISTS availability_blocks_created_by_fkey;

ALTER TABLE public.availability_blocks
  ADD CONSTRAINT availability_blocks_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES public.tenant_users(id)
    ON DELETE SET NULL;

COMMIT;

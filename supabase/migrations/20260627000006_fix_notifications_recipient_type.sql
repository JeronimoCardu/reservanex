-- =============================================================
-- Migration: 20260627000006_fix_notifications_recipient_type
-- =============================================================
--
-- Implements audit finding F-01 (A-03).
--
-- Problem:
--   Triple inconsistency between the three layers that use
--   notifications.recipient_type:
--
--   Layer                              Value used
--   ─────────────────────────────────  ──────────────────
--   CHECK constraint (base schema)     'user', 'contact'
--   RLS receptionist policy            'user'
--   Application (notifications repo)   'tenant_user'
--
--   Any INSERT from the application fails the CHECK constraint
--   ('tenant_user' is not in ('user','contact')). Any SELECT
--   filtered by 'tenant_user' returns 0 rows even if 'user'
--   rows existed. The notification subsystem was entirely broken.
--
-- Root cause:
--   The base schema used 'user' as a shorthand for the tenant
--   user type. The rest of the project settled on 'tenant_user'
--   to distinguish it from platform_users. The schema was never
--   updated to match.
--
-- Conditions that make this migration safe:
--   1. public.notifications is empty (COUNT(*) = 0, confirmed).
--   2. No code path has ever successfully inserted a row with
--      recipient_type = 'user' (the CHECK would have blocked it
--      if the app tried 'tenant_user', and nothing writes 'user').
--   3. No backward compatibility is required.
--
-- Changes in this migration:
--   1. DROP + ADD the CHECK constraint: 'user' → 'tenant_user'
--   2. DROP + CREATE receptionist RLS policy with updated literal
--   3. CREATE OR REPLACE trigger function for FK-equivalent
--      validation (recipient_id must exist in the declared table)
--   4. CREATE trigger trg_notification_recipient_consistency
--   5. UPDATE COMMENT ON COLUMN to reflect the new value
--
-- Tables modified: public.notifications only.
-- No other tables, indexes, functions, or triggers are modified.
-- =============================================================

BEGIN;

-- ============================================================
-- STEP 1 — Fix CHECK constraint
-- ============================================================
-- Original: recipient_type IN ('user', 'contact')
-- New:      recipient_type IN ('tenant_user', 'contact')
--
-- PostgreSQL auto-names inline CHECK constraints as
-- {table}_{column}_check. The explicit name below matches
-- the auto-generated name from base_schema_v3.
-- ============================================================

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_recipient_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_recipient_type_check
    CHECK (recipient_type IN ('tenant_user', 'contact'));


-- ============================================================
-- STEP 2 — Fix RLS: receptionist_select_own_notifications
-- ============================================================
-- Only this policy references recipient_type.
-- sa_imp_all_notifications and owner_all_notifications do not
-- reference recipient_type and are unchanged.
-- ============================================================

DROP POLICY IF EXISTS "receptionist_select_own_notifications"
  ON public.notifications;

CREATE POLICY "receptionist_select_own_notifications"
ON public.notifications FOR SELECT TO authenticated
USING (
  public.is_receptionist()
  AND tenant_id = public.auth_tenant_id()
  AND recipient_type = 'tenant_user'
  AND recipient_id   = auth.uid()
);


-- ============================================================
-- STEP 3 — Trigger function: referential integrity validation
-- ============================================================
-- notifications.recipient_id has no FK because it is polymorphic
-- (points to tenant_users OR contacts depending on recipient_type).
-- This trigger enforces that constraint at the DB level.
--
-- Pattern mirrors check_task_workspace_consistency and siblings.
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_notification_recipient_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.recipient_type = 'tenant_user' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users WHERE id = NEW.recipient_id
    ) THEN
      RAISE EXCEPTION
        'notifications.recipient_id (%) does not exist in tenant_users',
        NEW.recipient_id;
    END IF;

  ELSIF NEW.recipient_type = 'contact' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.contacts WHERE id = NEW.recipient_id
    ) THEN
      RAISE EXCEPTION
        'notifications.recipient_id (%) does not exist in contacts',
        NEW.recipient_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- STEP 4 — Trigger: trg_notification_recipient_consistency
-- ============================================================

DROP TRIGGER IF EXISTS trg_notification_recipient_consistency
  ON public.notifications;

CREATE TRIGGER trg_notification_recipient_consistency
  BEFORE INSERT OR UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.check_notification_recipient_consistency();


-- ============================================================
-- STEP 5 — Update column comment
-- ============================================================

COMMENT ON COLUMN public.notifications.recipient_type IS
  '''tenant_user'' → tenant_users.id | ''contact'' → contacts.id';

COMMIT;

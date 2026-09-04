-- =============================================================
-- Migration: 20260626000002_cron_job_functions
-- =============================================================
--
-- Creates dedicated SQL functions for the three scheduled processes
-- documented (but not applied) in Section 9 of base_schema_v3.
--
-- Context (audit finding C-03):
--   The base schema had the cron logic embedded as inline SQL inside
--   commented-out cron.schedule() calls. This migration extracts that
--   logic into named, testable, reusable functions. The following
--   migration (20260626000003) registers the pg_cron schedules that
--   call these functions.
--
-- Functions created:
--   public.expire_pre_reservations()    → INTEGER (rows updated)
--   public.reclaim_stuck_queue_items()  → INTEGER (rows updated)
--   public.purge_old_queue_items()      → INTEGER (rows deleted)
--
-- All three functions are:
--   - Idempotent: safe to run multiple times; repeated calls on the
--     same state produce no additional changes.
--   - SECURITY DEFINER: run as the function owner, not the pg_cron
--     caller, so no elevated-privilege grants are needed on the tables.
--   - SET search_path = public: prevents search_path injection.
-- =============================================================


-- ============================================================
-- FUNCTION 1: expire_pre_reservations()
-- ============================================================
-- Cancels any pre_reserved reservation whose expires_at is in the past.
--
-- Side effect (automatic, via existing trigger):
--   trg_release_availability_on_cancel fires AFTER UPDATE on each
--   cancelled row → release_availability_on_cancellation() deletes
--   the corresponding availability_blocks row. No extra logic needed here.
--
-- Idempotency: already-cancelled rows have status <> 'pre_reserved'
-- and will not match the WHERE clause on subsequent runs.
--
-- Returns: number of reservations expired in this run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.expire_pre_reservations()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.reservations
  SET status = 'cancelled'
  WHERE status = 'pre_reserved'
    AND expires_at < now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.expire_pre_reservations() IS
  'Cancels stale pre_reserved reservations whose expires_at is in the past. '
  'Called by pg_cron every 15 minutes. Triggers release_availability_on_cancellation '
  'automatically via trg_release_availability_on_cancel. Returns rows updated.';


-- ============================================================
-- FUNCTION 2: reclaim_stuck_queue_items()
-- ============================================================
-- Reclaims message_queue rows that have been stuck in ''processing''
-- for more than 5 minutes (worker crash / timeout).
--
-- Logic (corrected from inline version):
--   If attempts + 1 < max_attempts  → reset to 'pending' for retry.
--   If attempts + 1 >= max_attempts → mark as 'failed' (no more retries).
--
--   The inline SQL in the schema comment always reset to 'pending',
--   which could cause infinite retry loops for persistently failing items.
--   This function respects max_attempts.
--
-- Idempotency: reclaimed rows become 'pending' or 'failed'.
-- Subsequent runs find status <> 'processing' and skip them.
--
-- Returns: number of queue items reclaimed in this run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.reclaim_stuck_queue_items()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.message_queue
  SET
    status = CASE
      WHEN attempts + 1 >= max_attempts THEN 'failed'::queue_status
      ELSE                                   'pending'::queue_status
    END,
    processing_started_at = NULL,
    attempts              = attempts + 1,
    last_error            = CASE
      WHEN attempts + 1 >= max_attempts
      THEN COALESCE(last_error, 'Reclaimed by pg_cron: max_attempts exceeded')
      ELSE last_error
    END
  WHERE status = 'processing'
    AND processing_started_at < now() - interval '5 minutes';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.reclaim_stuck_queue_items() IS
  'Reclaims message_queue rows stuck in processing for > 5 minutes. '
  'Respects max_attempts: exhausted items become failed, others return to pending. '
  'Called by pg_cron every 10 minutes. Returns rows updated.';


-- ============================================================
-- FUNCTION 3: purge_old_queue_items()
-- ============================================================
-- Deletes completed and failed message_queue rows older than 7 days.
-- Prevents unbounded table growth.
--
-- Idempotency: DELETE is inherently idempotent — already-deleted rows
-- cannot be deleted again.
--
-- Returns: number of rows purged in this run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_old_queue_items()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.message_queue
  WHERE status IN ('completed', 'failed')
    AND created_at < now() - interval '7 days';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.purge_old_queue_items() IS
  'Deletes completed and failed message_queue rows older than 7 days. '
  'Called by pg_cron daily at 03:00 UTC. Returns rows deleted.';


-- ============================================================
-- GRANTS: allow the pg_cron background worker to call these functions
-- ============================================================
-- pg_cron jobs run as the role that owns the cron job (typically
-- postgres/supabase_admin). SECURITY DEFINER ensures the function
-- runs with owner privileges regardless of who calls it.
-- No additional grants are required beyond EXECUTE for authenticated
-- (not needed since pg_cron uses a superuser-adjacent role).
-- ============================================================

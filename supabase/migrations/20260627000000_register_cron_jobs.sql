-- =============================================================
-- Migration: 20260627000000_register_cron_jobs
-- =============================================================
--
-- Registers the three pg_cron jobs documented in Section 9 of
-- 20260620000000_base_schema_v3.sql (previously commented-out
-- as "register manually in Dashboard"). This migration makes the
-- registration part of the normal migration lifecycle.
--
-- Prerequisite:
--   pg_cron extension must be enabled in the Supabase project
--   before applying this migration.
--   Dashboard → Database → Extensions → pg_cron → Enable
--
-- Idempotency:
--   The opening DO block removes any previously registered jobs
--   with the same names before re-creating them. Applying this
--   migration more than once produces the same final state.
--   The EXCEPTION guard makes the DO block a no-op on a fresh
--   install where the jobs do not yet exist (or where the cron
--   schema is unavailable).
--
-- Jobs registered:
--   expire-pre-reservations   → */15 * * * *  (every 15 min)
--   reclaim-stuck-queue-items → */10 * * * *  (every 10 min)
--   purge-old-queue-items     → 0 3 * * *     (daily 03:00 UTC)
--
-- Verification after apply:
--   SELECT jobid, jobname, schedule, command
--   FROM cron.job
--   WHERE jobname IN (
--     'expire-pre-reservations',
--     'reclaim-stuck-queue-items',
--     'purge-old-queue-items'
--   )
--   ORDER BY jobname;
-- =============================================================

BEGIN;

-- ============================================================
-- STEP 1 — Idempotency: remove existing jobs by jobid
-- ============================================================
-- Queries cron.job by jobname and unschedules each match.
-- Using jobid (not jobname) avoids ambiguity if pg_cron ever
-- allows duplicate names in older schema versions.
-- EXCEPTION guard silences "relation cron.job does not exist"
-- on databases where the cron schema is not yet available.
-- ============================================================

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN (
    'expire-pre-reservations',
    'reclaim-stuck-queue-items',
    'purge-old-queue-items'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;


-- ============================================================
-- JOB A — Expire pre_reserved reservations
-- Schedule: every 15 minutes
-- ============================================================
-- Cancels reservations whose TTL has passed.
-- Sets updated_at explicitly in addition to the trigger so the
-- timestamp is consistent even if the trigger is ever disabled.
--
-- Side effect (automatic, via existing trigger):
--   trg_release_availability_on_cancel fires AFTER UPDATE for
--   each cancelled row and deletes the corresponding
--   availability_blocks entry via release_availability_on_cancellation().
-- ============================================================

SELECT cron.schedule(
  'expire-pre-reservations',
  '*/15 * * * *',
  $$
    UPDATE public.reservations
    SET
      status     = 'cancelled',
      updated_at = now()
    WHERE
      status     = 'pre_reserved'
      AND expires_at < now()
  $$
);


-- ============================================================
-- JOB B — Reclaim stuck message_queue items
-- Schedule: every 10 minutes
-- ============================================================
-- Resets to 'pending' any queue item stuck in 'processing' for
-- more than 5 minutes (worker crash, timeout, or lost connection).
-- Increments attempts so the worker can detect repeated failures.
-- Items whose attempts reach max_attempts are naturally moved to
-- 'failed' by the worker on the next pick-up.
-- ============================================================

SELECT cron.schedule(
  'reclaim-stuck-queue-items',
  '*/10 * * * *',
  $$
    UPDATE public.message_queue
    SET
      status                = 'pending',
      processing_started_at = NULL,
      attempts              = attempts + 1
    WHERE
      status = 'processing'
      AND processing_started_at < now() - interval '5 minutes'
  $$
);


-- ============================================================
-- JOB C — Purge old completed/failed queue rows
-- Schedule: daily at 03:00 UTC
-- ============================================================
-- Prevents unbounded growth of message_queue.
-- Retention policy: completed and failed rows older than 7 days
-- are deleted. Pending and processing rows are never purged.
-- ============================================================

SELECT cron.schedule(
  'purge-old-queue-items',
  '0 3 * * *',
  $$
    DELETE FROM public.message_queue
    WHERE
      status IN ('completed', 'failed')
      AND created_at < now() - interval '7 days'
  $$
);

COMMIT;

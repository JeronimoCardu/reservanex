-- =============================================================
-- Migration: 20260627000005_drop_dead_cron_functions
-- =============================================================
--
-- Removes three functions created in 20260626000002 that are
-- dead code: no cron job, trigger, RPC, repository, or server
-- action calls them.
--
-- Root cause:
--   20260626000002 was created with the intent that migration
--   20260626000003 would register pg_cron jobs calling these
--   functions. That draft was deleted and replaced by
--   20260627000000, which registers the jobs using inline SQL
--   directly — not function calls.
--
-- Evidence of dead code (exhaustive search across all layers):
--   Callers in supabase/migrations/**  only 20260626000002 itself (definition)
--   Callers in apps/**                 none
--   Callers in packages/**             none
--   cron.schedule() SQL in 20260627000000  inline SQL, no function calls
--   Triggers                           none
--   RPC                                none
--
-- Additional defect:
--   reclaim_stuck_queue_items() references column max_attempts, which
--   does not exist in public.message_queue. Any invocation would fail
--   with "column max_attempts does not exist".
--
-- Effect:
--   - Drops public.expire_pre_reservations()
--   - Drops public.reclaim_stuck_queue_items()
--   - Drops public.purge_old_queue_items()
--   DROP FUNCTION automatically removes associated COMMENT ON FUNCTION.
--   No cron jobs are modified (they use inline SQL, not these functions).
--   No tables, indexes, RLS policies, or triggers are modified.
--   No application behavior changes.
--
-- Idempotency: DROP FUNCTION IF EXISTS — safe to re-apply.
-- =============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.expire_pre_reservations();
DROP FUNCTION IF EXISTS public.reclaim_stuck_queue_items();
DROP FUNCTION IF EXISTS public.purge_old_queue_items();

COMMIT;

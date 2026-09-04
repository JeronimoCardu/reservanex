-- ─────────────────────────────────────────────────────────────────────────────
-- Sprint 2C-1: Payment proof deduplication
--
-- Problem: multiple payment_proof documents can exist for the same WhatsApp
-- media file because the application-level dedupe check did not guard all
-- paths (e.g. saving same image with and without a reservation).
--
-- Fix:
--   1. Clean up existing duplicates, keeping the "best" row per
--      (tenant_id, document_type, storage_bucket, storage_path).
--      Best = has reservation_id (non-null) first, then oldest created_at.
--   2. Create a unique partial index to prevent future duplicates at the DB level.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Step 1: Delete duplicate payment_proof rows.
-- Keeper ranking per group:
--   1. reservation_id IS NOT NULL → preferred (more info preserved)
--   2. oldest created_at → stable across retries
--   3. lowest id → deterministic tiebreak
DELETE FROM public.documents
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY tenant_id, document_type, storage_bucket, storage_path
        ORDER BY
          CASE WHEN reservation_id IS NOT NULL THEN 0 ELSE 1 END ASC,
          created_at ASC,
          id ASC
      ) AS rn
    FROM public.documents
    WHERE document_type = 'payment_proof'
      AND storage_path   IS NOT NULL
      AND storage_bucket IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Step 2: Unique partial index — one payment_proof per (tenant, bucket, path).
-- Partial (WHERE) so it only applies to payment_proof rows with a storage_path,
-- leaving other document_types and path-less rows untouched.
CREATE UNIQUE INDEX IF NOT EXISTS documents_payment_proof_unique_storage_path_idx
  ON public.documents (tenant_id, storage_bucket, storage_path)
  WHERE document_type = 'payment_proof'
    AND storage_path IS NOT NULL;

-- Validation query (should return 0 rows after this migration):
-- SELECT tenant_id, storage_bucket, storage_path, COUNT(*)
-- FROM public.documents
-- WHERE document_type = 'payment_proof'
-- GROUP BY tenant_id, storage_bucket, storage_path
-- HAVING COUNT(*) > 1;

COMMIT;

-- =============================================================================
-- 20260817000001_monthly_rental_charges_partial_unique.sql
-- Sprint 5C.1 fix: allow re-creating a charge for a cancelled period.
--
-- Antes: UNIQUE (contract_id, period_year, period_month)  — bloquea todo,
--        incluyendo cuotas canceladas.
-- Ahora: índice único parcial WHERE status <> 'cancelled'
--        → las cuotas cancelled quedan como historial y no bloquean nuevas.
-- =============================================================================

BEGIN;

-- Drop the full unique constraint added inline in monthly_rental_tables migration.
-- The auto-generated name follows Postgres convention: table_col1_col2_col3_key.
ALTER TABLE public.monthly_rental_charges
  DROP CONSTRAINT IF EXISTS monthly_rental_charges_contract_id_period_year_period_month_key;

-- Partial unique index: only one non-cancelled charge per period per contract.
CREATE UNIQUE INDEX IF NOT EXISTS idx_monthly_rental_charges_period_unique_active
  ON public.monthly_rental_charges (contract_id, period_year, period_month)
  WHERE status <> 'cancelled';

COMMIT;

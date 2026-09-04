-- Migration: 20260709000002_migrate_assisted_to_manual
--
-- Context:
--   The MVP drops 'IA asistida' as an active mode. Only 'manual' and 'autonomous'
--   are exposed in the UI going forward. The PostgreSQL enum value 'assisted' is
--   intentionally NOT removed (altering an enum in Postgres is a table rewrite and
--   requires careful coordination). Instead, existing 'assisted' rows are migrated
--   to 'manual', which has equivalent operational behaviour (human agent handles it).
--
-- Safety:
--   - Idempotent: UPDATE WHERE ai_mode = 'assisted' is a no-op if already migrated.
--   - No cascade side-effects: ai_mode is not a FK, just a plain enum column.
--   - The trigger from 20260709000001 uses IN ('manual', 'assisted') as a safety net
--     for the migration window; no change needed there.

BEGIN;

UPDATE public.conversations
SET ai_mode = 'manual'
WHERE ai_mode = 'assisted';

COMMIT;

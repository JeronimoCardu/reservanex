BEGIN;
-- Migration: 20260624000002_phase4_crm_ai_mode_rename.sql
-- MIG-2 (B8): Renombra los valores del enum ai_mode.
--   Antes:  'auto' | 'human' | 'disabled'
--   Después: 'manual' | 'assisted' | 'autonomous'
--
-- Mapeo semántico:
--   'human'    → 'manual'      (agente humano responde, IA silenciada)
--   'auto'     → 'autonomous'  (IA responde automáticamente)
--   'disabled' → 'manual'      (IA no disponible = modo manual)
--
-- Rollback (si 0 datos de producción):
--   ALTER TABLE conversations DROP COLUMN ai_mode;
--   DROP TYPE ai_mode;
--   CREATE TYPE ai_mode AS ENUM ('auto', 'human', 'disabled');
--   ALTER TABLE conversations ADD COLUMN ai_mode ai_mode NOT NULL DEFAULT 'human';
--
-- IMPORTANTE: Ejecutar regeneración de tipos después:
--   npx supabase gen types typescript --project-id veqkuriobordivdxvuhj --schema public \
--     > packages/types/src/database.ts

-- Paso 1: Columna temporal para preservar valores durante la transición
ALTER TABLE conversations ADD COLUMN ai_mode_migration TEXT;
UPDATE conversations SET ai_mode_migration = ai_mode::TEXT;

-- Paso 2: Drop la columna con el tipo viejo
ALTER TABLE conversations DROP COLUMN ai_mode;

-- Paso 3: Crear nuevo tipo enum con los valores correctos
DROP TYPE IF EXISTS ai_mode;
CREATE TYPE ai_mode AS ENUM ('manual', 'assisted', 'autonomous');

-- Paso 4: Recrear la columna con el nuevo tipo
ALTER TABLE conversations ADD COLUMN ai_mode ai_mode NOT NULL DEFAULT 'manual';

-- Paso 5: Mapear valores anteriores a los nuevos
UPDATE conversations SET ai_mode = CASE
  WHEN ai_mode_migration = 'auto'     THEN 'autonomous'::ai_mode
  WHEN ai_mode_migration = 'human'    THEN 'manual'::ai_mode
  WHEN ai_mode_migration = 'disabled' THEN 'manual'::ai_mode
  ELSE 'manual'::ai_mode
END;

-- Paso 6: Limpiar columna temporal
ALTER TABLE conversations DROP COLUMN ai_mode_migration;

COMMIT;
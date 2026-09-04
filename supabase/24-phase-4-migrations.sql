-- =============================================================================
-- Phase 4 CRM — Migrations bundle
-- File: 24-phase-4-migrations.sql
-- =============================================================================
--
-- Contenido:
--   MIG-1  notifications.read_at   (B7 — read tracking con timestamp)
--   MIG-2  ai_mode enum rename     (B8 — auto|human|disabled → manual|assisted|autonomous)
--   MIG-3  tasks.priority          (columna de prioridad en tareas)
--
-- Características:
--   - Idempotente: seguro ejecutar múltiples veces
--   - Cada migración está envuelta en un bloque DO $$ ... $$ con guards
--   - Toda la ejecución ocurre dentro de una transacción implícita por bloque
--   - Las queries de verificación al final NO modifican datos
--
-- Pre-requisitos:
--   - PostgreSQL 13+ / Supabase (compatible)
--   - Tablas existentes: notifications, conversations, tasks
--   - Enum existente: ai_mode con valores 'auto' | 'human' | 'disabled'
--
-- Post-ejecución obligatoria:
--   Regenerar tipos TypeScript:
--     npx supabase gen types typescript \
--       --project-id veqkuriobordivdxvuhj \
--       --schema public \
--       > packages/types/src/database.ts
--
--   Luego remover overrides manuales en:
--     packages/types/src/database.ts              (NotificationRow, tasks.priority)
--     src/lib/repositories/conversations.repository.ts  (type AiMode local + as any)
--     src/lib/repositories/notifications.repository.ts  (eslint-disable blocks)
--
-- =============================================================================


-- =============================================================================
-- MIG-1: notifications.read_at
-- =============================================================================
--
-- Propósito:
--   Agrega read_at TIMESTAMPTZ NULL a la tabla notifications para rastrear
--   cuándo el usuario leyó cada notificación (B7).
--   Reemplaza cualquier proxy basado en status para lectura.
--
-- Comportamiento:
--   - NULL  → no leída
--   - valor → timestamp UTC de cuando fue marcada como leída
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_notifications_unread;
--   ALTER TABLE notifications DROP COLUMN IF EXISTS read_at;
--
-- =============================================================================

DO $$
BEGIN
  -- Guard: solo ejecutar si read_at no existe todavía
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'notifications'
      AND  column_name  = 'read_at'
  ) THEN

    RAISE NOTICE '[MIG-1] Agregando columna notifications.read_at ...';

    ALTER TABLE notifications
      ADD COLUMN read_at TIMESTAMPTZ NULL;

    RAISE NOTICE '[MIG-1] Columna notifications.read_at creada.';

  ELSE
    RAISE NOTICE '[MIG-1] SKIP — notifications.read_at ya existe.';
  END IF;
END $$;

-- Índice parcial para queries de "no leídas" (idempotente vía IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (tenant_id, recipient_id, channel)
  WHERE read_at IS NULL;

-- Índice para lookup por recipient (útil para marcar como leída por ID)
CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications (tenant_id, recipient_id, created_at DESC);


-- =============================================================================
-- MIG-2: ai_mode enum rename
-- =============================================================================
--
-- Propósito:
--   Renombra los valores del enum ai_mode (B8):
--     'human'    → 'manual'      (agente responde manualmente, IA silenciada)
--     'auto'     → 'autonomous'  (IA responde de forma autónoma)
--     'disabled' → 'manual'      (sin IA = modo manual)
--
-- Estrategia:
--   PostgreSQL no permite renombrar valores de enum directamente.
--   La estrategia segura es:
--     1. Guardar valores en columna TEXT temporal
--     2. Dropear columna ai_mode del tipo viejo
--     3. Crear nuevo tipo ai_mode con valores nuevos
--     4. Recrear la columna con el nuevo tipo
--     5. Restaurar datos mapeados
--     6. Limpiar columna temporal
--
-- Guard de idempotencia:
--   Si el enum ya tiene el valor 'manual', la migración fue aplicada → SKIP.
--
-- Rollback (solo si NO hay datos de producción que preservar):
--   BEGIN;
--     ALTER TABLE conversations DROP COLUMN IF EXISTS ai_mode;
--     ALTER TABLE conversations DROP COLUMN IF EXISTS ai_mode_migration;
--     DROP TYPE IF EXISTS ai_mode;
--     CREATE TYPE ai_mode AS ENUM ('auto', 'human', 'disabled');
--     ALTER TABLE conversations
--       ADD COLUMN ai_mode ai_mode NOT NULL DEFAULT 'human';
--   COMMIT;
--
-- Rollback con datos (recuperar desde backup o regenerar desde logs de auditoría).
--
-- =============================================================================

DO $$
DECLARE
  v_already_migrated BOOLEAN;
  v_has_temp_column  BOOLEAN;
BEGIN
  -- Guard: verificar si el enum ya tiene los nuevos valores
  SELECT EXISTS (
    SELECT 1
    FROM   pg_enum      pe
    JOIN   pg_type      pt ON pe.enumtypid = pt.oid
    WHERE  pt.typname   = 'ai_mode'
      AND  pe.enumlabel = 'manual'
  ) INTO v_already_migrated;

  IF v_already_migrated THEN
    RAISE NOTICE '[MIG-2] SKIP — enum ai_mode ya tiene valor ''manual''. Migración ya aplicada.';
    RETURN;
  END IF;

  RAISE NOTICE '[MIG-2] Iniciando migración de enum ai_mode ...';

  -- ─── Paso 1: columna temporal para preservar valores ──────────────────────
  --
  -- Verificar si ai_mode_migration ya existe (ejecución parcialmente fallida anterior)
  SELECT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'conversations'
      AND  column_name  = 'ai_mode_migration'
  ) INTO v_has_temp_column;

  IF NOT v_has_temp_column THEN
    ALTER TABLE conversations ADD COLUMN ai_mode_migration TEXT;
    RAISE NOTICE '[MIG-2] Paso 1: columna temporal ai_mode_migration creada.';
  ELSE
    RAISE NOTICE '[MIG-2] Paso 1: SKIP — columna temporal ya existe (ejecución anterior parcial).';
  END IF;

  -- Copiar valores actuales como texto (safe aún si la columna ya tenía datos)
  UPDATE conversations
  SET    ai_mode_migration = ai_mode::TEXT
  WHERE  ai_mode_migration IS NULL;

  RAISE NOTICE '[MIG-2] Paso 1: valores copiados a columna temporal.';

  -- ─── Paso 2: eliminar columna con tipo viejo ───────────────────────────────
  ALTER TABLE conversations DROP COLUMN IF EXISTS ai_mode;
  RAISE NOTICE '[MIG-2] Paso 2: columna ai_mode (tipo viejo) eliminada.';

  -- ─── Paso 3: reemplazar el tipo enum ──────────────────────────────────────
  DROP TYPE IF EXISTS ai_mode;
  CREATE TYPE ai_mode AS ENUM ('manual', 'assisted', 'autonomous');
  RAISE NOTICE '[MIG-2] Paso 3: nuevo enum ai_mode creado con valores manual|assisted|autonomous.';

  -- ─── Paso 4: recrear columna con nuevo tipo ───────────────────────────────
  ALTER TABLE conversations
    ADD COLUMN ai_mode ai_mode NOT NULL DEFAULT 'manual';
  RAISE NOTICE '[MIG-2] Paso 4: columna ai_mode recreada con tipo nuevo.';

  -- ─── Paso 5: restaurar datos mapeados ─────────────────────────────────────
  UPDATE conversations
  SET ai_mode = CASE ai_mode_migration
    WHEN 'human'    THEN 'manual'::ai_mode
    WHEN 'auto'     THEN 'autonomous'::ai_mode
    WHEN 'disabled' THEN 'manual'::ai_mode
    ELSE                 'manual'::ai_mode   -- fallback seguro
  END;
  RAISE NOTICE '[MIG-2] Paso 5: datos mapeados (human→manual, auto→autonomous, disabled→manual).';

  -- ─── Paso 6: limpiar columna temporal ─────────────────────────────────────
  ALTER TABLE conversations DROP COLUMN ai_mode_migration;
  RAISE NOTICE '[MIG-2] Paso 6: columna temporal eliminada.';

  RAISE NOTICE '[MIG-2] Migración completada exitosamente.';

END $$;


-- =============================================================================
-- MIG-3: tasks.priority
-- =============================================================================
--
-- Propósito:
--   Agrega la columna priority a tasks con valores low | medium | high.
--   Las tareas existentes reciben el valor por defecto 'medium'.
--
-- Rollback:
--   ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;
--   ALTER TABLE tasks DROP COLUMN IF EXISTS priority;
--
-- =============================================================================

DO $$
BEGIN
  -- Guard: solo ejecutar si priority no existe todavía
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'tasks'
      AND  column_name  = 'priority'
  ) THEN

    RAISE NOTICE '[MIG-3] Agregando columna tasks.priority ...';

    -- Agregar columna (NOT NULL es seguro porque el DEFAULT llena filas existentes)
    ALTER TABLE tasks
      ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';

    RAISE NOTICE '[MIG-3] Columna tasks.priority creada.';

  ELSE
    RAISE NOTICE '[MIG-3] SKIP — tasks.priority ya existe.';
  END IF;
END $$;

-- Constraint de valores válidos (idempotente: DROP + ADD dentro de un bloque)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints tc
    JOIN   information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
    WHERE  tc.table_schema    = 'public'
      AND  tc.table_name      = 'tasks'
      AND  tc.constraint_type = 'CHECK'
      AND  ccu.column_name    = 'priority'
  ) THEN
    RAISE NOTICE '[MIG-3] Agregando constraint CHECK en tasks.priority ...';
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_priority_check
        CHECK (priority IN ('low', 'medium', 'high'));
    RAISE NOTICE '[MIG-3] Constraint tasks_priority_check creado.';
  ELSE
    RAISE NOTICE '[MIG-3] SKIP — constraint tasks_priority_check ya existe.';
  END IF;
END $$;

-- Índice para filtrar/ordenar por prioridad
CREATE INDEX IF NOT EXISTS idx_tasks_priority
  ON tasks (tenant_id, priority, due_date);


-- =============================================================================
-- VERIFICACIÓN
-- Ejecutar estas queries después de aplicar las migraciones para confirmar
-- que todo quedó correcto. No modifican datos.
-- =============================================================================

-- ─── V1: notifications.read_at ────────────────────────────────────────────────

SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'notifications'
  AND  column_name  = 'read_at';
-- Resultado esperado: 1 fila | data_type = 'timestamp with time zone' | is_nullable = 'YES'

SELECT
  indexname,
  indexdef
FROM   pg_indexes
WHERE  tablename = 'notifications'
  AND  indexname IN ('idx_notifications_unread', 'idx_notifications_recipient');
-- Resultado esperado: 2 filas

-- ─── V2: ai_mode enum ─────────────────────────────────────────────────────────

SELECT
  pe.enumlabel   AS valor,
  pe.enumsortorder AS orden
FROM   pg_enum pe
JOIN   pg_type pt ON pe.enumtypid = pt.oid
WHERE  pt.typname = 'ai_mode'
ORDER  BY pe.enumsortorder;
-- Resultado esperado: 3 filas → manual | assisted | autonomous
-- NO deben aparecer: auto, human, disabled

SELECT
  column_name,
  udt_name        AS tipo_enum,
  column_default,
  is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'conversations'
  AND  column_name  = 'ai_mode';
-- Resultado esperado: 1 fila | udt_name = 'ai_mode' | column_default = '''manual''::ai_mode'

SELECT
  ai_mode,
  COUNT(*) AS total
FROM   conversations
GROUP  BY ai_mode
ORDER  BY ai_mode;
-- Resultado esperado: solo valores 'manual', 'assisted', 'autonomous'
-- No deben aparecer 'auto', 'human', 'disabled'

-- ─── V3: tasks.priority ───────────────────────────────────────────────────────

SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'tasks'
  AND  column_name  = 'priority';
-- Resultado esperado: 1 fila | data_type = 'text' | is_nullable = 'NO' | column_default = '''medium'''

SELECT
  tc.constraint_name,
  cc.check_clause
FROM   information_schema.table_constraints   tc
JOIN   information_schema.check_constraints   cc
       ON tc.constraint_name = cc.constraint_name
WHERE  tc.table_schema  = 'public'
  AND  tc.table_name    = 'tasks'
  AND  tc.constraint_type = 'CHECK'
ORDER  BY tc.constraint_name;
-- Resultado esperado: fila con constraint_name = 'tasks_priority_check'
-- check_clause debe contener 'low', 'medium', 'high'

SELECT
  priority,
  COUNT(*) AS total
FROM   tasks
GROUP  BY priority
ORDER  BY priority;
-- Resultado esperado: solo valores 'low', 'medium', 'high'

-- ─── V4: resumen de las tres migraciones ──────────────────────────────────────

SELECT
  'MIG-1 notifications.read_at'                         AS migracion,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'read_at'
  ) THEN 'OK ✓' ELSE 'FALTA ✗' END                     AS estado

UNION ALL

SELECT
  'MIG-2 ai_mode → manual|assisted|autonomous',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_enum pe
    JOIN pg_type pt ON pe.enumtypid = pt.oid
    WHERE pt.typname = 'ai_mode' AND pe.enumlabel = 'manual'
  ) THEN 'OK ✓' ELSE 'FALTA ✗' END

UNION ALL

SELECT
  'MIG-3 tasks.priority',
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'priority'
  ) THEN 'OK ✓' ELSE 'FALTA ✗' END

ORDER  BY 1;
-- Resultado esperado: las 3 filas con estado 'OK ✓'

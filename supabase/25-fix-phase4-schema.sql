-- =============================================================================
-- 25-fix-phase4-schema.sql
-- Phase 4 CRM — Schema fix definitivo
-- Auditado contra schema real en 2026-06-24
-- =============================================================================
--
-- Cambios:
--   MIG-1  notifications.read_at   — columna de tracking de lectura
--   MIG-2  ai_mode enum rename     — auto|human|disabled → manual|assisted|autonomous
--   MIG-3  tasks.priority          — columna de prioridad
--
-- Estado verificado de la DB antes de esta migración:
--   ai_mode enum tiene: 'auto' (1), 'human' (2), 'disabled' (3)
--   conversations: 0 filas (verificado 2026-06-24)
--   notifications: sin columna read_at
--   tasks: sin columna priority
--
-- Post-ejecución obligatoria:
--   npx supabase gen types typescript \
--     --project-id veqkuriobordivdxvuhj \
--     --schema public \
--     > packages/types/src/database.ts
-- =============================================================================


-- =============================================================================
-- MIG-1 — notifications.read_at
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'notifications'
      AND  column_name  = 'read_at'
  ) THEN
    ALTER TABLE notifications ADD COLUMN read_at TIMESTAMPTZ NULL;
    RAISE NOTICE 'MIG-1: notifications.read_at creada.';
  ELSE
    RAISE NOTICE 'MIG-1: SKIP — notifications.read_at ya existe.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (tenant_id, recipient_id, channel)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications (tenant_id, recipient_id, created_at DESC);

-- Rollback:
--   DROP INDEX IF EXISTS idx_notifications_unread;
--   DROP INDEX IF EXISTS idx_notifications_recipient;
--   ALTER TABLE notifications DROP COLUMN IF EXISTS read_at;


-- =============================================================================
-- MIG-2 — ai_mode enum rename
-- =============================================================================
--
-- Enum actual (verificado):  auto | human | disabled
-- Enum objetivo:             manual | assisted | autonomous
--
-- Mapeo de valores:
--   'human'    → 'manual'      (agente responde, IA silenciada)
--   'auto'     → 'autonomous'  (IA responde de forma autónoma)
--   'disabled' → SIN MAPEO AUTOMÁTICO
--
-- Decisión sobre 'disabled':
--   No existe equivalente semántico claro en el nuevo modelo.
--   En el momento de esta migración hay 0 filas en conversations.
--   Si en el futuro existen filas con 'disabled', la migración
--   lanzará EXCEPTION y requerirá decisión manual.
--
-- Estrategia:
--   PostgreSQL no soporta ALTER TYPE ... RENAME VALUE antes de PG14.
--   Se usa columna TEXT temporal para preservar datos durante la transición.
--
-- Rollback (sin datos):
--   ALTER TABLE conversations DROP COLUMN IF EXISTS ai_mode;
--   ALTER TABLE conversations DROP COLUMN IF EXISTS ai_mode_migration;
--   DROP TYPE IF EXISTS ai_mode;
--   CREATE TYPE ai_mode AS ENUM ('auto', 'human', 'disabled');
--   ALTER TABLE conversations ADD COLUMN ai_mode ai_mode NOT NULL DEFAULT 'human';
-- =============================================================================

DO $$
DECLARE
  v_disabled_count  INT;
  v_has_temp_col    BOOLEAN;
  v_mapped_count    INT;
BEGIN

  -- ── Guard: skip si la migración ya fue aplicada ──────────────────────────
  IF EXISTS (
    SELECT 1 FROM pg_enum pe
    JOIN   pg_type pt ON pe.enumtypid = pt.oid
    WHERE  pt.typname = 'ai_mode' AND pe.enumlabel = 'manual'
  ) THEN
    RAISE NOTICE 'MIG-2: SKIP — ai_mode ya tiene valor ''manual''. Migración ya aplicada.';
    RETURN;
  END IF;

  -- ── Verificar que el enum viejo existe ───────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_mode') THEN
    RAISE EXCEPTION 'MIG-2: ERROR — enum ai_mode no encontrado. Revisar schema.';
  END IF;

  -- ── Bloquear si existen filas con valor 'disabled' ───────────────────────
  -- 'disabled' no tiene un equivalente semántico definido en el nuevo modelo.
  -- Si existen filas con este valor se requiere decisión manual.
  SELECT COUNT(*) INTO v_disabled_count
  FROM   conversations
  WHERE  ai_mode = 'disabled';

  IF v_disabled_count > 0 THEN
    RAISE EXCEPTION
      'MIG-2: BLOQUEADO — existen % fila(s) con ai_mode = ''disabled''. '
      'Este valor no tiene mapeo automático al nuevo enum. '
      'Revisá el negocio y decidí si debe migrar a ''manual'' o ''assisted'', '
      'luego actualizá las filas manualmente antes de correr esta migración.',
      v_disabled_count;
  END IF;

  RAISE NOTICE 'MIG-2: Iniciando migración (0 filas con ''disabled'', safe to proceed) ...';

  -- ── Paso 1: columna temporal para preservar valores ──────────────────────
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'conversations'
      AND  column_name  = 'ai_mode_migration'
  ) INTO v_has_temp_col;

  IF NOT v_has_temp_col THEN
    ALTER TABLE conversations ADD COLUMN ai_mode_migration TEXT;
  END IF;

  UPDATE conversations
  SET    ai_mode_migration = ai_mode::TEXT
  WHERE  ai_mode_migration IS NULL;

  RAISE NOTICE 'MIG-2: Paso 1 — valores copiados a columna temporal.';

  -- ── Paso 2: drop columna con tipo viejo ──────────────────────────────────
  ALTER TABLE conversations DROP COLUMN IF EXISTS ai_mode;
  RAISE NOTICE 'MIG-2: Paso 2 — columna ai_mode (tipo viejo) eliminada.';

  -- ── Paso 3: reemplazar el tipo enum ──────────────────────────────────────
  DROP TYPE IF EXISTS ai_mode;
  CREATE TYPE ai_mode AS ENUM ('manual', 'assisted', 'autonomous');
  RAISE NOTICE 'MIG-2: Paso 3 — tipo ai_mode recreado.';

  -- ── Paso 4: recrear columna con tipo nuevo ───────────────────────────────
  ALTER TABLE conversations ADD COLUMN ai_mode ai_mode NOT NULL DEFAULT 'manual';
  RAISE NOTICE 'MIG-2: Paso 4 — columna ai_mode recreada.';

  -- ── Paso 5: mapear valores (solo human y auto tienen mapping definido) ────
  UPDATE conversations
  SET    ai_mode = CASE ai_mode_migration
    WHEN 'human' THEN 'manual'::ai_mode
    WHEN 'auto'  THEN 'autonomous'::ai_mode
    -- 'disabled' está bloqueado arriba — nunca llega aquí
  END
  WHERE  ai_mode_migration IS NOT NULL;

  GET DIAGNOSTICS v_mapped_count = ROW_COUNT;
  RAISE NOTICE 'MIG-2: Paso 5 — % filas mapeadas (human→manual, auto→autonomous).', v_mapped_count;

  -- ── Paso 6: limpiar columna temporal ─────────────────────────────────────
  ALTER TABLE conversations DROP COLUMN ai_mode_migration;
  RAISE NOTICE 'MIG-2: Paso 6 — columna temporal eliminada.';

  RAISE NOTICE 'MIG-2: Completado.';
END $$;


-- =============================================================================
-- MIG-3 — tasks.priority
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'tasks'
      AND  column_name  = 'priority'
  ) THEN
    -- NOT NULL + DEFAULT: safe, PostgreSQL completa filas existentes sin reescribir
    ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';
    RAISE NOTICE 'MIG-3: tasks.priority creada.';
  ELSE
    RAISE NOTICE 'MIG-3: SKIP — tasks.priority ya existe.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints  tc
    JOIN   information_schema.constraint_column_usage ccu
           ON  tc.constraint_name = ccu.constraint_name
           AND tc.table_schema    = ccu.table_schema
    WHERE  tc.table_schema    = 'public'
      AND  tc.table_name      = 'tasks'
      AND  tc.constraint_type = 'CHECK'
      AND  ccu.column_name    = 'priority'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_priority_check
        CHECK (priority IN ('low', 'medium', 'high'));
    RAISE NOTICE 'MIG-3: constraint tasks_priority_check creado.';
  ELSE
    RAISE NOTICE 'MIG-3: SKIP — constraint tasks_priority_check ya existe.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_priority
  ON tasks (tenant_id, priority, due_date);

-- Rollback:
--   DROP INDEX IF EXISTS idx_tasks_priority;
--   ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;
--   ALTER TABLE tasks DROP COLUMN IF EXISTS priority;


-- =============================================================================
-- VERIFICACIÓN (read-only)
-- =============================================================================

SELECT
  migracion,
  CASE estado WHEN true THEN 'OK' ELSE 'FALTA' END AS estado
FROM (
  SELECT 'MIG-1 notifications.read_at' AS migracion,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'read_at'
    ) AS estado
  UNION ALL
  SELECT 'MIG-2 ai_mode = manual|assisted|autonomous',
    EXISTS (
      SELECT 1 FROM pg_enum pe JOIN pg_type pt ON pe.enumtypid = pt.oid
      WHERE pt.typname = 'ai_mode' AND pe.enumlabel = 'manual'
    )
  UNION ALL
  SELECT 'MIG-3 tasks.priority',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'priority'
    )
) t
ORDER BY migracion;

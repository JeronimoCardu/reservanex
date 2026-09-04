-- =============================================================
-- Migration: 20260627000002_workspace_tenant_consistency_triggers
-- =============================================================
--
-- Implements audit finding A-04.
--
-- Problem:
--   Three tables reference workspaces(id) via workspace_id but had
--   no DB-level guarantee that the referenced workspace belongs to
--   the same tenant as the row being inserted or updated:
--
--     conversations.workspace_id  (nullable)
--     properties.workspace_id     (nullable)
--     whatsapp_accounts.workspace_id (nullable)
--
--   The application layer enforces this in some paths but direct
--   DB access (webhooks, workers, migrations, Supabase Studio)
--   bypasses those checks.
--
-- Solution:
--   One BEFORE INSERT OR UPDATE trigger per table, following the
--   identical pattern already used by:
--     check_task_workspace_consistency()      (20260626000001)
--     check_unit_tenant_consistency()         (base_schema_v3)
--     check_availability_block_tenant_consistency() (base_schema_v3)
--     check_workspace_assignment_consistency() (base_schema_v3)
--
-- Pattern:
--   NULL workspace_id → allowed (workspace is optional on all three tables)
--   workspace_id not in workspaces → RAISE EXCEPTION
--   workspace.tenant_id ≠ row.tenant_id → RAISE EXCEPTION
--
-- Scope:
--   - 3 trigger functions created (or replaced — idempotent)
--   - 3 triggers created (dropped first — idempotent)
--   - No RLS modified
--   - No application code modified
-- =============================================================

BEGIN;

-- ============================================================
-- FUNCTION 1: check_conversation_workspace_consistency()
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_conversation_workspace_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_tenant UUID;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO v_workspace_tenant
  FROM public.workspaces
  WHERE id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace % does not exist', NEW.workspace_id;
  END IF;

  IF v_workspace_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'conversations.workspace_id (%) belongs to tenant (%), but conversation belongs to tenant (%). '
      'Cross-tenant workspace references are not allowed.',
      NEW.workspace_id, v_workspace_tenant, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_workspace_consistency ON public.conversations;

CREATE TRIGGER trg_conversation_workspace_consistency
  BEFORE INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.check_conversation_workspace_consistency();


-- ============================================================
-- FUNCTION 2: check_property_workspace_consistency()
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_property_workspace_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_tenant UUID;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO v_workspace_tenant
  FROM public.workspaces
  WHERE id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace % does not exist', NEW.workspace_id;
  END IF;

  IF v_workspace_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'properties.workspace_id (%) belongs to tenant (%), but property belongs to tenant (%). '
      'Cross-tenant workspace references are not allowed.',
      NEW.workspace_id, v_workspace_tenant, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_property_workspace_consistency ON public.properties;

CREATE TRIGGER trg_property_workspace_consistency
  BEFORE INSERT OR UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.check_property_workspace_consistency();


-- ============================================================
-- FUNCTION 3: check_whatsapp_account_workspace_consistency()
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_whatsapp_account_workspace_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_tenant UUID;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO v_workspace_tenant
  FROM public.workspaces
  WHERE id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace % does not exist', NEW.workspace_id;
  END IF;

  IF v_workspace_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'whatsapp_accounts.workspace_id (%) belongs to tenant (%), but account belongs to tenant (%). '
      'Cross-tenant workspace references are not allowed.',
      NEW.workspace_id, v_workspace_tenant, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_whatsapp_account_workspace_consistency ON public.whatsapp_accounts;

CREATE TRIGGER trg_whatsapp_account_workspace_consistency
  BEFORE INSERT OR UPDATE ON public.whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION public.check_whatsapp_account_workspace_consistency();

COMMIT;

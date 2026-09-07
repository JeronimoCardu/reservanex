-- =============================================================================
-- Migration: 20260906000001_forms_engine
-- =============================================================================
--
-- Fase 3A — motor de formularios dinámicos + submissions.
--
-- Dos cosas:
--
--  1. tenants.vertical — hasta hoy NO existía ningún concepto de rubro en el
--     sistema (grep repo-wide de business_type/rubro/vertical: cero
--     coincidencias). El rubro estaba hard-codeado estructuralmente: el schema
--     ES el modelo inmobiliario y el prompt de la IA dice "Representás a la
--     inmobiliaria". Para poder resolver qué formularios ofrece un tenant hace
--     falta el discriminador explícito. Default 'real_estate' porque todos los
--     tenants actuales lo son.
--
--  2. form_submissions — lo que un formulario produce. NO es una reserva ni un
--     pedido: es la intención estructurada del cliente, todavía sin confirmar.
--     Fase 3B la confirmará por WhatsApp y recién ahí nacerá la operación real.
--     Ojo con el vocabulario: status='confirmed' acá significa "el cliente
--     confirmó los datos", NO "la reserva está confirmada".
--
-- Convenciones seguidas (auditadas contra migraciones recientes del repo):
--   · taxonomías como TEXT + CHECK idempotente, no enums de Postgres
--   · RLS habilitado en la misma migración que el CREATE TABLE
--   · policies con TO authenticated y auth_tenant_id()
--   · trigger set_updated_at
--   · la tabla se agrega a admin_purge_tenant() — omitir esto ya rompió el
--     purge dos veces en este repo

BEGIN;

-- ── 1. Vertical del tenant ───────────────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS vertical TEXT NOT NULL DEFAULT 'real_estate';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_vertical_check'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_vertical_check
      CHECK (vertical IN ('real_estate', 'food_service'));
  END IF;
END $$;

COMMENT ON COLUMN public.tenants.vertical IS
  'Fase 3A — rubro del tenant. Determina qué intents de formulario tiene '
  'disponibles (ver packages/validators/src/forms.ts, que es la fuente de '
  'verdad tipada: al ser TEXT+CHECK y no un enum de Postgres, NO aparece en '
  'Enums<> de packages/types). ''real_estate'' = inmobiliarias y particulares; '
  '''food_service'' = gastronomía. Default real_estate: todos los tenants '
  'existentes al momento de esta migración lo son.';

-- ── 2. form_submissions ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.form_submissions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- Referencia pública corta, apta para pegar en un WhatsApp. NO autentica a
  -- nadie y no es el identificador interno: sirve para correlacionar un
  -- mensaje entrante con esta fila (Fase 3B). UNIQUE global (no por tenant)
  -- justamente porque quien la reciba por WhatsApp todavía no sabe de qué
  -- tenant es.
  reference        TEXT NOT NULL,

  intent           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'submitted',
  source           TEXT NOT NULL DEFAULT 'public_site',

  -- Contexto que originó el formulario. publication_ref es el código público
  -- que VIO el visitante (properties.public_code, formato OF-XXXXXX);
  -- entity_id es el FK real ya resuelto. Se guardan los dos a propósito:
  -- public_code es nullable y solo único POR TENANT, así que no sirve como
  -- clave; y el visitante puede haber visto un código que después cambió.
  publication_ref  TEXT,
  entity_type      TEXT,
  entity_id        UUID,

  -- Se completa en Fase 3B, cuando el WhatsApp entrante permita atar la
  -- submission a un contacto real. En 3A el formulario es anónimo.
  contact_id       UUID REFERENCES public.contacts(id) ON DELETE SET NULL,

  -- Las respuestas. Van en jsonb y no en columnas: los campos dependen del
  -- intent, y una columna por campo obligaría a migrar el schema cada vez que
  -- se agrega un formulario.
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Anti doble-submit. UNIQUE por tenant: el cliente genera un UUID por
  -- instancia de formulario y lo reenvía si hace doble tap. Deduplicar por
  -- payload completo sería incorrecto — dos personas pueden mandar
  -- legítimamente los mismos datos.
  idempotency_key  UUID NOT NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_submissions_intent_check' AND conrelid = 'public.form_submissions'::regclass) THEN
    ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_intent_check
      CHECK (intent IN (
        'property_inquiry', 'property_visit', 'monthly_rental_inquiry', 'temporary_rental',
        'general_inquiry', 'table_reservation', 'food_order'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_submissions_status_check' AND conrelid = 'public.form_submissions'::regclass) THEN
    ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_status_check
      CHECK (status IN ('draft', 'submitted', 'confirmed', 'expired', 'cancelled'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_submissions_source_check' AND conrelid = 'public.form_submissions'::regclass) THEN
    ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_source_check
      CHECK (source IN ('public_site', 'ai_whatsapp', 'direct_link'));
  END IF;

  -- El formato del código queda garantizado en la DB, no solo en el generador,
  -- para que el regex que lo detecte en un WhatsApp (Fase 3B) no tenga que
  -- tolerar formas raras. Alfabeto sin O/0/I/1 — se va a leer y tipear a mano.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_submissions_reference_format_check' AND conrelid = 'public.form_submissions'::regclass) THEN
    ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_reference_format_check
      CHECK (reference ~ '^SUB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_submissions_entity_type_check' AND conrelid = 'public.form_submissions'::regclass) THEN
    ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_entity_type_check
      CHECK (entity_type IS NULL OR entity_type IN ('property'));
  END IF;
END $$;

-- reference es global y case-sensitive por constraint (siempre mayúsculas):
-- normalizamos al generar y al buscar, así que un índice plano alcanza y
-- evita el costo de uno funcional.
CREATE UNIQUE INDEX IF NOT EXISTS form_submissions_reference_key
  ON public.form_submissions (reference);

CREATE UNIQUE INDEX IF NOT EXISTS form_submissions_tenant_idempotency_key
  ON public.form_submissions (tenant_id, idempotency_key);

-- Listado del CRM (Fase 3B+): las submissions de un tenant, más recientes
-- primero. Es la única lectura no-puntual prevista.
CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant_created
  ON public.form_submissions (tenant_id, created_at DESC);

COMMENT ON TABLE public.form_submissions IS
  'Fase 3A — respuesta estructurada a un formulario dinámico. NO es una '
  'reserva ni un pedido: es la intención del cliente antes de confirmarse. '
  'Fase 3B la pasa a status=confirmed vía WhatsApp y recién entonces se crea '
  'la operación real (PENDING). ''confirmed'' acá NO significa reserva '
  'confirmada.';

COMMENT ON COLUMN public.form_submissions.reference IS
  'Código público corto (SUB-XXXXXX) para correlacionar un mensaje de '
  'WhatsApp con esta submission. NUNCA autentica ni autoriza: conocerlo no '
  'da acceso a los datos. El identificador interno real es id (UUID).';

COMMENT ON COLUMN public.form_submissions.publication_ref IS
  'properties.public_code (OF-XXXXXX) que vio el visitante. Solo referencia '
  'humana: public_code es nullable y único apenas POR TENANT, así que el FK '
  'real es entity_id.';

-- ── 3. RLS ───────────────────────────────────────────────────────────────────
-- Tabla legible por el tenant (el CRM va a listar submissions), escrita solo
-- por el servidor: el formulario público entra por un route handler con
-- service role, nunca con la sesión del visitante — un visitante anónimo no
-- tiene ni debe tener INSERT.

ALTER TABLE public.form_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_select_form_submissions ON public.form_submissions;
CREATE POLICY tenant_select_form_submissions
  ON public.form_submissions
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS tenant_update_form_submissions ON public.form_submissions;
CREATE POLICY tenant_update_form_submissions
  ON public.form_submissions
  FOR UPDATE
  TO authenticated
  USING      (tenant_id = public.auth_tenant_id())
  WITH CHECK (tenant_id = public.auth_tenant_id());

-- Sin policy de INSERT ni de DELETE a propósito: solo el service role crea y
-- borra submissions. Y sin policy alguna para anon — el visitante del sitio
-- público jamás toca esta tabla directamente.

DROP TRIGGER IF EXISTS trg_form_submissions_updated_at ON public.form_submissions;
CREATE TRIGGER trg_form_submissions_updated_at
  BEFORE UPDATE ON public.form_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 4. admin_purge_tenant: incluir la tabla nueva ───────────────────────────
-- Regenerada a partir de la definición vigente (20260831000002) con UN solo
-- DELETE agregado. Extraída programáticamente del original para no arrastrar
-- errores de transcripción en ~200 líneas.

CREATE OR REPLACE FUNCTION public.admin_purge_tenant(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb := '{}';
  v_n      int;
BEGIN
  PERFORM set_config('reservanex.skip_audit', 'true', true);

  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant % not found', p_tenant_id;
  END IF;

  DELETE FROM public.reservation_events WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('reservation_events', v_n);

  DELETE FROM public.conversation_reservation_drafts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('conversation_reservation_drafts', v_n);

  DELETE FROM public.property_availability_blocks WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_availability_blocks', v_n);

  DELETE FROM public.availability_blocks WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('availability_blocks', v_n);

  DELETE FROM public.unit_images
    WHERE unit_id IN (SELECT id FROM public.units WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('unit_images', v_n);

  DELETE FROM public.property_images
    WHERE property_id IN (SELECT id FROM public.properties WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_images', v_n);

  -- Moved here (was after `properties`) — property_videos.property_id →
  -- properties is ON DELETE CASCADE, so it must be counted before properties
  -- is deleted or the subquery below finds nothing left to match.
  DELETE FROM public.property_videos
    WHERE property_id IN (SELECT id FROM public.properties WHERE tenant_id = p_tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('property_videos', v_n);

  DELETE FROM public.documents WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('documents', v_n);

  DELETE FROM public.notifications WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('notifications', v_n);

  DELETE FROM public.notes WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('notes', v_n);

  DELETE FROM public.tasks WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tasks', v_n);

  DELETE FROM public.message_queue WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('message_queue', v_n);

  DELETE FROM public.ai_usage_log WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('ai_usage_log', v_n);

  -- Must precede messages/conversations/whatsapp_accounts — all three
  -- reference them with ON DELETE NO ACTION (the bug this migration's
  -- predecessor, 20260831000001, fixed).
  DELETE FROM public.messaging_outbox WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('messaging_outbox', v_n);

  DELETE FROM public.media_events WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('media_events', v_n);

  DELETE FROM public.inbound_rejections WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('inbound_rejections', v_n);

  DELETE FROM public.messages WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('messages', v_n);

  -- audit_logs se borra al FINAL, no aquí.

  DELETE FROM public.impersonation_sessions WHERE target_tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('impersonation_sessions', v_n);

  DELETE FROM public.reservations WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('reservations', v_n);

  DELETE FROM public.conversations WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('conversations', v_n);

  DELETE FROM public.monthly_rental_payments WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_payments', v_n);

  DELETE FROM public.monthly_rental_charges WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_charges', v_n);

  DELETE FROM public.monthly_rental_contracts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('monthly_rental_contracts', v_n);

  -- Fase 3A. Antes que contacts: form_submissions.contact_id apunta ahí.
  -- (El FK tenant_id es ON DELETE CASCADE, así que sin este DELETE las filas
  -- igual desaparecerían — pero no saldrían en el reporte, que es justamente
  -- lo que arregló 20260831000002.)
  DELETE FROM public.form_submissions WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('form_submissions', v_n);

  DELETE FROM public.contacts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('contacts', v_n);

  DELETE FROM public.units WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('units', v_n);

  DELETE FROM public.properties WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('properties', v_n);

  DELETE FROM public.whatsapp_accounts WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('whatsapp_accounts', v_n);

  DELETE FROM public.ai_settings WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('ai_settings', v_n);

  DELETE FROM public.workspaces WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('workspaces', v_n);

  DELETE FROM public.seller_clients WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('seller_clients', v_n);

  -- Moved here (was after `tenant_users`) — user_section_seen.user_id →
  -- tenant_users is ON DELETE CASCADE, so it must be counted before
  -- tenant_users is deleted or the row is already gone by the time we get here.
  DELETE FROM public.user_section_seen WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('user_section_seen', v_n);

  DELETE FROM public.tenant_users WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_users', v_n);

  -- These two only cascade from tenants directly (deleted at the very end of
  -- this function), so their position here was already correct.
  DELETE FROM public.tenant_setup_assignments WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_setup_assignments', v_n);

  DELETE FROM public.tenant_receipt_counters WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenant_receipt_counters', v_n);

  DELETE FROM public.audit_logs WHERE tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('audit_logs', v_n);

  DELETE FROM public.tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_result := v_result || jsonb_build_object('tenants', v_n);

  RETURN v_result;
END;
$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3B — confirmación de una submission por WhatsApp
-- ════════════════════════════════════════════════════════════════════════════
--
-- Dos columnas, ninguna tabla nueva.
--
-- 1. conversations.pending_submission_id
--
--    Qué submission está esperando un "sí" en ESTA conversación.
--
--    Auditamos si algo existente servía. No servía: conversations tiene
--    property_id/unit_id (contexto de propiedad, no de formulario),
--    lead_context jsonb (marketing) y last_message_* (denormalización del
--    último mensaje). Ninguna puede responder "¿qué formulario estoy
--    confirmando?".
--
--    La alternativa sin columna sería "buscar la última submission submitted
--    del contacto", y es incorrecta: un contacto puede tener varias abiertas
--    (§9 del spec) y un "sí" confirmaría la equivocada.
--
--    FK real con ON DELETE SET NULL: si la submission se borra, la
--    conversación queda sin pendiente en vez de apuntar a un id fantasma.
--    Es un UUID tipado, no texto libre (§9).
--
-- 2. form_submissions.confirmed_at
--
--    §15 pide elegir y justificar. Elegimos agregarla.
--
--    updated_at NO alcanza: lo pisa el trigger set_updated_at en CUALQUIER
--    escritura — el binding de contact_id, una transición a expired, una
--    corrección desde el CRM. Después de cualquiera de esas, updated_at ya
--    no dice "cuándo confirmó el cliente", dice "cuándo se tocó la fila".
--    Fase 3C va a crear la operación a partir de una submission confirmada y
--    necesita el instante real del consentimiento del cliente, no el de la
--    última escritura. Son dos hechos distintos y merecen dos columnas.
--
--    Nullable: solo se completa al pasar a confirmed.
--
-- NO se agrega ninguna tabla, así que admin_purge_tenant() no cambia. La FK
-- nueva es ON DELETE SET NULL, así que el purge puede seguir borrando
-- form_submissions antes que conversations sin violar nada.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS pending_submission_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_pending_submission_id_fkey'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_pending_submission_id_fkey
      FOREIGN KEY (pending_submission_id)
      REFERENCES public.form_submissions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.conversations.pending_submission_id IS
  'Fase 3B: la submission que está esperando confirmación del cliente en esta '
  'conversación. La setea el worker cuando el cliente manda una referencia '
  'SUB-XXXXXX válida; la limpia al confirmar o rechazar. Permite que un "sí" '
  'resuelva EXACTAMENTE qué formulario se confirma, en vez de adivinar cuál '
  'fue el último — un contacto puede tener varias submissions abiertas.';

COMMENT ON COLUMN public.form_submissions.confirmed_at IS
  'Fase 3B: instante en que el CLIENTE confirmó los datos por WhatsApp. '
  'Distinto de updated_at, que el trigger set_updated_at pisa en cualquier '
  'escritura (binding de contacto, expiración, edición desde el CRM). '
  'OJO con el vocabulario: esto es "el cliente dijo que los datos están bien", '
  'NO "la reserva está confirmada" — la operación la crea Fase 3C.';

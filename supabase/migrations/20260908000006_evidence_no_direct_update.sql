-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3C — sin UPDATE directo sobre evidencia (2ª brecha)
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── QUÉ QUEDABA ABIERTO ─────────────────────────────────────────────────────
--
-- La migración 20260908000005 protegió las columnas HISTÓRICAS (el payload,
-- la identidad, el contexto). Pero dejó a authenticated con UPDATE sobre:
--
--   form_submissions   → status, confirmed_at, contact_id, updated_at
--   operation_requests → status, decided_at, decided_by, decision_notes, updated_at
--
-- Esas columnas no son datos: son HECHOS sobre quién hizo qué.
--
--   status='confirmed' + confirmed_at  significa literalmente
--     "EL CLIENTE confirmó por WhatsApp que los datos eran correctos"
--
--   decided_by + decided_at            significa
--     "ESTA PERSONA tomó la decisión, en ESTE momento"
--
-- Poder escribirlas directo es poder FABRICAR esos hechos.
--
-- ── VERIFICADO EMPÍRICAMENTE (login real de owner, antes de esta migración) ─
--
--   B. submitted → confirmed .................. FABRICADO
--   B. confirmed_at: null → now() ............. FABRICADO
--   B. binding de contact_id a mano ........... FABRICADO
--   B. status → cancelled / expired ........... FABRICADO
--   E. decided_by → su propio uuid ............ FABRICADO
--   E. decision_notes ......................... FABRICADO
--   E. pending → rejected con decided_at+by ... FABRICADO
--
-- Un owner podía marcar como "confirmada por el cliente" una solicitud que el
-- cliente nunca confirmó, y podía dejar registrado que alguien tomó una
-- decisión que nunca tomó.
--
-- Detalle importante: cambiar status SOLO, o decided_at SOLO, sí daba error
-- (23514) — pero por el CHECK de coherencia operation_requests_decision_
-- coherence_check, no por seguridad. Cambiándolos JUNTOS pasaba limpio. Era
-- protección accidental, no una defensa.
--
-- ── REGLA QUE ESTABLECE ESTA MIGRACIÓN ──────────────────────────────────────
--
--   authenticated (owner/receptionist)  → SELECT sí. UPDATE directo: NO.
--   super admin impersonando            → SELECT sí. UPDATE directo: NO.
--   service_role / RPC interna          → sin cambios: sigue haciendo el
--                                         binding, la confirmación y la
--                                         creación de la operación.
--
-- No se abre UPDATE "por si después lo usamos": cuando exista la fase de
-- aprobación humana, tendrá su propia RPC.
--
-- ── VERIFICACIÓN PREVIA DE IMPACTO ──────────────────────────────────────────
--
-- Se revisó todo apps/web antes de aplicar esto. Los únicos accesos a estas
-- tablas son:
--   · lib/forms/submissions.repository.ts — INSERT con createAdminClient
--     (service role), no afectado por los grants de authenticated;
--   · lib/repositories/operation-requests.repository.ts — solo SELECT.
-- Ningún UPDATE con el cliente autenticado. Esta migración no rompe la app.
--
-- Los triggers de inmutabilidad de 20260908000005 se MANTIENEN: son la defensa
-- que aplica también al service role.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Fuera las policies de UPDATE ─────────────────────────────────────────
-- Sin policy de UPDATE, RLS niega el UPDATE a authenticated aunque tuviera el
-- grant. Es la capa de autorización.

DROP POLICY IF EXISTS tenant_update_form_submissions   ON public.form_submissions;
DROP POLICY IF EXISTS sa_imp_update_form_submissions   ON public.form_submissions;

DROP POLICY IF EXISTS tenant_update_operation_requests ON public.operation_requests;
DROP POLICY IF EXISTS sa_imp_update_operation_requests ON public.operation_requests;


-- ── 2. Fuera los grants de UPDATE ───────────────────────────────────────────
-- Capa de privilegios: el intento falla antes de que RLS se evalúe siquiera.
-- Se revoca por tabla, lo que también limpia los grants por columna que dejó
-- la migración anterior.

REVOKE UPDATE ON public.form_submissions   FROM authenticated;
REVOKE UPDATE ON public.form_submissions   FROM anon;
REVOKE UPDATE ON public.operation_requests FROM authenticated;
REVOKE UPDATE ON public.operation_requests FROM anon;

-- INSERT/DELETE tampoco: ninguna de las dos tablas tiene policy para eso, pero
-- el grant no debe quedar esperando a que alguien agregue una por error.
REVOKE INSERT, DELETE ON public.form_submissions   FROM authenticated;
REVOKE INSERT, DELETE ON public.operation_requests FROM authenticated;
REVOKE INSERT, DELETE ON public.form_submissions   FROM anon;
REVOKE INSERT, DELETE ON public.operation_requests FROM anon;


-- ── 3. Documentar el camino futuro ──────────────────────────────────────────

COMMENT ON TABLE public.operation_requests IS
  'Fase 3C: un pedido del cliente, nacido de una form_submission confirmada, '
  'esperando que la empresa lo apruebe o lo rechace. status=pending NO es una '
  'reserva ni un pedido aceptado. NO afecta disponibilidad. '
  'ESCRITURA: solo service role / RPC. authenticated tiene SELECT y nada más — '
  'ni siquiera sobre status, porque decided_by/decided_at son hechos sobre '
  'quién decidió y no deben poder fabricarse con un UPDATE directo. '
  'PENDIENTE (fase de aprobación humana): una RPC específica para '
  'pending → confirmed/rejected/cancelled que debe autenticar al usuario, '
  'validar tenant, validar la transición, tomar decided_by de auth.uid() (NUNCA '
  'del payload), estampar decided_at con now() server-side, escribir audit_log '
  'y ser idempotente/concurrent-safe.';

COMMENT ON COLUMN public.operation_requests.decided_by IS
  'Fase 3C: quién tomó la decisión. Lo escribirá la RPC de aprobación futura a '
  'partir de auth.uid(), nunca de un valor enviado por el cliente. Hoy ningún '
  'rol authenticated puede escribirlo.';

COMMENT ON COLUMN public.form_submissions.confirmed_at IS
  'Fase 3B: instante en que el CLIENTE confirmó los datos por WhatsApp. '
  'Distinto de updated_at, que el trigger set_updated_at pisa en cualquier '
  'escritura. Solo lo escribe confirm_submission_and_create_operation() con el '
  'service role: un owner no puede fabricar la confirmación del cliente. '
  'OJO con el vocabulario: es "el cliente dijo que los datos están bien", NO '
  '"la reserva está confirmada".';

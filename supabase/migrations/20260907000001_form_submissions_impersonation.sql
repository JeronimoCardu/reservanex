-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3A.1 — policy de impersonación para public.form_submissions
-- ════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO
--
-- La auditoría de Fase 3A detectó que form_submissions era la única tabla de
-- negocio tenant-scoped SIN policy de impersonación. 23 tablas la tienen; de
-- las 7 que no, las otras 6 son casos donde la omisión es correcta a propósito
-- (audit_logs e impersonation_sessions no deben ser legibles impersonando —
-- sería poder borrar las propias huellas; tenants y message_queue son
-- infraestructura). form_submissions NO es uno de esos casos: es dato de
-- negocio del tenant, igual que documents o reservations, y un super admin
-- haciendo soporte ("¿por qué no le llegó esta consulta?") necesita verlo.
--
-- PATRÓN REUTILIZADO
--
-- El del resto del producto, verificado en pg_policies contra el proyecto:
--
--   sa_imp_all_documents / sa_imp_all_reservations / sa_imp_all_properties /
--   sa_imp_all_contacts
--     FOR ALL TO authenticated
--     USING      (is_super_admin() AND tenant_id = auth_impersonating_tenant_id())
--     WITH CHECK (is_super_admin() AND tenant_id = auth_impersonating_tenant_id())
--
-- La condición se reutiliza EXACTAMENTE. is_super_admin() lee el JWT
-- (user_type=platform_user + role=super_admin) y auth_impersonating_tenant_id()
-- lee impersonation_sessions en la DB — o sea que sin una sesión de
-- impersonación ACTIVA devuelve NULL y la comparación nunca da true.
--
-- DESVIACIÓN DELIBERADA: FOR ALL → SELECT + UPDATE
--
-- Las tablas de arriba usan FOR ALL porque sus usuarios de tenant también
-- pueden INSERT y DELETE. form_submissions NO: sus únicas policies son
-- tenant_select_form_submissions y tenant_update_form_submissions. Nadie
-- inserta ni borra por RLS — solo el service role, desde el endpoint público.
-- Eso es una garantía de integridad: una submission es el registro de lo que
-- un cliente realmente envió, y no queremos que se pueda fabricar ni destruir.
--
-- Copiar FOR ALL acá le daría al super admin impersonando MÁS poder que al
-- dueño del tenant, que es exactamente la ampliación de permisos que hay que
-- evitar. Así que la impersonación espeja las policies de ESTA tabla
-- (SELECT + UPDATE) en vez del FOR ALL de las otras. El service role sigue
-- pasando por encima de RLS como siempre.
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS sa_imp_select_form_submissions ON public.form_submissions;
CREATE POLICY sa_imp_select_form_submissions
  ON public.form_submissions
  FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    AND tenant_id = public.auth_impersonating_tenant_id()
  );

DROP POLICY IF EXISTS sa_imp_update_form_submissions ON public.form_submissions;
CREATE POLICY sa_imp_update_form_submissions
  ON public.form_submissions
  FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin()
    AND tenant_id = public.auth_impersonating_tenant_id()
  )
  WITH CHECK (
    public.is_super_admin()
    AND tenant_id = public.auth_impersonating_tenant_id()
  );

COMMENT ON POLICY sa_imp_select_form_submissions ON public.form_submissions IS
  'Fase 3A.1: super admin con sesión de impersonación ACTIVA (impersonation_sessions '
  'con ended_at IS NULL) lee las submissions del tenant impersonado, y solo de ese. '
  'Sin sesión activa auth_impersonating_tenant_id() es NULL y la policy nunca aplica.';

COMMENT ON POLICY sa_imp_update_form_submissions ON public.form_submissions IS
  'Fase 3A.1: idem SELECT, para cambiar el status durante soporte. Deliberadamente '
  'NO es FOR ALL como en documents/reservations: form_submissions no permite INSERT '
  'ni DELETE por RLS a nadie, y la impersonación no debe superar los permisos que '
  'tiene el propio dueño del tenant.';

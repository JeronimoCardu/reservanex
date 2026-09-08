-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3D — mínimo privilegio sobre decide_operation_request
-- ════════════════════════════════════════════════════════════════════════════
--
-- La migración 20260909000001 revocó de PUBLIC y de anon, y otorgó a
-- authenticated. Verificando los grants REALES después de aplicarla (§17 pide
-- comprobar empíricamente, no confiar en el texto de la migración), quedó:
--
--   authenticated  EXECUTE   ← correcto, es quien decide desde el CRM
--   postgres       EXECUTE   ← owner
--   service_role   EXECUTE   ← NO buscado
--   anon           —         ← correcto
--
-- service_role lo otorgan los ALTER DEFAULT PRIVILEGES de Supabase sobre las
-- funciones nuevas de public. Se comprobó qué hace: devuelve
-- {"outcome":"unauthenticated"}, porque auth.uid() es NULL para ese rol. O
-- sea que hoy es inerte.
--
-- Se revoca igual, por dos razones:
--
--   1. Es una función SECURITY DEFINER. El mínimo privilegio no es opcional
--      ahí: cualquier cambio futuro que agregue un camino sin auth.uid()
--      volvería vivo un grant que nadie recuerda haber dado.
--   2. El comentario de la migración anterior afirmaba que service_role no
--      estaba otorgado. Prefiero que la realidad coincida con lo documentado
--      antes que dejar una nota que miente.
--
-- Diferencia con confirm_submission_and_create_operation (Fase 3C), que SÍ
-- tiene service_role: a esa la llama el worker. A esta la llama únicamente un
-- usuario logueado del CRM.
-- ════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM service_role;

-- Se re-afirman los otros dos por si esta migración corre sobre un estado
-- distinto del esperado.
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.decide_operation_request(UUID, TEXT, TEXT) TO authenticated;

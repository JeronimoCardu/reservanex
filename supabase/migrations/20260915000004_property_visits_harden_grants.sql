-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3E-B2 — grants reales de property_visits
-- ════════════════════════════════════════════════════════════════════════════
--
-- La migración anterior habilitó RLS y creó SOLO políticas de SELECT: ninguna
-- de INSERT, UPDATE o DELETE. Pero verificar los grants reales —en vez de
-- inferirlos, como pide §20— mostró que anon y authenticated igual tenían
-- INSERT/UPDATE/DELETE a nivel TABLA:
--
--     anon:DELETE, anon:INSERT, anon:UPDATE,
--     authenticated:DELETE, authenticated:INSERT, authenticated:UPDATE
--
-- Es el mismo ALTER DEFAULT PRIVILEGES de Supabase que ya nos mordió con las
-- funciones en 3C y 3E-A.1: toda tabla nueva en `public` nace con permisos
-- amplios para esos roles.
--
-- Hoy RLS los frena (sin policy no hay fila que puedan tocar), así que no había
-- un agujero explotable. Pero apoyarse solo en eso significa que el día que
-- alguien agregue una policy de UPDATE "para otra cosa", el grant ya está
-- puesto y la superficie se abre sola. Defensa en profundidad: se revoca.
--
-- El precedente correcto del repo es operation_requests, que después de
-- 20260908000006 quedó solo con SELECT/REFERENCES/TRIGGER para esos roles.
-- (reservations todavía conserva los grants amplios — es del esquema base,
-- anterior a ese endurecimiento. No se toca acá: está fuera de esta fase.)
--
-- Qué queda:
--   · authenticated → SELECT. Las RLS lo acotan a su tenant.
--   · anon          → NADA. Una visita no es información pública.
--   · service_role  → intacto. No es el browser: es la llave de backend que
--                     usan el worker y los scripts de administración, y
--                     además saltea RLS por diseño.
--
-- Toda mutación sigue pasando por las RPC SECURITY DEFINER de esta fase.
-- ════════════════════════════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.property_visits FROM authenticated;
REVOKE ALL ON TABLE public.property_visits FROM anon;

GRANT SELECT ON TABLE public.property_visits TO authenticated;

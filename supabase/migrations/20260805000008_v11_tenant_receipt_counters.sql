-- =============================================================================
-- 20260805000008_v11_tenant_receipt_counters.sql
-- v1.1 — Contadores correlativos de recibos por tenant/año + función atómica.
--
-- Diseño:
--   La función next_receipt_number() usa INSERT ... ON CONFLICT DO UPDATE
--   con RETURNING counter. Esto es atómico: PostgreSQL garantiza que dos
--   transacciones concurrentes no obtienen el mismo contador porque la fila
--   queda bloqueada en modo SHARE/EXCLUSIVE durante el UPDATE.
--   No se usa COUNT(*)+1 (race condition) ni advisory locks (complejidad innecesaria).
--
-- Seguridad de la función:
--   SECURITY DEFINER: se ejecuta con los permisos del owner (service_role setup).
--   search_path = public, pg_temp: previene shadowing de tablas temporales.
--   REVOKE ALL FROM PUBLIC/anon/authenticated + GRANT EXECUTE a service_role:
--     solo el backend (createAdminClient) puede llamar esta función.
--
-- IDEMPOTENTE: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION
-- =============================================================================

BEGIN;

-- ── Tabla de contadores ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenant_receipt_counters (
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  year        INTEGER     NOT NULL,
  counter     INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, year),

  CONSTRAINT tenant_receipt_counters_year_valid CHECK (year >= 2020 AND year <= 2099),
  CONSTRAINT tenant_receipt_counters_counter_nonneg CHECK (counter >= 0)
);

-- ── Función atómica next_receipt_number() ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.next_receipt_number(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year    integer := date_part('year', now())::integer;
  v_counter integer;
BEGIN
  -- INSERT atómico: si ya existe la fila para este tenant+año, incrementa el
  -- contador en 1 y devuelve el nuevo valor. El UPDATE es atómico y bloqueante:
  -- dos llamadas concurrentes esperan una a la otra en lugar de duplicar valores.
  INSERT INTO public.tenant_receipt_counters (tenant_id, year, counter, updated_at)
  VALUES (p_tenant_id, v_year, 1, now())
  ON CONFLICT (tenant_id, year)
  DO UPDATE SET
    counter    = tenant_receipt_counters.counter + 1,
    updated_at = now()
  RETURNING counter INTO v_counter;

  -- Formato: REC-YYYY-NNNN (padding izquierdo con ceros hasta 4 dígitos)
  -- Ejemplo: REC-2026-0001, REC-2026-0042, REC-2026-1000
  RETURN 'REC-' || v_year::text || '-' || lpad(v_counter::text, 4, '0');
END;
$$;

-- ── Privilegios de la función ─────────────────────────────────────────────────

-- Bloquear acceso público heredado
REVOKE ALL ON FUNCTION public.next_receipt_number(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_receipt_number(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.next_receipt_number(uuid) FROM authenticated;

-- Solo el backend con service_role puede ejecutar esta función
GRANT EXECUTE ON FUNCTION public.next_receipt_number(uuid) TO service_role;

-- ── Privilegios de la tabla ───────────────────────────────────────────────────

-- tenant_receipt_counters no es accesible desde el cliente JWT.
-- service_role tiene acceso completo por defecto en Supabase.
REVOKE ALL ON public.tenant_receipt_counters FROM anon;
REVOKE ALL ON public.tenant_receipt_counters FROM authenticated;

COMMIT;

-- =============================================================================
-- 20260903000001_harden_public_property_access.sql
-- Fase 10 Paso 3 — closes the `properties.internal_address` leak (backlog
-- item T) plus the same class of gap on 4 neighboring tables discovered
-- while auditing the full anon-readable surface.
--
-- ROOT CAUSE (identical shape to the already-fixed `tenants` leak in
-- 20260901000002): RLS is row-level only, never column-level. Five tables
-- had an `anon_select_*` policy that correctly scoped WHICH ROWS an
-- unauthenticated caller could see (published/active business-availability
-- semantics — confirmed fine on their own) but placed no restriction on
-- WHICH COLUMNS of those rows were returned. `properties` mixes public
-- columns (title, description, cover_image_url, ...) with private ones on
-- the SAME row: `internal_address` (exact address, meant to stay hidden
-- unless the owner sets show_exact_address_public = true) and pricing
-- fields gated by `show_price_public`. A raw PostgREST call with only the
-- public anon key — no login, no app code involved — could read
-- `internal_address`/pricing for any published property regardless of
-- those toggles. Empirically confirmed against a real isolated fixture
-- before this migration was written.
--
-- FULL CALL-SITE AUDIT (see the Fase 10 Paso 3 report for detail): every
-- legitimate public-facing read of these 5 tables already goes through
-- apps/web/src/lib/repositories/public-site.repository.ts, which uses
-- createAdminClient() (service role, bypasses RLS) exclusively — the same
-- precondition that made dropping tenants.anon_select_active_tenants safe.
-- No browser/anon-key client anywhere in the app queries any of these 5
-- tables directly for public-site purposes (the one browser-client call
-- site touching `properties`, associate-property-dialog.tsx, only runs
-- inside the authenticated tenant dashboard and resolves as `authenticated`
-- via a real session, never `anon` — untouched by this migration).
--
-- FIX: per instruction, prefer revoking anon's direct table access over a
-- column-allowlist view, since anon doesn't need direct SQL access at all
-- here — the backend repository is the only legitimate consumer. Simpler
-- and more least-privilege than adding a `properties_public` view this
-- schema doesn't otherwise need. All 5 policies below were confirmed to
-- have exactly this "safe rows, unrestricted columns" shape — none had a
-- comparable "no private-column mixing" table like the earlier Fase 10
-- audit had assumed for `properties` (that assumption is what missed this).
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS anon_select_published_properties ON public.properties;
DROP POLICY IF EXISTS anon_select_property_images       ON public.property_images;
DROP POLICY IF EXISTS anon_select_unit_images            ON public.unit_images;
DROP POLICY IF EXISTS anon_select_units                  ON public.units;
DROP POLICY IF EXISTS anon_select_availability_blocks    ON public.availability_blocks;

COMMENT ON TABLE public.properties IS
  'Fase 10 Paso 3 security fix: removed anon_select_published_properties, a '
  'row-level policy that (because RLS cannot restrict columns) exposed '
  'internal_address and pricing fields to a fully unauthenticated caller '
  'regardless of show_exact_address_public/show_price_public. The public '
  'site reads this table exclusively via the service-role admin client '
  '(public-site.repository.ts), which applies its own column allowlist and '
  'now redacts price fields the same way it already redacted '
  'internal_address/google_maps_url — see listPublicProperties().';

COMMENT ON TABLE public.property_images IS
  'Fase 10 Paso 3: removed anon_select_property_images — unused by any '
  'anon-facing code path (public site reads images via the admin client). '
  'No private columns here (only image_url/alt/sort_order/is_cover), but '
  'removed for consistency with the least-privilege fix applied to '
  'properties/units/unit_images/availability_blocks.';

COMMENT ON TABLE public.unit_images IS
  'Fase 10 Paso 3: removed anon_select_unit_images — same reasoning as '
  'property_images.';

COMMENT ON TABLE public.units IS
  'Fase 10 Paso 3: removed anon_select_units — unused by any anon-facing '
  'code path (no current public-site feature reads monthly-rental units '
  'directly; confirmed via full call-site audit). No private columns on '
  'this table today, but removed to close the same class of surface as '
  'properties, and to avoid this becoming a silent exception if a private '
  'column is ever added here later.';

COMMENT ON TABLE public.availability_blocks IS
  'Fase 10 Paso 3: removed anon_select_availability_blocks — unused by any '
  'anon-facing code path (the public site''s availability calendar reads '
  'property_availability_blocks, a different table, via the admin client). '
  'Same reasoning as units.';

COMMIT;

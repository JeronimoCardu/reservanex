// Pure, DB-independent helpers for auto-provisioning a brand-new tenant's
// default public site slug and default workspace name (Fase 8). Kept
// separate/testable, same rationale as autoresponder-platform.ts.

// Mirrors the DB CHECK constraint `tenants_public_slug_format`
// (supabase/migrations/20260720000006_public_site.sql) — kept in sync
// manually since Postgres CHECK constraints aren't introspectable from
// here. If the internal `slug` (already unique, already format-checked by
// `tenants_slug_format`) happens to collide with one of these reserved
// words or fail the (stricter) public-slug format, createTenant() simply
// leaves `public_slug` unset rather than attempting an insert the DB would
// reject — see platform.repository.ts.
const RESERVED_PUBLIC_SLUGS = new Set([
  'dashboard', 'login', 'auth', 'api', 'admin', 'site',
  'platform', 'settings', 'properties', 'property',
])

export function isSafePublicSlug(slug: string): boolean {
  return (
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) &&
    slug.length >= 3 &&
    !RESERVED_PUBLIC_SLUGS.has(slug)
  )
}

// The single default workspace auto-created for every new tenant (Fase 8
// §6) — matches the `workspaces` table's own long-standing doc comment
// ("A 'General' workspace is auto-created on tenant onboarding"), which
// described intended behavior that no code actually implemented until now.
export const DEFAULT_WORKSPACE_NAME = 'General'

// Short, honest list of markets actually reachable today — NOT a claim that
// the product is localized/functional in all of them (see the Fase 8
// migration's column comments: language/timezone are captured metadata,
// not yet read by any date/currency/localization logic). Argentina stays
// the default (current real market) without being the only option.
export const SUPPORTED_COUNTRIES: { code: string; label: string; currency: string; timezone: string }[] = [
  { code: 'AR', label: 'Argentina', currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' },
  { code: 'UY', label: 'Uruguay',   currency: 'UYU', timezone: 'America/Montevideo' },
  { code: 'CL', label: 'Chile',     currency: 'CLP', timezone: 'America/Santiago' },
  { code: 'MX', label: 'México',    currency: 'MXN', timezone: 'America/Mexico_City' },
  { code: 'CO', label: 'Colombia',  currency: 'COP', timezone: 'America/Bogota' },
]

export const DEFAULT_COUNTRY_CODE = 'AR'

export function defaultsForCountry(countryCode: string): { currency: string; timezone: string } {
  const match = SUPPORTED_COUNTRIES.find((c) => c.code === countryCode)
  const fallback = SUPPORTED_COUNTRIES[0]!
  return { currency: match?.currency ?? fallback.currency, timezone: match?.timezone ?? fallback.timezone }
}

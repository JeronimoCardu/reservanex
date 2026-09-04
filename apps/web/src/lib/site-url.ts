// Single source of truth for this app's own absolute origin — used to build
// every Supabase Auth redirect URL (invite/recovery links) and anywhere else
// that needs a same-origin absolute link. Previously duplicated inline in
// three places in actions/platform.ts (each silently falling back to an
// empty string when unset — producing a relative redirectTo like
// "/api/auth/callback" that Supabase Auth cannot use as an absolute URL)
// plus a fourth, correct, throw-on-missing copy in
// repositories/users.repository.ts. This consolidates all four on that
// correct behavior: fail loudly at send time rather than silently emailing
// a broken link.
//
//   Development: NEXT_PUBLIC_SITE_URL=http://localhost:3001
//   Production:  NEXT_PUBLIC_SITE_URL=https://reservanex.com
//
// Never hardcode either value — this is the only place that reads the env var.
export function getSiteUrl(): string {
  const url = process.env.NEXT_PUBLIC_SITE_URL
  if (!url) {
    throw new Error(
      '[site-url] NEXT_PUBLIC_SITE_URL no está configurada — los links de invitación/recuperación no van a funcionar. ' +
      'Development: http://localhost:3001 · Production: https://reservanex.com',
    )
  }
  return url.replace(/\/+$/, '')
}

// The single redirect target used for every Supabase Auth email flow
// (invite, recovery, magic link) — apps/web/src/app/(auth)/auth/confirm/route.ts,
// which verifies the token_hash directly server-side (verifyOtp). Points at
// /auth/confirm, NOT /api/auth/callback (PKCE code-exchange) — this app has
// no OAuth provider, so the PKCE route was dead weight that silently mixed
// two incompatible strategies: Supabase's default "Invite" email template
// (unless customized) sends the user through /auth/v1/verify first, which
// then redirects here with either an implicit-flow #fragment (invisible to
// any server route, ours included) or, for the token_hash strategy this app
// has standardized on, ?token_hash=&type= params that /auth/confirm reads
// directly. The Dashboard "Invite"/"Reset Password"/"Magic Link" email
// templates must construct their link as
// "{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite" (or
// type=recovery / type=magiclink respectively) — {{ .RedirectTo }} reflects
// exactly the value returned by this function, so it resolves correctly for
// both http://localhost:3001 in dev and https://reservanex.com in
// production without any per-environment Dashboard change. See the Fase 8
// "invite flow" report for the manual Dashboard steps this still requires.
export function getAuthRedirectTo(): string {
  return `${getSiteUrl()}/auth/confirm`
}

# Production security checklist

Follow this before putting a real tenant on ReservaNex in production. Written
from the Fase 10 security audit — every item here maps to a specific,
verified finding, not a generic best-practices list. **No real values in
this file — placeholders only.**

## 1. Database (Supabase — `akvaswvkdqfguksinrwa` only)

- [x] `supabase/migrations/20260901000002_security_hardening_fase10.sql` reviewed and pushed (Fase 10 Paso 2 — also picked up a second CRITICAL finding during the preflight itself: `tenants.anon_select_active_tenants`, a row-level policy that let an unauthenticated caller read every tenant's `payment_cbu`/`payment_alias`/`primary_owner_email` and other private columns — dropped in the same migration, see its inline comment)
- [x] `supabase db advisors --linked --type security --level warn` shows zero unexpected findings post-push — only the "Leaked Password Protection" item below (§5) and `extension_in_public` for `btree_gist` (§11) remain
- [x] `pnpm --filter @orderflow/web validate:security` passes fully — 16/16, including real cross-tenant regression tests with two isolated tenants and real authenticated owner sessions (not anon-only)
- [x] `supabase migration list --linked` shows every row Local = Remote (108/108, confirmed Fase 10 Paso 2)
- [x] Confirm `veqkuriobordivdxvuhj` (the original ReservaNex project) was never targeted by anything in this checklist

## 2. Secrets rotated

See `docs/secret-rotation-runbook.md` for the exact procedure for each of these. Do this **after** code/infra changes are live, in the order the runbook specifies.

- [ ] Supabase service-role key (if it was ever visible in a terminal, screen share, or shared with anyone during development)
- [ ] DeepSeek API key
- [ ] Groq API key
- [ ] Resend API key / Custom SMTP credentials
- [ ] Pilot tenant's AutoResponder device token
- [ ] Pilot tenant's MacroDroid webhook URL

## 3. Custom SMTP

- [ ] Custom SMTP configured in Supabase Auth (Dashboard → Authentication → Email Templates / SMTP Settings) — required for a ReservaNex-branded "From" address, not just template content
- [ ] Domain SPF/DKIM/DMARC verified for the sending domain
- [ ] Redirect URL allowlist in Supabase Auth includes the real production URL (see §4) and does **not** still contain a dev/tunnel URL

## 4. URLs

- [ ] `NEXT_PUBLIC_SITE_URL` set to the real production domain (`https://reservanex.com` or equivalent) — browser-facing, used for Supabase Auth email links
- [ ] `AUTORESPONDER_PUBLIC_BASE_URL` set to the real production domain — Android-facing, used to generate the 4 webhook endpoints in the `/platform` install guide. Confirm it is **not** a dev tunnel URL.
- [ ] Both of the above use HTTPS
- [ ] Domain has a valid HTTPS certificate
- [ ] **Supabase Auth Redirect URL allowlist** (Dashboard → Authentication → URL Configuration → Redirect URLs) contains exactly these, confirmed by tracing every real `redirectTo` call in the codebase (`apps/web/src/lib/site-url.ts`'s `getAuthRedirectTo()` is the *only* function that ever constructs one — every invite/recovery/magic-link flow funnels through it):
  - Dev: `http://localhost:3001/auth/confirm`
  - Prod: `https://reservanex.com/auth/confirm` (or the real production domain)
  - Remove any other entry, especially wildcards (`**`) or old tunnel/staging URLs — `apps/web/src/app/api/auth/callback/route.ts` (PKCE code-exchange) is dead code today (kept only for a possible future OAuth provider) and does **not** need an allowlist entry unless/until an OAuth provider is actually wired up

## 5. Supabase project configuration

- [ ] Confirm the app points at `akvaswvkdqfguksinrwa` (or its intended production successor, if the project is ever migrated) and never at `veqkuriobordivdxvuhj`
- [ ] Enable "Leaked Password Protection" (Dashboard → Authentication → Policies, or the current dashboard's equivalent Auth/password-security section — exact menu wording may have moved; see https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). **Confirmed via the real Supabase security advisor (Fase 10 Paso 2, `auth_leaked_password_protection`, WARN) that this feature is available for this project and is currently disabled** — not assumed, empirically checked. Dashboard-only setting, cannot be set via migration or CLI.
- [ ] Review the Redirect URL allowlist against the exact list in §4 — remove any leftover dev/tunnel/wildcard entries

## 6. Row Level Security

- [ ] Re-run `supabase db advisors --linked --type security` before every future schema change that touches a tenant-scoped table — this is exactly how the Fase 10 `conversation_reservation_drafts` gap was found (RLS was silently never enabled on a real table for an unknown period of time)
- [ ] Any NEW tenant-scoped table added after this checklist was written must explicitly decide: RLS + tenant policies (browser-accessible), or RLS + zero policies (service-role only) — never left unset

## 7. Storage

- [ ] Confirm bucket visibility matches intent: `property-images`/`tenant-public-assets` public (by design), `property-videos`/`reservation-docs`/`whatsapp-media` private
- [ ] Confirm no new bucket was added without an equivalent `storage.objects` RLS policy (tenant-path-scoped, matching the existing `(storage.foldername(name))[1] = auth_tenant_id()` pattern)

## 8. Logs

- [ ] Confirm production logging does not retain raw device tokens, full MacroDroid URLs, service-role keys, API keys, `token_hash`, `action_link`, or full auth tokens — verified during Fase 10 that no current log statement does this; re-verify after any new webhook/route is added
- [ ] Decide the production retention policy for logs containing phone numbers/message content/email — these are NOT stripped from dev logs today (needed for debugging); decide whether production should sanitize these differently before enabling long-term log retention/aggregation

## 9. Reset / purge policy

- [ ] Decide whether `RESET RESERVANEX` should be fully disabled, or gated behind an explicit environment flag, in production. **Confirmed via full source trace (Fase 10 Paso 2, `apps/web/src/actions/platform-danger.ts`'s `resetQaDataExceptSuperAdminAction`) that this is a GLOBAL reset, not tenant-scoped**: it selects every row in `public.tenants` with no filter and purges each one (DB + Storage), deletes every `platform_users` row with `role='seller'` except the current session's own super admin, and clears every tenant-null `audit_logs`/`impersonation_sessions` row. Authorization is real and server-side (`requireSuperAdmin()` reads JWT claims, not client-supplied data) and the UI requires typing the exact confirmation string `RESET RESERVANEX` — but there is **no environment/production check anywhere** in the action or the UI. **Not implemented yet** — see the Fase 10 report for the proposed mechanism (an env var like `ALLOW_GLOBAL_TENANT_RESET` that must be explicitly set) and confirm the exact approach before it's built.
- [ ] Per-tenant hard-delete (`hardDeleteTenantBySuperAdminAction`) is unaffected by the above — it is already tenant-scoped and confirmation-gated; no change proposed to it.

## 10. Dangerous dev scripts

- [ ] `cleanup-auth-users.ts` and `generate-invite-link.ts` now both call `assertSafeSupabaseTarget()` (Fase 10 fix) — confirm this stays true for any NEW script added later that touches the service-role client
- [ ] Never run `cleanup-auth-users.ts` against a tenant with real users, ever, for any reason
- [ ] Confirm no dangerous script is ever wired into a scheduled job, CI pipeline, or anything that could run unattended in production

## 11. Known, deliberately-accepted gaps (see `docs/backlog.md`)

- [ ] `btree_gist` extension lives in the `public` schema instead of a dedicated `extensions` schema (Supabase advisor WARN) — not moved in Fase 10; moving it requires re-verifying every exclusion-constraint usage across the schema first. Low risk, not a blocker.
- [ ] Residual `pnpm audit` findings, all confirmed dev-tooling-only or unfixable-from-this-repo (Fase 10 Paso 2 closed the `packages/supabase → next@15.5.19` transitive path via a `pnpm-workspace.yaml` override — `sharp`/`next` CVEs are fully resolved now): `postcss@8.4.31` bundled *inside* `next` itself (upstream-controlled), plus `brace-expansion`/`js-yaml`/`browserslist` — all exclusively inside the ESLint/`@typescript-eslint`/`autoprefixer` build-and-lint toolchain, never shipped to production. See `docs/backlog.md` item R for the full per-package breakdown.
- [ ] No full Content-Security-Policy — only 4 uncontroversial headers were added (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`). A real CSP needs its own characterization pass (inline scripts, Supabase/font origins, etc.) before being added — staged rollout recommended, not a blind `default-src 'self'`.
- [ ] No rate limiting on the 4 AutoResponder webhooks — auth (device token) already gates all four; a real rate-limit layer (e.g. Upstash/Vercel Edge Config) is a reasonable post-pilot addition once real traffic patterns are known, not implemented now to avoid guessing wrong limits that break legitimate heartbeat/inbound traffic.
- [ ] `claim_ai_auto_reply_slot` and the other ~30 SECURITY DEFINER "helper" functions flagged by the advisor (`is_tenant_user`, `auth_tenant_id`, etc.) were individually reviewed — the RLS-policy helpers are self-referential (return only the caller's own JWT-derived claims) and must keep their current grants (revoking would break every tenant-scoped RLS policy); the genuine trigger functions are safe to leave as-is (Postgres rejects a direct RPC call to a trigger function outside trigger context). Only `claim_ai_auto_reply_slot` needed an actual grant fix — see the migration.

## 12. Backups

- [ ] Confirm Supabase's automatic backup/PITR (point-in-time recovery) plan tier for the production project — this was **audited, not configured**, in Fase 10 (changing a Supabase plan is a manual Dashboard/billing action). See the Fase 10 report §37 for the exact manual verification steps.
- [ ] Confirm Storage has no separate backup mechanism beyond Supabase's own durability guarantees — `admin_purge_tenant()` and Storage deletion are **irreversible**; there is no "undo."

## 13. Android / test accounts

- [ ] Confirm no test/demo tenant (`demo-autoresponder` or any `test-*` fixture) exists in the production project — these are meant to be created fresh and cleaned up by their own validate scripts; verify none leaked through
- [ ] Confirm the pilot tenant's Android device token and MacroDroid URL are the ROTATED (post-launch) values, not the ones used during development (see §2)

# Hostinger — apps/web deploy

How `apps/web` runs on Hostinger Business as a Node.js app. The worker stays on Render
(`render.yaml`) and Supabase is unchanged. Everything below was validated end to end on a
staging app against the LAB project (October 2026, Next 15.5.28) before it reached `main`.
**No real values in this file — placeholders only.**

## hPanel application settings

| Setting          | Value                                                  |
| ---------------- | ------------------------------------------------------ |
| Application type | Other                                                  |
| Node.js          | 22                                                     |
| Package manager  | pnpm (the repo pins `pnpm@9.15.4` in `packageManager`) |
| Root directory   | `./` (monorepo root)                                   |
| Build command    | `pnpm run build`                                       |
| Output directory | `apps/web/.next/standalone`                            |
| Entry file       | `server.js`                                            |

## Environment variables

- `HOSTINGER_BUILD=1` switches the root build to the Hostinger path below. Set it only in
  Hostinger: everywhere else `pnpm run build` stays `turbo run build`.
- The rest are the variables the app already reads in production: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `AUTORESPONDER_PUBLIC_BASE_URL`, `WORKER_INTERNAL_URL`, `WORKER_INTERNAL_SECRET`, `CRON_SECRET`,
  `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and the optional marketing/contact ones.
- `ALLOW_GLOBAL_TENANT_RESET` must stay unset in production: `true` enables the global tenant
  reset (see `production-security-checklist.md`). `WHATSAPP_SKIP_SIGNATURE_VALIDATION` is ignored
  when `NODE_ENV=production`, which the standalone server always sets.
- `NEXT_PUBLIC_*` values are inlined at build time: changing one needs a redeploy.
- `VERCEL` and `VERCEL_URL` do not exist on Hostinger, so `NEXT_PUBLIC_SITE_URL` must be set
  explicitly.

## How the build works

`pnpm run build` runs `scripts/build.mjs`:

- without `HOSTINGER_BUILD`: `turbo run build` for the whole monorepo, unchanged;
- with `HOSTINGER_BUILD=1`: `scripts/hostinger-web-build.mjs`, which builds only `apps/web`.

The Hostinger path exists because of what the staging app showed:

- Hostinger runs nested `pnpm` calls (including the ones turbo makes per package) with its own
  global pnpm, which rejects `packageManager: pnpm@9.15.4`. The script never launches pnpm: it
  runs Next with the current Node.
- Hostinger's install does not create `apps/web/node_modules/next`. The script finds Next with
  Node's module resolution from `apps/web`, whatever the layout.
- Hostinger needs a standalone server. `next.config.ts` sets `output: 'standalone'` only when
  `HOSTINGER_BUILD=1`.
- Hostinger publishes the output directory as the app and starts its root `server.js`. The
  script copies `.next/static` and `public` next to the generated server and writes a root
  `server.js` that only requires it. `node_modules` stays exactly as Next traced it, and `.env`
  files are never copied.

```
apps/web/.next/standalone/          output directory
├── server.js                       entry file: require('./apps/web/server.js')
├── package.json
├── node_modules/                   traced by Next
├── packages/
└── apps/web/
    ├── server.js                   Next's standalone server
    ├── public/
    └── .next/static/
```

To try the Hostinger path locally: `HOSTINGER_BUILD=1 pnpm run build`. On Windows, Next's
standalone copy needs permission to create symlinks (Developer Mode); without it the build ends
with `EPERM ... symlink`. The normal build does not use standalone and is not affected.

## Cron (replaces `apps/web/vercel.json` at cutover)

`/api/cron/human-attention-reminders` must be called every 10 minutes with
`Authorization: Bearer <CRON_SECRET>`, as Vercel Cron does today. Hostinger's guide for Node.js
websites recommends a cron job that calls a protected route with `curl`, with these limits: one
command per job, at most 255 characters, no `%`, redirections and other special characters only
inside a `.sh` script, schedule in UTC, a job is stopped after 30 minutes. Cron jobs do not get
the app's environment variables; they live in
`/home/<user>/domains/<domain>/hbuilds/config/.env`.

1. Create the script with File Manager, outside the site folders, for example
   `/home/u123456789/cron/reservanex-human-attention.sh`:

   ```sh
   #!/bin/sh
   # Calls the human-attention reminders endpoint. CRON_SECRET is read from the app's own
   # environment file, so it is never written in hPanel or in this script.
   set -eu
   DOMAIN=example.com
   ENV_FILE=/home/u123456789/domains/$DOMAIN/hbuilds/config/.env
   SECRET=$(sed -n 's/^CRON_SECRET=//p' "$ENV_FILE" | head -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
   [ -n "$SECRET" ] || { echo "CRON_SECRET not found in $ENV_FILE" >&2; exit 1; }
   printf 'Authorization: Bearer %s\n' "$SECRET" |
     curl -fsS --max-time 120 -H @- -o /dev/null "https://$DOMAIN/api/cron/human-attention-reminders"
   ```

2. hPanel → Cron Jobs → **Custom**, command
   `/bin/sh /home/u123456789/cron/reservanex-human-attention.sh`, schedule `*/10 * * * *`.
3. Before scheduling, run the script once over SSH and check its exit code. The endpoint
   answers 503 `cron_not_configured` when `CRON_SECRET` is missing in the app and 401 when the
   header does not match. `curl -H @-` (headers from stdin, so the secret is not a command-line
   argument) needs curl 7.55 or newer. Hostinger discards cron output; redirect it to a log file
   inside the script if needed.

At cutover, once this cron runs, delete `apps/web/vercel.json` and move the schedule assertion
in `apps/web/src/lib/human-attention/attention-surface.test.ts` and the route comment to this
definition.

## CDN (accepted behaviour for the MVP)

- Hostinger's CDN caches the pages Next prerenders as static (`/`, `/[locale]`, `/login`,
  `/auth/accept-invite`, `/auth/reset-password`, icons, `robots.txt`, `sitemap.xml`): Next sends
  them with `s-maxage=31536000`, and a cached hit never reaches Next, so the middleware does not
  run for it.
- A signed-in user who opens a cached `/login` sees the form instead of being sent to the
  dashboard. Accepted.
- Private routes (`/dashboard/**`, `/platform/**`) are dynamic (`private, no-cache, no-store`)
  and are never cached.
- No cookie leak: a static page answered with a refreshed session `Set-Cookie` was not cached,
  and anonymous visitors did not receive that cookie.
- The CDN is purged on every deploy: the new HTML is served right away and the previous build's
  chunks return 404.

Revisit only if a security issue shows up.

## Runtime behaviour measured on staging

- One Node process serves every request. It was not recycled during 15 minutes of continuous
  traffic and stayed up 35 hours with no traffic of ours: no idle shutdown was observed.
- Cold start, only after a deploy or restart: 1 to 4 s on the first dynamic request. Static
  pages are served by the CDN meanwhile.
- Requests of 10, 20, 25 and 30 s complete; no proxy timeout up to 30 s.
- Server Actions work behind the CDN (same-origin calls pass, a foreign `Origin` is rejected),
  including a 1.8 MB image upload; `next/image` serves AVIF/WebP through sharp.
- Route handlers receive `request.url` as `https://0.0.0.0:3000/…` (measured on production): the
  standalone server builds it from its own bind address (`HOSTNAME`, `PORT`), not from the public
  host. Middleware redirects are unaffected because Next makes their `Location` relative, but a
  route handler's response goes out as is. Same-site redirects from a route handler use
  `localRedirect()` (`apps/web/src/lib/http/local-redirect.ts`), which sends a relative
  `Location`; `local-redirect-surface.test.ts` fails if a route handler derives an origin from
  the request.

## Known gaps

- Rate limiting: `apps/web/src/lib/rate-limit/client-ip.ts` only trusts Vercel's
  `x-vercel-forwarded-for`, so on Hostinger every request resolves to `local`. Nothing on `main`
  calls it yet; wiring rate limiting in needs a client-IP contract for Hostinger's CDN first.

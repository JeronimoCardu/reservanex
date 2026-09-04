# ReservaNex — Marketing site

Public, informational website for ReservaNex. Independent Next.js app inside
the monorepo — it does **not** import from or depend on `apps/web`,
`apps/worker`, or Supabase. No login, no dashboard, no client portal: just
the landing page, a contact form, and legal pages, in Spanish, Portuguese
(Brazil) and English.

## Stack

- Next.js 15 (App Router) + TypeScript
- Tailwind CSS
- [next-intl](https://next-intl.dev) for i18n (`/es`, `/pt`, `/en`)
- react-hook-form + Zod for the contact form
- Resend (optional) for sending contact form emails

## Running locally

From the monorepo root (uses the shared `pnpm` workspace):

```bash
pnpm install
pnpm --filter @orderflow/marketing dev
```

The app runs on **port 3100** (see `package.json`) so it doesn't collide
with `apps/web` on 3000. Visit `http://localhost:3100` — it redirects to
`/es`.

## Configuration (env vars)

Copy `.env.example` to `.env.local` inside `apps/marketing/` and fill in
what you have. Everything is optional and degrades gracefully:

| Variable                           | Effect if unset                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_WHATSAPP_NUMBER`      | All "Chat on WhatsApp" buttons are hidden (not rendered as broken links).                                                                                                                                                                                                           |
| `NEXT_PUBLIC_CONTACT_EMAIL`        | The "email us" card in the contact section is hidden.                                                                                                                                                                                                                               |
| `NEXT_PUBLIC_STARTING_PRICE_USD`   | Pricing section shows "custom plans" copy instead of a number.                                                                                                                                                                                                                      |
| `NEXT_PUBLIC_SITE_URL`             | Falls back to Vercel's own deployment URL on Vercel, `http://localhost:3100` in local dev, or a placeholder domain otherwise. **Set this explicitly for the real production domain** — it drives canonical URLs, hreflang and sitemap. Trailing slashes are stripped automatically. |
| `RESEND_API_KEY` + `CONTACT_EMAIL` | If unset, form delivery falls back to `CONTACT_WEBHOOK_URL`.                                                                                                                                                                                                                        |
| `RESEND_FROM_EMAIL`                | Falls back to Resend's `onboarding@resend.dev` sandbox sender (works without a verified domain, but looks less trustworthy in the recipient's inbox).                                                                                                                               |
| `CONTACT_WEBHOOK_URL`              | If neither this nor Resend is set, the contact form shows a clear "not configured" error — it never fakes a success.                                                                                                                                                                |

### WhatsApp number format

`NEXT_PUBLIC_WHATSAPP_NUMBER` must be international format, **digits only**
(e.g. `5491112345678`, not `+54 9 11 1234-5678`). The prefilled message is
localized per language and built in `src/lib/whatsapp.ts`.

### Contact form delivery

The form posts to `src/app/api/contact/route.ts`, which rejects bodies over
~20KB, validates with the same Zod schema used client-side
(`src/lib/validation/contact-schema.ts`) plus a honeypot field, then tries,
in order:

1. **Resend**, if `RESEND_API_KEY` and `CONTACT_EMAIL` are both set. This is
   always tried first when configured — the webhook is a fallback for sites
   that haven't set up Resend at all, not a retry path if Resend fails.
2. **Webhook POST** to `CONTACT_WEBHOOK_URL`, only if Resend isn't configured.
3. Neither configured → returns a `503` with `reason: "not_configured"`,
   which the form surfaces as a real error message (never a fake "sent!").

The email (or webhook payload) includes name, company, country, WhatsApp,
email, approximate listing count, message, the locale the form was
submitted from, an ISO submission timestamp (set server-side, not from the
client), and the page URL it was submitted from. No confirmation email is
sent to the visitor.

### Pricing

Set `NEXT_PUBLIC_STARTING_PRICE_USD` (plain number, e.g. `49`) to show
"Plans starting at US$49/month" copy. Leave unset to show "custom plans"
copy instead. This is the single source of truth — the price is never
hardcoded elsewhere in the copy or components.

## Adding the real logo

The real ReservaNex logo (green/yellow swoosh) isn't in this repo yet.
Drop these exact files into `public/brand/` and the site switches over
automatically — no code changes needed (see
[`public/brand/README.md`](public/brand/README.md) for details):

- `reservanex-logo-horizontal.svg` — used everywhere `<Logo />` renders
  (header, footer, mobile menu).
- `reservanex-logo.svg` — icon-only mark, reserved for future use.
- `favicon.svg` — replaces the generated placeholder browser-tab icon.
- `og-image.png` (1200×630) — replaces the generated placeholder social
  preview image, for all three locales.

## Adding real product screenshots

The "product preview" section currently ships a fully custom, fictional
recreation of the CRM UI (no real data) instead of screenshots, because the
only screenshot available while building this site had a real client's
name/phone/email visible. Drop sanitized screenshots into `public/product/`
as `conversations.webp`, `properties.webp`, `reservations.webp`,
`team.webp` and each tab switches from the mockup to the real image
automatically. See [`public/product/README.md`](public/product/README.md).

## Adding the demo video

`src/components/sections/video-demo.tsx` currently renders a "coming soon"
state. The poster image is already wired up — drop
`public/product/video-poster.webp` in and it replaces the gradient
placeholder behind the play button automatically. Once you have the actual
video:

1. Host it somewhere (Vercel Blob, Mux, YouTube unlisted, etc.) and get a URL.
2. Replace the placeholder `<button>` block in that file with a real
   `<video>` or provider embed using that URL — the component is small
   and isolated on purpose.

Do not point it at a placeholder/fake video URL in the meantime — the
current "coming soon" state is intentional per product requirements.

## Editing copy / adding translations

All UI copy lives in `messages/es.json`, `messages/pt.json`, `messages/en.json`
— never hardcoded in components. The three files must keep the exact same
key structure (components read keys like `t('hero.title')`; a missing key
in one locale will throw at render time for that locale). When adding a
new key:

1. Add it to all three files, at the same nesting path.
2. Read it in the component via `getTranslations` (server components) or
   `useTranslations` (client components) from `next-intl`.
3. For arrays/objects (e.g. FAQ items), use `t.raw('key')` instead of `t('key')`.

## Legal pages

`/[locale]/privacidad` and `/[locale]/terminos` ship with general-purpose
placeholder content flagged inline (`legal.placeholderNotice` in each
locale file) — **fill in real company/legal details and have counsel review
before production**, per the source spec for this site.

## SEO

- Per-locale metadata, Open Graph and Twitter cards: `src/lib/seo.ts`.
- `hreflang` alternates + canonical: generated per page via `buildPageMetadata`.
- `sitemap.xml`: `src/app/sitemap.ts` (all locales × all pages).
- `robots.txt`: `src/app/robots.ts`.
- OG image: `src/app/[locale]/opengraph-image.tsx` serves `public/brand/og-image.png`
  directly once it exists; otherwise generates a per-locale placeholder on the fly.
  Same pattern for the favicon in `src/app/icon.tsx` and `public/brand/favicon.svg`.
- JSON-LD (`SoftwareApplication`): injected in `src/app/[locale]/page.tsx`.

No analytics/trackers are wired up. If you want to add one later, do it
deliberately (own decision, own review) — nothing here assumes it.

## Validating changes

From the monorepo root:

```bash
pnpm --filter @orderflow/marketing exec tsc --noEmit
pnpm --filter @orderflow/marketing lint
pnpm --filter @orderflow/marketing build
```

## Deploying to Vercel

This repo is a pnpm workspace (`pnpm-workspace.yaml` at the repo root lists
`apps/*` and `packages/*`) with Turborepo (`turbo.json`) on top. Vercel
detects both automatically, which is what makes the plain single-project
setup below work — no `vercel.json` needed.

**Project settings:**

| Setting          | Value                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root Directory   | `apps/marketing`                                                                                                                                                                                                                                          |
| Framework Preset | Next.js (auto-detected from `apps/marketing/package.json` + `next.config.ts`)                                                                                                                                                                             |
| Install Command  | Leave as default. Vercel walks up from Root Directory, finds `pnpm-workspace.yaml` at the repo root, and runs `pnpm install` there — this correctly resolves the `@orderflow/config` workspace dependency even though Root Directory isn't the repo root. |
| Build Command    | Leave as default (`next build`, run from Root Directory). No need to `cd` or chain commands manually.                                                                                                                                                     |
| Output Directory | Leave as default (`.next`, auto-detected by the Next.js preset).                                                                                                                                                                                          |
| Node.js Version  | 20.x (see `engines` in `package.json`)                                                                                                                                                                                                                    |

Vercel clones the full repository regardless of Root Directory, so
`packages/config` (used by `apps/marketing/tsconfig.json` via
`@orderflow/config/tsconfig/nextjs.json`) is physically present on disk at
build time — this isn't a case that needs the "Include files outside of
the Root Directory" toggle, but if a build ever fails to resolve
`@orderflow/config`, that toggle (Project Settings → General) is the first
thing to check.

**Environment variables to set** (Project Settings → Environment Variables,
only the ones you have real values for — see `.env.example`):

```
NEXT_PUBLIC_SITE_URL
NEXT_PUBLIC_WHATSAPP_NUMBER
NEXT_PUBLIC_CONTACT_EMAIL
NEXT_PUBLIC_STARTING_PRICE_USD
CONTACT_EMAIL
RESEND_API_KEY
RESEND_FROM_EMAIL
CONTACT_WEBHOOK_URL
```

`NEXT_PUBLIC_SITE_URL` is the only one worth setting even for a first
preview: without it, canonical/OG URLs fall back to Vercel's own preview
URL (`VERCEL_URL`), which works but changes on every deploy. Set it to the
real production domain once one is decided.

This app shares no runtime with `apps/web` or `apps/worker` and can be
deployed as a fully separate Vercel project without affecting either.

**Step-by-step, first import:**

1. **Import the repo**: Vercel dashboard → Add New → Project → pick this
   GitHub repo. Vercel will scan it and detect the pnpm workspace/Turborepo
   structure.
2. **Root Directory**: in the import screen (or Project Settings → General
   afterward), set it to `apps/marketing`. Framework Preset should
   auto-switch to "Next.js" once you do.
3. **Node.js Version**: Project Settings → General → Node.js Version →
   `20.x`. Leave Install/Build/Output Directory on their defaults (see
   table above).
4. **Environment variables**: Project Settings → Environment Variables →
   add whichever of the ones listed above you actually have values for.
   Nothing is required for the site to build and run — see the table
   earlier in this README for what each one gates.
5. **Deploy**: trigger the first deployment (happens automatically on
   import, or Deployments → Redeploy). This is a preview deployment on
   Vercel's own `*.vercel.app` URL — no custom domain needed yet.
6. **Check logs**: Deployments → (the deployment) → Building / Runtime Logs
   tabs. A successful build ends with the same route list shown by
   `pnpm build` locally (see the "Validating changes" build output above).
7. **Domain** (later, once one is decided): Project Settings → Domains →
   add the domain, point its DNS per Vercel's instructions, then update
   `NEXT_PUBLIC_SITE_URL` to match and redeploy.

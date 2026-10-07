import fs from 'fs'
import path from 'path'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

// Load the monorepo root .env.local so all vars come from one place in development.
// In production (Vercel) the file doesn't exist and vars come from the platform.
// Only sets keys that are not already in process.env (never overrides platform vars).
const rootEnvPath = path.join(__dirname, '../../.env.local')
if (fs.existsSync(rootEnvPath)) {
  for (const line of fs.readFileSync(rootEnvPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1)
    if (key && !(key in process.env)) process.env[key] = val
  }
}

// Powers the (marketing) route group's i18n (see src/i18n/request.ts).
// Doesn't touch CRM routing/rendering at all.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

// Fase 10 security audit — every real next/image usage in this app renders
// either a local/marketing asset or a Supabase Storage URL (property
// photos, tenant logos/covers — see property-images/tenant-public-assets,
// the two PUBLIC buckets). No code path ever passes an arbitrary/user-
// supplied host into next/image. remotePatterns was previously '**' (any
// HTTPS host) — since Next's image optimizer fetches the given URL
// server-side, an unrestricted host is unnecessary SSRF-adjacent surface
// with zero legitimate use today. Derived from the Supabase project URL
// itself rather than hardcoded, so dev/prod each get their own real host
// automatically.
let supabaseStorageHostname: string | null = null
try {
  supabaseStorageHostname = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname
} catch {
  console.warn('[next.config] NEXT_PUBLIC_SUPABASE_URL is missing/invalid — next/image will not be able to load Supabase Storage images.')
}

// Max request body for Server Actions — image (≤5 MB) and audio (≤16 MB)
// uploads go through them. Shared by the two options below: with middleware
// configured, Next buffers the body for it up to middlewareClientMaxBodySize
// (default 10 MB) and silently TRUNCATES anything larger, so a Server Action
// would get a cut multipart and fail with "Unexpected end of form" before it
// even runs — whatever bodySizeLimit says. Vercel's own 4.5 MB per-request cap
// still applies on top of this in production.
const SERVER_ACTION_BODY_LIMIT = '20mb'

const config: NextConfig = {
  transpilePackages: ['@orderflow/types', '@orderflow/supabase', '@orderflow/validators'],
  serverExternalPackages: ['pdfkit'],
  experimental: {
    serverActions: {
      bodySizeLimit: SERVER_ACTION_BODY_LIMIT,
    },
    middlewareClientMaxBodySize: SERVER_ACTION_BODY_LIMIT,
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: supabaseStorageHostname
      ? [{ protocol: 'https', hostname: supabaseStorageHostname }]
      : [],
  },
  // Fase 10 security audit — minimal, safe headers with no staged rollout
  // needed (unlike a full Content-Security-Policy, which this app does NOT
  // implement yet — see docs/production-security-checklist.md for why that
  // needs its own characterization pass before being added). These four
  // are uncontroversial defaults that cannot break existing functionality:
  // this app is never meant to be framed by another site, never relies on
  // the browser guessing a response's content type, and doesn't need
  // camera/microphone/geolocation access anywhere.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
}

export default withNextIntl(config)

import { z } from 'zod'

/**
 * All server-side config is optional by design: this site must keep working
 * (and degrade gracefully) even before WhatsApp/email/webhook are wired up.
 */

/**
 * `.env.example`'s own convention is `VAR=` (blank) for "not set", which
 * `process.env` reports as `""`, not `undefined`. Without this, every
 * `.optional()` field below would treat that blank as an *invalid* value
 * (fails .email()/.url()/.min(1)) instead of *absent*, logging a scary
 * config error on every single request for the completely normal case of
 * "left it blank".
 */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === '' ? undefined : value
}
const serverEnvSchema = z.object({
  CONTACT_EMAIL: z.string().email().optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  // Sender address for Resend. Deliberately separate from CONTACT_EMAIL
  // (the recipient) — a sender needs a domain verified with Resend, which
  // the recipient inbox has no bearing on.
  RESEND_FROM_EMAIL: z.string().min(1).optional(),
  CONTACT_WEBHOOK_URL: z.string().url().optional(),
})

const publicEnvSchema = z.object({
  NEXT_PUBLIC_WHATSAPP_NUMBER: z.string().min(1).optional(),
  NEXT_PUBLIC_CONTACT_EMAIL: z.string().email().optional(),
  NEXT_PUBLIC_STARTING_PRICE_USD: z.coerce.number().positive().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
})

function parseServerEnv() {
  const parsed = serverEnvSchema.safeParse({
    CONTACT_EMAIL: emptyToUndefined(process.env.CONTACT_EMAIL),
    RESEND_API_KEY: emptyToUndefined(process.env.RESEND_API_KEY),
    RESEND_FROM_EMAIL: emptyToUndefined(process.env.RESEND_FROM_EMAIL),
    CONTACT_WEBHOOK_URL: emptyToUndefined(process.env.CONTACT_WEBHOOK_URL),
  })

  if (!parsed.success) {
    console.error('Invalid server environment configuration', parsed.error.flatten())
    return serverEnvSchema.parse({})
  }

  return parsed.data
}

function parsePublicEnv() {
  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_WHATSAPP_NUMBER: emptyToUndefined(process.env.NEXT_PUBLIC_WHATSAPP_NUMBER),
    NEXT_PUBLIC_CONTACT_EMAIL: emptyToUndefined(process.env.NEXT_PUBLIC_CONTACT_EMAIL),
    NEXT_PUBLIC_STARTING_PRICE_USD: emptyToUndefined(process.env.NEXT_PUBLIC_STARTING_PRICE_USD),
    NEXT_PUBLIC_SITE_URL: emptyToUndefined(process.env.NEXT_PUBLIC_SITE_URL),
  })

  if (!parsed.success) {
    console.error('Invalid public environment configuration', parsed.error.flatten())
    return publicEnvSchema.parse({})
  }

  return parsed.data
}

export const serverEnv = parseServerEnv()
export const publicEnv = parsePublicEnv()

/**
 * Resolution order, so canonical/sitemap/OG URLs are never wrong by
 * omission: explicit env var (trailing slash stripped, so `${siteUrl}/es`
 * never doubles up) > Vercel's own preview/production URL (set
 * automatically on every deploy, no config needed) > localhost in dev >
 * a non-localhost placeholder as the last resort so production never
 * accidentally ships a "localhost" sitemap if every other signal is
 * missing.
 */
function resolveSiteUrl(): string {
  const configured = publicEnv.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '')
  if (configured) return configured

  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`

  if (process.env.NODE_ENV === 'development') return 'http://localhost:3100'

  return 'https://reservanex.com'
}

export const siteUrl = resolveSiteUrl()

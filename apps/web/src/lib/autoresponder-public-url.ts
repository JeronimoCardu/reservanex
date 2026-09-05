// Fase 9 — the single source of truth for the public origin an Android
// physically calls (over the real internet) to reach the 4 AutoResponder
// webhooks. Distinct from getSiteUrl() (site-url.ts), which is the
// BROWSER-facing app origin used for Supabase Auth email redirects —
// NEXT_PUBLIC_SITE_URL is `http://localhost:3001` in dev, which a phone on
// the public internet cannot reach at all. In dev this must instead be the
// current public tunnel URL (e.g. a temporary ngrok/cloudflared HTTPS
// domain); in production, https://reservanex.com.
//
// Global infrastructure config — NEVER stored per-tenant. Every tenant's
// Android hits the exact same 4 endpoint paths off this one origin; only
// the device token (per whatsapp_accounts row) differentiates them.

export function getAutoResponderPublicBaseUrl(): string {
  const url = process.env.AUTORESPONDER_PUBLIC_BASE_URL
  if (!url) {
    throw new Error(
      '[autoresponder-public-url] AUTORESPONDER_PUBLIC_BASE_URL no está configurada — ' +
      'la guía de instalación Android no puede generar los endpoints. ' +
      'Development: la URL pública HTTPS de tu túnel actual · ' +
      'Production: https://reservanex.com. Nunca localhost — el Android no puede alcanzarlo.',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('[autoresponder-public-url] AUTORESPONDER_PUBLIC_BASE_URL no es una URL válida.')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('[autoresponder-public-url] AUTORESPONDER_PUBLIC_BASE_URL debe ser HTTPS.')
  }

  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    throw new Error(
      '[autoresponder-public-url] AUTORESPONDER_PUBLIC_BASE_URL no puede ser localhost — ' +
      'el Android no puede alcanzar la PC de desarrollo. Usá la URL pública de tu túnel actual.',
    )
  }

  return url.replace(/\/+$/, '')
}

export interface AutoResponderEndpoints {
  inbound:     string
  heartbeat:   string
}

export function getAutoResponderEndpoints(): AutoResponderEndpoints {
  const base = getAutoResponderPublicBaseUrl()
  return {
    inbound:     `${base}/api/webhooks/autoresponder`,
    heartbeat:   `${base}/api/webhooks/autoresponder/heartbeat`,
  }
}

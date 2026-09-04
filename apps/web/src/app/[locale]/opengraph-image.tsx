import { ImageResponse } from 'next/og'
import { getTranslations } from 'next-intl/server'
import { readPublicBrandFile } from '@/lib/marketing/brand-assets'

export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/**
 * Serves public/brand/og-image.png once it exists (see
 * public/brand/README.md). It's locale-agnostic by design — one polished
 * official OG image beats four generated ones. Until it exists, this
 * generates a per-locale placeholder from the hero title instead.
 */
export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  const staticImage = readPublicBrandFile('brand/og-image.png', 'image/png')
  if (staticImage) {
    return new Response(staticImage.buffer, {
      headers: { 'Content-Type': staticImage.contentType },
    })
  }

  // The eyebrow ("CRM inmobiliario con WhatsApp e IA" / etc.) is a short,
  // punchy line built for exactly this — the full hero title is a sentence
  // meant for a page heading, not a social-preview card at a glance.
  const t = await getTranslations({ locale, namespace: 'hero' })

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px',
          background: '#0B1020',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 56 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(135deg, #39B454, #FFC400)',
              color: 'white',
              fontSize: 24,
              fontWeight: 700,
            }}
          >
            OF
          </div>
          <div style={{ fontSize: 40, fontWeight: 700, color: 'white' }}>ReservaNex</div>
        </div>
        <div style={{ display: 'flex', fontSize: 56, fontWeight: 700, lineHeight: 1.3, color: 'white', maxWidth: 1000 }}>
          {t('eyebrow')}
        </div>
      </div>
    ),
    { ...size },
  )
}

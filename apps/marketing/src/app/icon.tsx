import { ImageResponse } from 'next/og'
import { readPublicBrandFile } from '@/lib/brand-assets'

/**
 * Serves public/brand/favicon.svg as-is once it exists (see
 * public/brand/README.md for the exact filename). Until then, falls back to
 * a generated placeholder — not the real ReservaNex mark, just a neutral
 * stand-in so the site never ships a broken or missing favicon.
 */
export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  const favicon = readPublicBrandFile('brand/favicon.svg', 'image/svg+xml')
  if (favicon) {
    return new Response(favicon.buffer, {
      headers: { 'Content-Type': favicon.contentType },
    })
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0B1020',
          borderRadius: 6,
          color: '#000000',
          fontSize: 16,
          fontWeight: 700,
          fontFamily: 'sans-serif',
        }}
      >
        OF
      </div>
    ),
    { ...size },
  )
}

import { ImageResponse } from 'next/og'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
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
          color: '#39B454',
          fontSize: 72,
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

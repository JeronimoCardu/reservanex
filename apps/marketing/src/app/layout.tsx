import type { ReactNode } from 'react'

// Intentionally a pass-through: app/[locale]/layout.tsx owns <html>/<body>
// so the locale attribute can be set correctly per request.
export default function RootLayout({ children }: { children: ReactNode }) {
  return children
}

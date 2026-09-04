import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'ReservaNex',
  description: 'Plataforma de gestión inmobiliaria',
}

// Pass-through: each top-level route group owns its own <html>/<body> now
// (see CrmHtmlShell for the CRM groups, (marketing)/[locale]/layout.tsx for
// the public site) since they need different <html lang>. This file still
// carries the global CSS import and the site's default metadata — both
// apply regardless of which descendant layout renders <html>.
export default function RootLayout({ children }: { children: ReactNode }) {
  return children
}

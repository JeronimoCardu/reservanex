import type { ReactNode } from 'react'
import { Inter } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'

const inter = Inter({ subsets: ['latin'] })

/**
 * Owns <html>/<body> for every CRM route group ((auth), (platform),
 * (tenant)). Extracted from what used to be the app-wide root layout so the
 * (marketing) route group can own its own <html lang={locale}> instead —
 * Next.js only allows the outermost layout that actually renders in a given
 * tree to declare <html>/<body>, and CRM vs. marketing now diverge on that
 * (marketing's lang varies by locale, the CRM's is fixed "es").
 *
 * Output is unchanged from the previous single root layout: same font,
 * same Toaster.
 */
export function CrmHtmlShell({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body cz-shortcut-listen="true" className={inter.className}>
        {children}
        <Toaster />
      </body>
    </html>
  )
}

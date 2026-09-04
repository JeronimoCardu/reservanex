import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { Inter } from 'next/font/google'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { routing, type AppLocale } from '@/i18n/routing'
import { Header } from '@/components/marketing/layout/header'
import { Footer } from '@/components/marketing/layout/footer'
import { WhatsappFloatButton } from '@/components/marketing/layout/whatsapp-float-button'
import { siteUrl } from '@/lib/marketing/env'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }

  setRequestLocale(locale as AppLocale)

  return (
    <html lang={locale} className={inter.variable}>
      <body
        cz-shortcut-listen="true"
        className="text-brand-deep min-h-screen bg-white font-sans antialiased"
      >
        <NextIntlClientProvider>
          <a
            href="#top"
            className="focus:bg-brand-deep sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:px-4 focus:py-2 focus:text-white"
          >
            Skip to content
          </a>
          <Header />
          <main>{children}</main>
          <Footer />
          <WhatsappFloatButton />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}

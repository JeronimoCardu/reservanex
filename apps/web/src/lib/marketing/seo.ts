import type { Metadata } from 'next'
import { locales, type AppLocale } from '@/i18n/routing'
import { siteUrl } from './env'

const ogLocaleMap: Record<AppLocale, string> = {
  es: 'es_ES',
  pt: 'pt_BR',
  en: 'en_US',
}

/**
 * Builds hreflang alternates + a self-referencing canonical for a given
 * locale + path shared across locales (e.g. "/", "/privacidad"). `path`
 * must already exclude the locale prefix. Canonical points at this
 * locale's own URL, not a locale-neutral one — that's what the hreflang
 * spec expects (each localized page is canonical for itself).
 */
export function buildLocaleAlternates(locale: AppLocale, path: string) {
  const normalizedPath = path === '/' ? '' : path
  const languages = Object.fromEntries(
    locales.map((l) => [l, `${siteUrl}/${l}${normalizedPath}`]),
  )

  return {
    canonical: `${siteUrl}/${locale}${normalizedPath}`,
    languages: {
      ...languages,
      'x-default': `${siteUrl}/${locales[0]}${normalizedPath}`,
    },
  }
}

export function buildPageMetadata(options: {
  locale: AppLocale
  path: string
  title: string
  description: string
  ogAlt: string
}): Metadata {
  const { locale, path, title, description, ogAlt } = options
  const normalizedPath = path === '/' ? '' : path
  const url = `${siteUrl}/${locale}${normalizedPath}`

  return {
    title,
    description,
    alternates: buildLocaleAlternates(locale, path),
    openGraph: {
      title,
      description,
      url,
      siteName: 'ReservaNex',
      locale: ogLocaleMap[locale],
      type: 'website',
      images: [{ url: `${siteUrl}/${locale}/opengraph-image`, alt: ogAlt }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [`${siteUrl}/${locale}/opengraph-image`],
    },
  }
}

export function buildSoftwareApplicationJsonLd(options: {
  locale: AppLocale
  name: string
  description: string
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: options.name,
    description: options.description,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: `${siteUrl}/${options.locale}`,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    },
  }
}

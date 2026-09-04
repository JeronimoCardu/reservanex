import type { MetadataRoute } from 'next'
import { locales } from '@/i18n/routing'
import { siteUrl } from '@/lib/env'

const paths = ['', '/privacidad', '/terminos']

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = []

  for (const locale of locales) {
    for (const path of paths) {
      entries.push({
        url: `${siteUrl}/${locale}${path}`,
        lastModified: new Date(),
        alternates: {
          languages: Object.fromEntries(locales.map((l) => [l, `${siteUrl}/${l}${path}`])),
        },
      })
    }
  }

  return entries
}

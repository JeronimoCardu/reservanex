import { defineRouting } from 'next-intl/routing'

export const locales = ['es', 'pt', 'en'] as const

export type AppLocale = (typeof locales)[number]

export const routing = defineRouting({
  locales,
  defaultLocale: 'es',
  localePrefix: 'always',
})

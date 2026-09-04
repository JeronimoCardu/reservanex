import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { hasLocale } from 'next-intl'
import { notFound } from 'next/navigation'
import { routing, type AppLocale } from '@/i18n/routing'
import { buildPageMetadata } from '@/lib/seo'
import { LegalPage } from '@/components/legal/legal-page'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'termsPage' })
  const tMeta = await getTranslations({ locale, namespace: 'meta' })

  return buildPageMetadata({
    locale: locale as AppLocale,
    path: '/terminos',
    title: `${t('title')} — ReservaNex`,
    description: t('intro'),
    ogAlt: tMeta('ogAlt'),
  })
}

export default async function TermsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }

  setRequestLocale(locale as AppLocale)

  const t = await getTranslations('termsPage')
  const tLegal = await getTranslations('legal')
  const sections = t.raw('sections') as { heading: string; body: string }[]

  return (
    <LegalPage
      title={t('title')}
      intro={t('intro')}
      sections={sections}
      backHomeLabel={tLegal('backHome')}
      placeholderNotice={tLegal('placeholderNotice')}
    />
  )
}

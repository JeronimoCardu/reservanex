import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { hasLocale } from 'next-intl'
import { notFound } from 'next/navigation'
import { routing, type AppLocale } from '@/i18n/routing'
import { buildPageMetadata, buildSoftwareApplicationJsonLd } from '@/lib/marketing/seo'
import { Hero } from '@/components/marketing/sections/hero'
import { ProblemSolution } from '@/components/marketing/sections/problem-solution'
import { HowItWorks } from '@/components/marketing/sections/how-it-works'
import { VideoDemo } from '@/components/marketing/sections/video-demo'
import { Features } from '@/components/marketing/sections/features'
import { Benefits } from '@/components/marketing/sections/benefits'
import { ProductPreview } from '@/components/marketing/sections/product-preview'
import { Audience } from '@/components/marketing/sections/audience'
import { Pricing } from '@/components/marketing/sections/pricing'
import { Security } from '@/components/marketing/sections/security'
import { Faq } from '@/components/marketing/sections/faq'
import { Contact } from '@/components/marketing/sections/contact'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'meta' })

  return buildPageMetadata({
    locale: locale as AppLocale,
    path: '/',
    title: t('title'),
    description: t('description'),
    ogAlt: t('ogAlt'),
  })
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }

  setRequestLocale(locale as AppLocale)

  const tMeta = await getTranslations({ locale, namespace: 'meta' })
  const jsonLd = buildSoftwareApplicationJsonLd({
    locale: locale as AppLocale,
    name: 'ReservaNex',
    description: tMeta('description'),
  })

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Hero />
      <ProblemSolution />
      <HowItWorks />
      <VideoDemo />
      <Features />
      <Benefits />
      <ProductPreview />
      <Audience />
      <Pricing />
      <Security />
      <Faq />
      <Contact />
    </>
  )
}

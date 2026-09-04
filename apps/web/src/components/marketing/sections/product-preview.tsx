import { getTranslations } from 'next-intl/server'
import { Container } from '@/components/marketing/ui/container'
import { SectionHeading } from '@/components/marketing/ui/section-heading'
import { CrmMockup } from '@/components/marketing/product-preview/crm-mockup'
import { getProductImagePath } from '@/lib/marketing/product-assets'

export async function ProductPreview() {
  const t = await getTranslations('productPreview')

  const tabs = {
    conversations: t('tabs.conversations'),
    properties: t('tabs.properties'),
    reservations: t('tabs.reservations'),
    team: t('tabs.team'),
  }

  const captions = {
    conversations: t('conversationsCaption'),
    properties: t('propertiesCaption'),
    reservations: t('reservationsCaption'),
    team: t('teamCaption'),
  }

  const images = {
    conversations: getProductImagePath('conversations'),
    properties: getProductImagePath('properties'),
    reservations: getProductImagePath('reservations'),
    team: getProductImagePath('team'),
  }

  const labels = t.raw('labels') as Record<string, string>

  return (
    <section className="bg-surface-light py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />

        <div className="mx-auto mt-14 max-w-3xl">
          <CrmMockup
            tabs={tabs}
            captions={captions}
            labels={labels}
            images={images}
            placeholderNote={t('placeholderNote')}
          />
        </div>
      </Container>
    </section>
  )
}

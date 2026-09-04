import { getTranslations } from 'next-intl/server'
import { Check } from 'lucide-react'
import { Container } from '@/components/marketing/ui/container'
import { SectionHeading } from '@/components/marketing/ui/section-heading'

export async function Benefits() {
  const t = await getTranslations('benefits')
  const items = t.raw('items') as string[]

  return (
    <section className="bg-white py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />

        <ul className="mx-auto mt-12 grid max-w-4xl gap-x-8 gap-y-4 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-green/15 text-brand-green">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="text-sm leading-relaxed text-slate-600">{item}</span>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}

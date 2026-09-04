import { getTranslations } from 'next-intl/server'
import { Container } from '@/components/ui/container'
import { SectionHeading } from '@/components/ui/section-heading'
import { AccordionItem } from '@/components/ui/accordion-item'

type Item = { question: string; answer: string }

export async function Faq() {
  const t = await getTranslations('faq')
  const items = t.raw('items') as Item[]

  return (
    <section id="faq" className="bg-white py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} />

        <div className="mx-auto mt-12 max-w-3xl space-y-3">
          {items.map((item) => (
            <AccordionItem key={item.question} question={item.question} answer={item.answer} />
          ))}
        </div>
      </Container>
    </section>
  )
}

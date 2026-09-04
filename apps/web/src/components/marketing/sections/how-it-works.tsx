import { getTranslations } from 'next-intl/server'
import { Container } from '@/components/marketing/ui/container'
import { SectionHeading } from '@/components/marketing/ui/section-heading'

type Step = { title: string; description: string }

export async function HowItWorks() {
  const t = await getTranslations('howItWorks')
  const steps = t.raw('steps') as Step[]

  return (
    <section id="how-it-works" className="bg-white py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />

        <ol className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {steps.map((step, index) => (
            <li key={step.title} className="relative flex flex-col gap-3 rounded-2xl border border-slate-200 p-5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-deep text-sm font-bold text-white">
                {index + 1}
              </span>
              <h3 className="text-base font-semibold text-brand-deep">{step.title}</h3>
              <p className="text-sm leading-relaxed text-slate-600">{step.description}</p>
            </li>
          ))}
        </ol>

        <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-slate-500">{t('note')}</p>
      </Container>
    </section>
  )
}

import { getTranslations } from 'next-intl/server'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/ui/container'
import { SectionHeading } from '@/components/ui/section-heading'
import { Card } from '@/components/ui/card'

type Item = { problem: string; solution: string }

export async function ProblemSolution() {
  const t = await getTranslations('problemSolution')
  const items = t.raw('items') as Item[]

  return (
    <section id="solution" className="bg-surface-light py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />

        <div className="mt-14 grid gap-5 sm:grid-cols-2">
          {items.map((item) => (
            <Card key={item.problem} className="flex flex-col gap-4">
              <p className="text-sm font-medium text-red-500 line-through decoration-slate-500">
                {item.problem}
              </p>
              <div className="flex items-start gap-2">
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-brand-green" aria-hidden="true" />
                <p className="text-sm font-semibold text-brand-deep">{item.solution}</p>
              </div>
            </Card>
          ))}
        </div>
      </Container>
    </section>
  )
}

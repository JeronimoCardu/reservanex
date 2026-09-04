import { getTranslations } from 'next-intl/server'
import { Building2, Home, Users, TrendingUp } from 'lucide-react'
import { Container } from '@/components/ui/container'
import { SectionHeading } from '@/components/ui/section-heading'
import { Card } from '@/components/ui/card'

type Item = { title: string; description: string }

const icons = [Building2, Home, Users, TrendingUp]

export async function Audience() {
  const t = await getTranslations('audience')
  const items = t.raw('items') as Item[]

  return (
    <section className="bg-white py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((item, index) => {
            const Icon = icons[index % icons.length]!
            return (
              <Card key={item.title} className="text-center">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-brand-yellow/15 text-amber-600">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-brand-deep">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{item.description}</p>
              </Card>
            )
          })}
        </div>
      </Container>
    </section>
  )
}

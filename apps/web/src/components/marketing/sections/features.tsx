import { getTranslations } from 'next-intl/server'
import {
  MessageSquare,
  Bot,
  UserCheck,
  UsersRound,
  Contact,
  Building2,
  CalendarCheck,
  ShieldCheck,
  StickyNote,
  Radio,
} from 'lucide-react'
import { Container } from '@/components/marketing/ui/container'
import { SectionHeading } from '@/components/marketing/ui/section-heading'
import { Card } from '@/components/marketing/ui/card'

type Item = { title: string; description: string }

const icons = [
  MessageSquare,
  Bot,
  UserCheck,
  UsersRound,
  Contact,
  Building2,
  CalendarCheck,
  ShieldCheck,
  StickyNote,
  Radio,
]

export async function Features() {
  const t = await getTranslations('features')
  const items = t.raw('items') as Item[]

  return (
    <section id="features" className="bg-surface-light py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item, index) => {
            const Icon = icons[index % icons.length]!
            return (
              <Card key={item.title}>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-green/10 text-brand-green">
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

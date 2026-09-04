import { getTranslations } from 'next-intl/server'
import { ShieldCheck, KeyRound, SlidersHorizontal, UserCog, Lock } from 'lucide-react'
import { Container } from '@/components/ui/container'
import { SectionHeading } from '@/components/ui/section-heading'

type Item = { title: string; description: string }

const icons = [ShieldCheck, KeyRound, SlidersHorizontal, UserCog, Lock]

export async function Security() {
  const t = await getTranslations('security')
  const items = t.raw('items') as Item[]

  return (
    <section className="bg-brand-deep py-20 sm:py-24">
      <Container>
        <SectionHeading
          eyebrow={t('eyebrow')}
          title={t('title')}
          subtitle={t('subtitle')}
          className="[&_h2]:text-white [&_p]:text-slate-300 [&_.text-brand-green]:text-brand-yellow"
        />

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {items.map((item, index) => {
            const Icon = icons[index % icons.length]!
            return (
              <div key={item.title} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-yellow/15 text-brand-yellow">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-sm font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">{item.description}</p>
              </div>
            )
          })}
        </div>
      </Container>
    </section>
  )
}

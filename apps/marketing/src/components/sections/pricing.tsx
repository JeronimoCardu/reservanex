import { getTranslations } from 'next-intl/server'
import { Check } from 'lucide-react'
import { Container } from '@/components/ui/container'
import { SectionHeading } from '@/components/ui/section-heading'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { publicEnv } from '@/lib/env'

export async function Pricing() {
  const t = await getTranslations('pricing')
  const factors = t.raw('factors') as string[]
  const startingPrice = publicEnv.NEXT_PUBLIC_STARTING_PRICE_USD

  return (
    <section id="pricing" className="bg-surface-light py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} />

        <Card className="mx-auto mt-12 max-w-2xl text-center">
          {startingPrice ? (
            <p className="text-4xl font-bold tracking-tight text-brand-deep">
              {t('startingFromPrefix')}{' '}
              <span className="text-brand-green">US$ {startingPrice}</span>{' '}
              <span className="text-lg font-medium text-slate-500">{t('startingFromSuffix')}</span>
            </p>
          ) : (
            <p className="text-2xl font-bold tracking-tight text-brand-deep sm:text-3xl">
              {t('customPlans')}
            </p>
          )}
          <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-slate-600">
            {t('description')}
          </p>

          <div className="mx-auto mt-8 max-w-sm text-left">
            <p className="text-sm font-semibold text-brand-deep">{t('factorsTitle')}</p>
            <ul className="mt-3 space-y-2">
              {factors.map((factor) => (
                <li key={factor} className="flex items-start gap-2 text-sm text-slate-600">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-green" aria-hidden="true" />
                  {factor}
                </li>
              ))}
            </ul>
          </div>

          <Button href="#contact" size="lg" className="mt-8">
            {t('cta')}
          </Button>
        </Card>
      </Container>
    </section>
  )
}

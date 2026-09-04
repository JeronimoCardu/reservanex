import { getTranslations } from 'next-intl/server'
import { Container } from '@/components/marketing/ui/container'
import { Button } from '@/components/marketing/ui/button'
import { WhatsappMockup } from '@/components/marketing/product-preview/whatsapp-mockup'
import { buildWhatsappLink } from '@/lib/marketing/whatsapp'

export async function Hero() {
  const t = await getTranslations('hero')
  const tWhatsapp = await getTranslations('whatsappButton')
  const whatsappHref = buildWhatsappLink(tWhatsapp('defaultMessage'))

  return (
    <section id="top" className="relative overflow-hidden bg-brand-deep">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'radial-gradient(circle at 15% 20%, rgba(57,180,84,0.25), transparent 45%), radial-gradient(circle at 85% 0%, rgba(255,196,0,0.18), transparent 40%)',
        }}
        aria-hidden="true"
      />
      <Container className="relative grid gap-12 py-16 sm:py-20 lg:grid-cols-2 lg:items-center lg:py-28">
        <div className="animate-fade-in motion-reduce:animate-none">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-yellow">
            {t('eyebrow')}
          </p>
          <h1 className="mt-4 text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
            {t('title')}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">{t('subtitle')}</p>
          <p className="mt-4 text-sm text-slate-400">{t('note')}</p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            {whatsappHref ? (
              <Button
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                size="lg"
                className="w-full sm:w-auto"
              >
                {t('ctaPrimary')}
              </Button>
            ) : null}
            <Button href="#contact" variant="onDark" size="lg" className="w-full sm:w-auto">
              {t('ctaSecondary')}
            </Button>
          </div>
        </div>

        <div className="animate-fade-in motion-reduce:animate-none">
          <WhatsappMockup
            ariaLabel={t('previewAria')}
            contactName={t('previewContactName')}
            badgeAi={t('previewBadgeAi')}
            badgeHuman={t('previewBadgeHuman')}
            clientMessage={t('previewClientMessage')}
            aiMessage={t('previewAiMessage')}
            handoffMessage={t('previewHandoffMessage')}
            humanMessage={t('previewHumanMessage')}
          />
        </div>
      </Container>
    </section>
  )
}

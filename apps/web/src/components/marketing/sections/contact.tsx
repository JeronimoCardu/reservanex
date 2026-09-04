import { getTranslations } from 'next-intl/server'
import { MessageCircle, Mail } from 'lucide-react'
import { Container } from '@/components/marketing/ui/container'
import { SectionHeading } from '@/components/marketing/ui/section-heading'
import { Card } from '@/components/marketing/ui/card'
import { ContactForm } from '@/components/marketing/forms/contact-form'
import { buildWhatsappLink } from '@/lib/marketing/whatsapp'
import { publicEnv } from '@/lib/marketing/env'

export async function Contact() {
  const t = await getTranslations('contact')
  const tWhatsapp = await getTranslations('whatsappButton')
  const whatsappHref = buildWhatsappLink(tWhatsapp('defaultMessage'))
  const contactEmail = publicEnv.NEXT_PUBLIC_CONTACT_EMAIL

  return (
    <section id="contact" className="bg-white py-20 sm:py-24">
      <Container>
        <SectionHeading eyebrow={t('eyebrow')} title={t('title')} subtitle={t('subtitle')} />

        <div className="mx-auto mt-14 grid max-w-5xl gap-6 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-2">
            {whatsappHref ? (
              <Card>
                <a
                  href={whatsappHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-3"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-green/10 text-brand-green">
                    <MessageCircle className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-brand-deep">
                      {t('whatsappTitle')}
                    </span>
                    <span className="mt-1 block text-sm text-slate-500">
                      {t('whatsappDescription')}
                    </span>
                  </span>
                </a>
              </Card>
            ) : null}

            {contactEmail ? (
              <Card>
                <a href={`mailto:${contactEmail}`} className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-yellow/15 text-amber-600">
                    <Mail className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-brand-deep">
                      {t('emailTitle')}
                    </span>
                    <span className="mt-1 block break-all text-sm text-slate-500">{contactEmail}</span>
                  </span>
                </a>
              </Card>
            ) : null}
          </div>

          <Card className="lg:col-span-3">
            <h3 className="sr-only">{t('formTitle')}</h3>
            <ContactForm />
          </Card>
        </div>
      </Container>
    </section>
  )
}

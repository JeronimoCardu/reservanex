import { getTranslations } from 'next-intl/server'
import { Logo } from '@/components/marketing/ui/logo'
import { Container } from '@/components/marketing/ui/container'
import { Link } from '@/i18n/navigation'
import { publicEnv } from '@/lib/marketing/env'
import { buildWhatsappLink } from '@/lib/marketing/whatsapp'
import { getBrandLogoHorizontalPath } from '@/lib/marketing/brand-assets'

export async function Footer() {
  const t = await getTranslations('footer')
  const tNav = await getTranslations('nav')
  const tWhatsapp = await getTranslations('whatsappButton')
  const whatsappHref = buildWhatsappLink(tWhatsapp('defaultMessage'))
  const contactEmail = publicEnv.NEXT_PUBLIC_CONTACT_EMAIL
  const hasContactColumn = Boolean(whatsappHref || contactEmail)
  const logoSrc = getBrandLogoHorizontalPath()
  const year = new Date().getFullYear()

  const navLinks = [
    { href: '#solution', label: tNav('solution') },
    { href: '#how-it-works', label: tNav('howItWorks') },
    { href: '#features', label: tNav('features') },
    { href: '#pricing', label: tNav('pricing') },
    { href: '#faq', label: tNav('faq') },
    { href: '#contact', label: tNav('contact') },
  ]

  return (
    <footer className="border-t border-slate-100 bg-white">
      <Container className="grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Logo src={logoSrc} />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-500">{t('description')}</p>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-brand-deep">{t('navTitle')}</h3>
          <ul className="mt-4 space-y-2">
            {navLinks.map((link) => (
              <li key={link.href}>
                <a href={link.href} className="text-sm text-slate-500 hover:text-brand-deep">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>

        {hasContactColumn ? (
          <div>
            <h3 className="text-sm font-semibold text-brand-deep">{t('contactTitle')}</h3>
            <ul className="mt-4 space-y-2 text-sm text-slate-500">
              {whatsappHref ? (
                <li>
                  <a href={whatsappHref} target="_blank" rel="noopener noreferrer" className="hover:text-brand-deep">
                    WhatsApp
                  </a>
                </li>
              ) : null}
              {contactEmail ? (
                <li>
                  <a href={`mailto:${contactEmail}`} className="hover:text-brand-deep">
                    {contactEmail}
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        <div>
          <h3 className="text-sm font-semibold text-brand-deep">{t('legalTitle')}</h3>
          <ul className="mt-4 space-y-2">
            <li>
              <Link href="/privacidad" className="text-sm text-slate-500 hover:text-brand-deep">
                {t('privacy')}
              </Link>
            </li>
            <li>
              <Link href="/terminos" className="text-sm text-slate-500 hover:text-brand-deep">
                {t('terms')}
              </Link>
            </li>
          </ul>
        </div>
      </Container>

      <div className="border-t border-slate-100 py-6">
        <Container className="flex flex-col items-center justify-between gap-2 text-xs text-slate-400 sm:flex-row">
          <p>
            © {year} ReservaNex. {t('rights')}
          </p>
        </Container>
      </div>
    </footer>
  )
}

import { getTranslations } from 'next-intl/server'
import { Logo } from '@/components/marketing/ui/logo'
import { Button } from '@/components/marketing/ui/button'
import { Container } from '@/components/marketing/ui/container'
import { getBrandLogoHorizontalPath } from '@/lib/marketing/brand-assets'
import { LanguageSwitcher } from './language-switcher'
import { MobileMenu } from './mobile-menu'

export async function Header() {
  const t = await getTranslations('nav')
  const logoSrc = getBrandLogoHorizontalPath()

  const links = [
    { href: '#solution', label: t('solution') },
    { href: '#how-it-works', label: t('howItWorks') },
    { href: '#features', label: t('features') },
    { href: '#pricing', label: t('pricing') },
    { href: '#faq', label: t('faq') },
    { href: '#contact', label: t('contact') },
  ]

  return (
    <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/90 backdrop-blur">
      <Container className="flex h-16 items-center justify-between gap-4">
        <a href="#top" className="shrink-0">
          <Logo src={logoSrc} />
        </a>

        <nav
          className="hidden items-center gap-5 xl:gap-6 lg:flex"
          aria-label={t('mainNavigation')}
        >
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="whitespace-nowrap text-sm font-medium text-slate-600 transition-colors hover:text-brand-deep"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <LanguageSwitcher />
          {/*
           * Plain <a>, not the locale-aware `Link` from @/i18n/navigation:
           * /login is a CRM route outside next-intl's routing entirely and
           * must never get a locale prefix (no /es/login).
           */}
          <Button href="/login" variant="ghost" size="md">
            {t('login')}
          </Button>
          <Button href="#contact" size="md">
            {t('requestInfo')}
          </Button>
        </div>

        <MobileMenu
          links={links}
          openLabel={t('openMenu')}
          closeLabel={t('closeMenu')}
          logoSrc={logoSrc}
          loginLabel={t('login')}
        />
      </Container>
    </header>
  )
}

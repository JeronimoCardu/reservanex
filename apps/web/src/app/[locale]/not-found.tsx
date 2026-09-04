import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Container } from '@/components/marketing/ui/container'

export default async function LocaleNotFound() {
  const t = await getTranslations('legal')

  return (
    <Container className="flex min-h-[50vh] flex-col items-center justify-center py-20 text-center">
      <p className="text-6xl font-bold text-brand-deep">404</p>
      <Link
        href="/"
        className="mt-6 text-sm font-semibold text-brand-green underline underline-offset-2"
      >
        {t('backHome')}
      </Link>
    </Container>
  )
}

'use client'

import { Globe, ChevronDown } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { locales, type AppLocale } from '@/i18n/routing'
import { cn } from '@/lib/utils'

const localeLabels: Record<AppLocale, string> = {
  es: 'Español',
  pt: 'Português',
  en: 'English',
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()
  const t = useTranslations('nav')

  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <Globe
        className="pointer-events-none absolute left-2.5 h-4 w-4 text-slate-400"
        aria-hidden="true"
      />
      <select
        aria-label={t('languageLabel')}
        value={locale}
        onChange={(event) => router.replace(pathname, { locale: event.target.value as AppLocale })}
        className="h-9 appearance-none rounded-full border border-slate-200 bg-white py-0 pl-8 pr-8 text-xs font-semibold text-brand-deep transition-colors hover:border-brand-green/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-deep"
      >
        {locales.map((candidate) => (
          <option key={candidate} value={candidate}>
            {localeLabels[candidate]}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-slate-400"
        aria-hidden="true"
      />
    </div>
  )
}

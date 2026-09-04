'use client'

import { useEffect, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { buildWhatsappLink } from '@/lib/marketing/whatsapp'
import { cn } from '@/lib/utils'

export function WhatsappFloatButton() {
  const t = useTranslations('whatsappButton')
  const href = buildWhatsappLink(t('defaultMessage'))
  const [pastHero, setPastHero] = useState(false)

  // The hero already has its own prominent "Chat on WhatsApp" CTA, and on
  // mobile that CTA sits exactly where this floating button lives — showing
  // both at once means the floating button covers the hero's own button.
  // Hiding it until the hero scrolls out of view avoids the overlap without
  // losing the floating button for the rest of the page.
  useEffect(() => {
    const hero = document.getElementById('top')
    if (!hero) {
      setPastHero(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setPastHero(!entry.isIntersecting)
      },
      { rootMargin: '-64px 0px 0px 0px' },
    )
    observer.observe(hero)
    return () => observer.disconnect()
  }, [])

  if (!href) return null

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('ariaLabel')}
      aria-hidden={!pastHero}
      tabIndex={pastHero ? 0 : -1}
      className={cn(
        'fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand-green text-white shadow-soft transition-all duration-200 hover:scale-105 motion-reduce:transition-none sm:bottom-6 sm:right-6',
        pastHero ? 'opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
      )}
    >
      <MessageCircle className="h-7 w-7" aria-hidden="true" />
    </a>
  )
}

'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Menu, X } from 'lucide-react'
import { Logo } from '@/components/ui/logo'
import { LanguageSwitcher } from './language-switcher'

export function MobileMenu({
  links,
  openLabel,
  closeLabel,
  logoSrc,
}: {
  links: { href: string; label: string }[]
  openLabel: string
  closeLabel: string
  logoSrc?: string | null
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={openLabel}
        aria-expanded={open}
        className="flex h-10 w-10 items-center justify-center rounded-lg text-brand-deep hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-deep"
      >
        <Menu className="h-6 w-6" aria-hidden="true" />
      </button>

      {/*
       * Portalled to document.body: the header is `sticky` + `backdrop-blur`,
       * and backdrop-filter establishes a containing block for `position:
       * fixed` descendants. Left in place, this panel would be constrained
       * to the header's own (64px) box instead of covering the viewport.
       */}
      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex flex-col bg-white">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4">
                <Logo src={logoSrc} />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={closeLabel}
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-brand-deep hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-deep"
                >
                  <X className="h-6 w-6" aria-hidden="true" />
                </button>
              </div>
              <nav className="flex flex-col gap-1 overflow-y-auto px-4 py-6">
                {links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="rounded-lg px-3 py-3 text-base font-semibold text-brand-deep hover:bg-slate-50"
                  >
                    {link.label}
                  </a>
                ))}
              </nav>
              <div className="px-4 pb-6">
                <LanguageSwitcher className="w-fit" />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

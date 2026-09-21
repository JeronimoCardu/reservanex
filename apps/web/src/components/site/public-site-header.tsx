'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link  from 'next/link'
import type { PublicTenant } from '@/lib/repositories/public-site.repository'
import { WaIcon } from './wa-icon'

interface Props {
  tenant:     PublicTenant
  waPhone:    string | null
  tenantSlug: string
  backHref?:  string
}

export function PublicSiteHeader({ tenant, waPhone, tenantSlug, backHref }: Props) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const logoUrl = tenant.public_logo_url ?? tenant.logo_url
  const name    = tenant.public_name ?? tenant.name

  // El header es compartido por los dos rubros, y hasta el cierre de
  // food_service hablaba en inmobiliario para los dos: el nav decía
  // "Propiedades" apuntando a #properties —un ancla que en una carta no
  // existe— y el texto de WhatsApp ofrecía "información de propiedades" a
  // quien estaba mirando un menú.
  //
  // El rubro ya viaja en PublicTenant y ya se selecciona en getPublicTenant,
  // así que se deriva acá y ningún llamador cambia.
  //
  // Los dos destinos son anclas REALES, verificadas: #properties existe en
  // catalog-client.tsx y #menu en public-menu-client.tsx. Si mañana se agrega
  // un rubro, el default inmobiliario deja de ser correcto — por eso el
  // nombre de la variable es afirmativo y no un "else".
  const esGastronomico = tenant.vertical === 'food_service'

  const navLabel  = esGastronomico ? 'Menú'  : 'Propiedades'
  const navAnchor = esGastronomico ? '#menu' : '#properties'

  const waText = encodeURIComponent(
    esGastronomico
      ? `Hola, quiero hacer una consulta sobre ${name}.`
      : `Hola, quiero recibir información de propiedades de ${name}.`,
  )
  const waHref = waPhone ? `https://wa.me/${waPhone}?text=${waText}` : null

  return (
    <header
      className="sticky top-0 z-30 transition-shadow duration-200"
      style={{
        background:    'rgba(255,255,255,0.96)',
        backdropFilter: 'blur(10px)',
        boxShadow:     scrolled ? '0 2px 16px rgba(0,0,0,0.08)' : '0 1px 0 #e5e7eb',
      }}
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Logo + name */}
        <Link href={`/site/${tenantSlug}`} className="flex items-center gap-2.5 min-w-0">
          {logoUrl && (
            <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded-md">
              <Image src={logoUrl} alt={name} fill className="object-cover" />
            </div>
          )}
          <span className="font-semibold text-sm text-zinc-900 truncate">{name}</span>
        </Link>

        {/* Nav (desktop) */}
        <nav className="hidden md:flex items-center gap-6 text-sm text-zinc-600">
          {backHref ? (
            <Link
              href={backHref}
              className="hover:text-zinc-800 transition-colors flex items-center gap-1.5"
            >
              <span className="text-base" aria-hidden>←</span>
              {navLabel}
            </Link>
          ) : (
            <a href={navAnchor} className="hover:text-zinc-800 transition-colors">
              {navLabel}
            </a>
          )}
        </nav>

        {/* WA CTA */}
        {waHref && (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{ background: '#25D366' }}
            className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity flex-shrink-0"
          >
            <WaIcon className="h-4 w-4" />
            <span className="hidden sm:inline">WhatsApp</span>
          </a>
        )}
      </div>
    </header>
  )
}

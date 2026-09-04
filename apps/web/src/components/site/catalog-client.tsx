'use client'

import { useState, useMemo, useEffect } from 'react'
import Image from 'next/image'
import Link  from 'next/link'
import type { PublicTenant, PublicProperty } from '@/lib/repositories/public-site.repository'
import { getCommercialStatusLabel } from '@/lib/property-commercial-status'
import { PublicSiteHeader } from './public-site-header'
import { PublicSiteFooter } from './public-site-footer'
import { WaIcon } from './wa-icon'

const WA_GREEN = '#25D366'

// ── Constants ─────────────────────────────────────────────────────────────────

const OP_LABELS: Record<string, string> = {
  sale:             'Venta',
  long_term_rental: 'Alquiler',
  temporary_rental: 'Temporal',
}

const FILTER_OPTIONS = [
  { value: 'all',              label: 'Todas' },
  { value: 'sale',             label: 'Venta' },
  { value: 'long_term_rental', label: 'Alquiler' },
  { value: 'temporary_rental', label: 'Temporal' },
]

const SORT_OPTIONS = [
  { value: 'newest',        label: 'Más recientes' },
  { value: 'price_asc',     label: 'Menor precio' },
  { value: 'price_desc',    label: 'Mayor precio' },
  { value: 'area_desc',     label: 'Mayor superficie' },
  { value: 'capacity_desc', label: 'Mayor capacidad' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNumericPrice(p: PublicProperty): number | null {
  if (!p.show_price_public || p.pricing_mode === 'consult') return null
  if (p.operation_type === 'sale')             return p.sale_price
  if (p.operation_type === 'long_term_rental') return p.monthly_rent_price
  if (p.operation_type === 'temporary_rental') return p.base_price_per_night
  return null
}

function formatPrice(p: PublicProperty): string | null {
  if (!p.show_price_public || p.pricing_mode === 'consult') return null
  const fmt = (n: number) => Math.round(n).toLocaleString('es-AR')
  if (p.operation_type === 'sale' && p.sale_price)
    return `${p.currency} ${fmt(p.sale_price)}`
  if (p.operation_type === 'long_term_rental' && p.monthly_rent_price)
    return `${p.currency} ${fmt(p.monthly_rent_price)}/mes`
  if (p.operation_type === 'temporary_rental' && p.base_price_per_night)
    return `${p.currency} ${fmt(p.base_price_per_night)}/noche`
  return null
}

function buildWAHref(p: PublicProperty, phone: string | null): string {
  if (!phone) return '#'
  const isAvailable = p.commercial_status === 'available'
  let greeting: string
  if (!isAvailable) {
    greeting = 'Hola, quisiera consultar por propiedades similares disponibles:'
  } else {
    const hasPrice = !!formatPrice(p)
    greeting = !hasPrice
      ? 'Hola, quisiera consultar el precio de esta propiedad:'
      : p.operation_type === 'temporary_rental'
        ? 'Hola, quisiera consultar disponibilidad para:'
        : 'Hola, quiero consultar por esta propiedad:'
  }
  const lines = [greeting, '', p.title]
  if (p.public_code) lines.push(`Ref: ${p.public_code}`)
  return `https://wa.me/${phone}?text=${encodeURIComponent(lines.join('\n'))}`
}

// ── PropertyCard ──────────────────────────────────────────────────────────────

interface CardProps {
  property:   PublicProperty
  tenantSlug: string
  waPhone:    string | null
}

function PropertyCard({ property: p, tenantSlug, waPhone }: CardProps) {
  const imgUrl      = p.cover_image_url ?? p.images[0]?.image_url
  const price       = formatPrice(p)
  const waHref      = buildWAHref(p, waPhone)
  const label       = OP_LABELS[p.operation_type] ?? p.operation_type
  const href        = p.slug ? `/site/${tenantSlug}/properties/${p.slug}` : null
  const hasVids     = p.video_count > 0
  const isAvailable = p.commercial_status === 'available'

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">

      {/* ── Cover image ── */}
      <div className="relative aspect-[16/10] flex-shrink-0 overflow-hidden bg-zinc-100">
        {imgUrl ? (
          <Image
            src={imgUrl}
            alt={p.title}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-50">
            <svg className="h-14 w-14 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 32 32">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 28V14L16 4l12 10v14a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 30V20h8v10" />
            </svg>
          </div>
        )}

        {/* Operation badge */}
        <span
          style={{ background: 'var(--tenant-secondary)', color: 'white' }}
          className="absolute left-3 top-3 z-10 rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none"
        >
          {label}
        </span>

        {/* Commercial status badge — only when not available */}
        {!isAvailable && (
          <span className="absolute left-3 bottom-3 z-10 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold leading-none text-white">
            {getCommercialStatusLabel(p.commercial_status)}
          </span>
        )}

        {/* Video badge */}
        {hasVids && (
          <span className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] font-medium leading-none text-white">
            <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
            Video
          </span>
        )}
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 flex-col gap-3 p-4">

        {/* Title — stretched-link anchor makes the whole card clickable */}
        <div>
          {href ? (
            <Link
              href={href}
              className="line-clamp-2 text-sm font-semibold leading-snug text-zinc-900 transition-colors before:absolute before:inset-0 before:z-0 before:rounded-2xl hover:text-[color:var(--tenant-primary)]"
            >
              {p.title}
            </Link>
          ) : (
            <span className="line-clamp-2 text-sm font-semibold leading-snug text-zinc-900">{p.title}</span>
          )}

          {p.location_label && (
            <p className="mt-1 flex items-start gap-1 text-xs text-zinc-600">
              <svg className="mt-px h-3 w-3 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
              </svg>
              <span className="line-clamp-1">{p.location_label}</span>
            </p>
          )}
        </div>

        {/* Stats */}
        {(p.capacity || p.area_m2 || p.minimum_stay_nights > 1) && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            {p.capacity && (
              <span className="flex items-center gap-1">
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                </svg>
                {p.capacity} pers.
              </span>
            )}
            {p.area_m2 && (
              <span className="flex items-center gap-1">
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
                {p.area_m2} m²
              </span>
            )}
            {p.minimum_stay_nights > 1 && (
              <span>Mín. {p.minimum_stay_nights} noches</span>
            )}
          </div>
        )}

        {/* Price + availability chip + ref */}
        <div className="mt-auto space-y-1">
          {price ? (
            <p className="text-[15px] font-bold text-zinc-900">{price}</p>
          ) : (
            <p className="text-xs font-medium text-zinc-500">Precio a consultar</p>
          )}
          {p.operation_type === 'temporary_rental' && isAvailable && (
            <p className="flex items-center gap-1 text-[10px] text-zinc-500">
              <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden>
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 2v4M8 2v4M3 10h18" />
              </svg>
              Consultar disponibilidad
            </p>
          )}
          {p.public_code && (
            <p className="font-mono text-[10px] text-zinc-400">Ref: {p.public_code}</p>
          )}
        </div>

        {/* CTAs — relative z-10 to sit above the stretched-link pseudo-element */}
        <div className="flex gap-2 pt-1">
          {href && (
            <Link
              href={href}
              className="relative z-10 flex flex-1 items-center justify-center gap-1 rounded-xl border border-zinc-300 px-3 py-2 text-[11px] font-semibold text-zinc-800 transition-colors hover:bg-zinc-50"
            >
              Ver propiedad
            </Link>
          )}
          {waPhone && (
            <a
              href={waHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{ background: WA_GREEN }}
              className="relative z-10 flex flex-1 items-center justify-center gap-1 rounded-xl px-3 py-2 text-[11px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              <WaIcon className="h-3.5 w-3.5" />
              {isAvailable ? 'WhatsApp' : 'Ver alternativas'}
            </a>
          )}
        </div>
      </div>
    </article>
  )
}

// ── CatalogClient ─────────────────────────────────────────────────────────────

interface Props {
  tenant:     PublicTenant
  properties: PublicProperty[]
  waPhone:    string | null
  tenantSlug: string
}

export function CatalogClient({ tenant, properties, waPhone, tenantSlug }: Props) {
  const [op,     setOp]     = useState('all')
  const [search, setSearch] = useState('')
  const [sort,   setSort]   = useState('newest')

  // Initialize filter state from URL params on mount (no Suspense needed — purely client)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const opParam   = params.get('op')
    const qParam    = params.get('q')
    const sortParam = params.get('sort')
    if (opParam)   setOp(opParam)
    if (qParam)    setSearch(qParam)
    if (sortParam) setSort(sortParam)
  }, [])

  // Reflect filter state in URL without triggering a server navigation
  useEffect(() => {
    const params = new URLSearchParams()
    if (op !== 'all')      params.set('op', op)
    if (search.trim())     params.set('q', search.trim())
    if (sort !== 'newest') params.set('sort', sort)
    const qs  = params.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(null, '', url)
  }, [op, search, sort])

  const filtered = useMemo(() => {
    let list = properties

    if (op !== 'all') {
      list = list.filter(p => p.operation_type === op)
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(p =>
        p.title.toLowerCase().includes(q) ||
        (p.location_label?.toLowerCase().includes(q) ?? false) ||
        (p.description?.toLowerCase().includes(q) ?? false) ||
        (p.public_code?.toLowerCase().includes(q) ?? false) ||
        ((OP_LABELS[p.operation_type] ?? '').toLowerCase().includes(q)) ||
        p.custom_fields.some(f =>
          f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q)
        )
      )
    }

    if (sort === 'price_asc' || sort === 'price_desc') {
      list = [...list].sort((a, b) => {
        const pa = getNumericPrice(a); const pb = getNumericPrice(b)
        if (pa === null && pb === null) return 0
        if (pa === null) return 1
        if (pb === null) return -1
        return sort === 'price_asc' ? pa - pb : pb - pa
      })
    } else if (sort === 'area_desc') {
      list = [...list].sort((a, b) => {
        if (a.area_m2 === null && b.area_m2 === null) return 0
        if (a.area_m2 === null) return 1
        if (b.area_m2 === null) return -1
        return b.area_m2 - a.area_m2
      })
    } else if (sort === 'capacity_desc') {
      list = [...list].sort((a, b) => {
        if (a.capacity === null && b.capacity === null) return 0
        if (a.capacity === null) return 1
        if (b.capacity === null) return -1
        return b.capacity - a.capacity
      })
    }
    // 'newest' keeps the DB order (already sorted by created_at desc)

    return list
  }, [properties, op, search, sort])

  const hasFilters  = op !== 'all' || !!search.trim() || sort !== 'newest'
  const noProps     = properties.length === 0
  const noResults   = !noProps && filtered.length === 0

  const coverUrl    = tenant.public_cover_image_url
  const logoUrl     = tenant.public_logo_url ?? tenant.logo_url
  const displayName = tenant.public_name ?? tenant.name

  const heroWaText = encodeURIComponent(`Hola, quiero recibir información de propiedades de ${displayName}.`)
  const heroWaHref = waPhone ? `https://wa.me/${waPhone}?text=${heroWaText}` : null

  function clearFilters() {
    setOp('all')
    setSearch('')
    setSort('newest')
  }

  return (
    <div className="flex min-h-screen flex-col" style={{ background: '#F7F5EF' }}>
      <PublicSiteHeader tenant={tenant} waPhone={waPhone} tenantSlug={tenantSlug} />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden" style={{ minHeight: coverUrl ? '420px' : '260px' }}>
        {coverUrl ? (
          <>
            <Image src={coverUrl} alt={displayName} fill priority className="object-cover" sizes="100vw" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/25 to-black/10" />
          </>
        ) : (
          <div className="absolute inset-0" style={{ background: 'var(--tenant-primary-soft)' }} />
        )}

        <div
          className={`relative flex flex-col items-center justify-end px-6 pb-16 pt-12 text-center ${coverUrl ? 'text-white' : 'text-zinc-900'}`}
          style={{ minHeight: 'inherit' }}
        >
          {logoUrl && (
            <div className="relative mb-4 h-16 w-16 overflow-hidden rounded-xl border-2 border-white/30 shadow-md">
              <Image src={logoUrl} alt={displayName} fill className="object-cover" />
            </div>
          )}
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{displayName}</h1>
          {tenant.public_description && (
            <p className={`mt-2 max-w-xl text-base leading-relaxed ${coverUrl ? 'text-white/80' : 'text-zinc-600'}`}>
              {tenant.public_description}
            </p>
          )}
          {heroWaHref && (
            <a
              href={heroWaHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{ background: WA_GREEN }}
              className="mt-6 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              <WaIcon className="h-4 w-4" />
              Consultar por WhatsApp
            </a>
          )}
        </div>
      </section>

      {/* ── Filter block ─────────────────────────────────────────────────── */}
      <div id="properties" className="-mt-8 relative z-10 mx-auto w-full max-w-5xl px-4">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-md space-y-4">

          {/* Operation type tabs */}
          <div className="flex flex-wrap gap-2">
            {FILTER_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setOp(opt.value)}
                style={op === opt.value ? { background: 'var(--tenant-primary)', color: 'white' } : undefined}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  op === opt.value ? '' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Search + sort row */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {/* Search with icon */}
            <div className="relative flex-1">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                type="text"
                placeholder="Buscar por título, zona, referencia…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full rounded-xl border border-zinc-300 bg-zinc-50 py-2.5 pl-9 pr-3 text-sm text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-offset-0"
                style={{ '--tw-ring-color': 'var(--tenant-primary)' } as React.CSSProperties}
              />
            </div>
            {/* Sort */}
            <select
              value={sort}
              onChange={e => setSort(e.target.value)}
              aria-label="Ordenar por"
              className="rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-800 focus:outline-none focus:ring-2 focus:ring-offset-0 sm:w-48"
              style={{ '--tw-ring-color': 'var(--tenant-primary)' } as React.CSSProperties}
            >
              {SORT_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {hasFilters && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs text-zinc-600 underline transition-colors hover:text-zinc-900"
              >
                Limpiar filtros
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Properties ───────────────────────────────────────────────────── */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-8">

        {noProps ? (
          /* No properties published yet */
          <div className="flex flex-col items-center justify-center py-28 text-center">
            <svg className="mb-4 h-14 w-14 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <p className="text-base font-medium text-zinc-600">Todavía no hay propiedades publicadas.</p>
            {heroWaHref && (
              <a
                href={heroWaHref}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 text-sm underline transition-opacity hover:opacity-80"
                style={{ color: 'var(--tenant-primary)' }}
              >
                Consultar disponibilidad por WhatsApp
              </a>
            )}
          </div>

        ) : noResults ? (
          /* Filters produced no results */
          <div className="flex flex-col items-center justify-center py-28 text-center">
            <svg className="mb-4 h-12 w-12 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <p className="text-base font-medium text-zinc-600">No encontramos propiedades con esos filtros.</p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 rounded-full px-5 py-2 text-sm font-medium transition-opacity hover:opacity-80"
              style={{ background: 'var(--tenant-primary-soft)', color: 'var(--tenant-primary)' }}
            >
              Limpiar filtros
            </button>
          </div>

        ) : (
          <>
            {/* Results count */}
            <p className="mb-5 text-sm text-zinc-600">
              {filtered.length} propiedad{filtered.length !== 1 ? 'es' : ''}
              {hasFilters && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="underline transition-colors hover:text-zinc-900"
                  >
                    limpiar filtros
                  </button>
                </>
              )}
            </p>

            {/* Grid */}
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map(p => (
                <PropertyCard key={p.id} property={p} tenantSlug={tenantSlug} waPhone={waPhone} />
              ))}
            </div>
          </>
        )}
      </main>

      <PublicSiteFooter tenant={tenant} />
    </div>
  )
}

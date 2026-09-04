import { notFound }      from 'next/navigation'
import type { Metadata } from 'next'
import {
  getPublicTenant,
  getPublicPropertyBySlug,
  getPublicTenantWhatsApp,
} from '@/lib/repositories/public-site.repository'
import { getCommercialStatusLabel } from '@/lib/property-commercial-status'
import { PublicSiteHeader }      from '@/components/site/public-site-header'
import { PublicSiteFooter }      from '@/components/site/public-site-footer'
import { PublicPropertyGallery } from '@/components/site/public-property-gallery'
import { AvailabilityCalendar }  from '@/components/site/availability-calendar'
import { WaIcon }                from '@/components/site/wa-icon'
import { ShareButton }          from '@/components/site/share-button'

// WhatsApp brand green — not a tenant color
const WA_GREEN = '#25D366'

interface Props {
  params: Promise<{ tenantSlug: string; propertySlug: string }>
}

const OP_LABELS: Record<string, string> = {
  sale:             'Venta',
  long_term_rental: 'Alquiler',
  temporary_rental: 'Alquiler Temporal',
}

function formatPrice(
  p: NonNullable<Awaited<ReturnType<typeof getPublicPropertyBySlug>>>
): string | null {
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

// ── Metadata ──────────────────────────────────────────────────────────────────

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tenantSlug, propertySlug } = await params
  const tenant = await getPublicTenant(tenantSlug)
  if (!tenant || !tenant.public_site_enabled) return {}
  const property = await getPublicPropertyBySlug(tenant.id, propertySlug)
  if (!property) return {}

  const displayName    = tenant.public_name ?? tenant.name
  const pageTitle      = `${property.title} | ${displayName}`
  const description    = [
    property.location_label,
    property.description?.slice(0, 120),
  ].filter(Boolean).join(' — ') || `${OP_LABELS[property.operation_type] ?? property.operation_type} en ${displayName}`

  const siteUrl      = process.env.NEXT_PUBLIC_SITE_URL ?? ''
  const canonicalUrl = siteUrl
    ? `${siteUrl}/site/${tenantSlug}/properties/${propertySlug}`
    : undefined

  const ogImages = property.cover_image_url
    ? [{ url: property.cover_image_url, width: 1200, height: 630, alt: property.title }]
    : []

  return {
    title:      pageTitle,
    description,
    ...(canonicalUrl && { alternates: { canonical: canonicalUrl } }),
    openGraph: {
      title:       pageTitle,
      description,
      url:         canonicalUrl,
      type:        'website',
      images:      ogImages,
    },
    twitter: {
      card:        'summary_large_image',
      title:       pageTitle,
      description,
      images:      property.cover_image_url ? [property.cover_image_url] : [],
    },
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function PropertyDetailPage({ params }: Props) {
  const { tenantSlug, propertySlug } = await params
  const tenant = await getPublicTenant(tenantSlug)
  if (!tenant || !tenant.public_site_enabled) notFound()

  const [property, waPhone] = await Promise.all([
    getPublicPropertyBySlug(tenant.id, propertySlug),
    getPublicTenantWhatsApp(tenant.id),
  ])
  if (!property) notFound()

  const fmt         = (n: number) => Math.round(n).toLocaleString('es-AR')
  const price       = formatPrice(property)
  const isTemp      = property.operation_type === 'temporary_rental'
  const isLongTerm  = property.operation_type === 'long_term_rental'
  const isAvailable = property.commercial_status === 'available'

  const siteUrl     = process.env.NEXT_PUBLIC_SITE_URL ?? ''
  const propertyUrl = siteUrl
    ? `${siteUrl}/site/${tenantSlug}/properties/${propertySlug}`
    : null

  const waGreeting = !isAvailable
    ? 'Hola, quisiera consultar propiedades similares disponibles (vi esta propiedad):'
    : !price
      ? 'Hola, quisiera consultar el precio de esta propiedad:'
      : isTemp
        ? 'Hola, quisiera consultar disponibilidad para:'
        : 'Hola, quiero consultar por esta propiedad:'
  const waLines = [waGreeting, '', property.title]
  if (property.public_code)    waLines.push(`Ref: ${property.public_code}`)
  if (property.location_label) waLines.push(`📍 ${property.location_label}`)
  if (propertyUrl)             waLines.push('', propertyUrl)
  const waHref = waPhone
    ? `https://wa.me/${waPhone}?text=${encodeURIComponent(waLines.join('\n'))}`
    : null

  const showMapsLink =
    property.show_exact_address_public && !!property.google_maps_url

  return (
    <div className={`flex min-h-screen flex-col${waHref ? ' pb-20 md:pb-0' : ''}`} style={{ background: '#F7F5EF' }}>
      <PublicSiteHeader
        tenant={tenant}
        waPhone={waPhone}
        tenantSlug={tenantSlug}
        backHref={`/site/${tenantSlug}`}
      />

      {/* ── Gallery ──────────────────────────────────────────────────────── */}
      <div className="mx-auto w-full max-w-6xl px-4 pt-6">
        <PublicPropertyGallery
          images={property.images}
          videos={property.videos}
          coverUrl={property.cover_image_url}
          title={property.title}
        />
      </div>

      {/* ── Content + Sidebar ─────────────────────────────────────────────── */}
      <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:grid lg:grid-cols-[1fr_300px] lg:gap-10 lg:items-start">

        {/* ── Main column ─────────────────────────────────────────────────── */}
        <div className="space-y-8">

          {/* Title + badges + location */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                style={{ background: 'var(--tenant-secondary-soft)', color: 'var(--tenant-secondary)' }}
                className="rounded-full px-3 py-1 text-xs font-semibold"
              >
                {OP_LABELS[property.operation_type] ?? property.operation_type}
              </span>
              {!isAvailable && (
                <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-semibold text-white">
                  {getCommercialStatusLabel(property.commercial_status)}
                </span>
              )}
              {property.public_code && (
                <span className="rounded-full bg-zinc-100 px-3 py-1 font-mono text-[11px] text-zinc-500">
                  Ref: {property.public_code}
                </span>
              )}
              <ShareButton title={property.title} url={propertyUrl ?? ''} />
            </div>

            {/* Status notice for non-available properties */}
            {!isAvailable && (
              <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
                {property.commercial_status === 'rented' && (
                  <>Esta propiedad está actualmente <strong>alquilada</strong>. Podés consultar por otras opciones similares disponibles.</>
                )}
                {property.commercial_status === 'sold' && (
                  <>Esta propiedad ya fue <strong>vendida</strong>. Podés consultar por otras opciones similares disponibles.</>
                )}
                {property.commercial_status === 'paused' && (
                  <>Esta propiedad está <strong>pausada</strong> temporalmente. Podés consultar por otras opciones similares disponibles.</>
                )}
              </div>
            )}

            <h1 className="mt-3 text-2xl font-bold leading-tight text-zinc-900 md:text-3xl">
              {property.title}
            </h1>

            {/* Location + maps link — inline */}
            {property.location_label && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="flex items-center gap-1.5 text-zinc-600">
                  <svg className="h-4 w-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
                  </svg>
                  <span>{property.location_label}</span>
                </p>
                {showMapsLink && (
                  <a
                    href={property.google_maps_url!}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color:       'var(--tenant-primary)',
                      background:  'var(--tenant-primary-soft)',
                      borderColor: 'var(--tenant-primary)',
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-opacity-20 px-2.5 py-0.5 text-xs font-medium hover:opacity-80 transition-opacity"
                  >
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    Ver ubicación
                  </a>
                )}
              </div>
            )}

            {/* Exact address (only when explicitly enabled) */}
            {property.show_exact_address_public && property.internal_address && (
              <p className="mt-1 pl-5 text-sm text-zinc-500">{property.internal_address}</p>
            )}
          </div>

          {/* Highlights grid */}
          {(property.capacity || property.area_m2 ||
            (isTemp && (property.check_in_time || property.check_out_time ||
              property.minimum_stay_nights > 1 || property.cleaning_fee > 0))
          ) && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {property.capacity && (
                <div
                  className="rounded-xl border border-zinc-100 bg-white p-4 text-center shadow-sm"
                  style={{ borderTop: '2px solid var(--tenant-primary)' }}
                >
                  <p className="text-2xl font-bold text-zinc-900">{property.capacity}</p>
                  <p className="mt-0.5 text-xs text-zinc-600">personas</p>
                </div>
              )}
              {property.area_m2 && (
                <div
                  className="rounded-xl border border-zinc-100 bg-white p-4 text-center shadow-sm"
                  style={{ borderTop: '2px solid var(--tenant-primary)' }}
                >
                  <p className="text-2xl font-bold text-zinc-900">{property.area_m2}</p>
                  <p className="mt-0.5 text-xs text-zinc-600">m²</p>
                </div>
              )}
              {isTemp && property.minimum_stay_nights > 1 && (
                <div
                  className="rounded-xl border border-zinc-100 bg-white p-4 text-center shadow-sm"
                  style={{ borderTop: '2px solid var(--tenant-primary)' }}
                >
                  <p className="text-2xl font-bold text-zinc-900">{property.minimum_stay_nights}</p>
                  <p className="mt-0.5 text-xs text-zinc-600">noches mín.</p>
                </div>
              )}
              {isTemp && property.check_in_time && (
                <div
                  className="rounded-xl border border-zinc-100 bg-white p-4 text-center shadow-sm"
                  style={{ borderTop: '2px solid var(--tenant-primary)' }}
                >
                  <p className="text-lg font-bold text-zinc-900">{String(property.check_in_time).slice(0, 5)}</p>
                  <p className="mt-0.5 text-xs text-zinc-600">check-in</p>
                </div>
              )}
              {isTemp && property.check_out_time && (
                <div
                  className="rounded-xl border border-zinc-100 bg-white p-4 text-center shadow-sm"
                  style={{ borderTop: '2px solid var(--tenant-primary)' }}
                >
                  <p className="text-lg font-bold text-zinc-900">{String(property.check_out_time).slice(0, 5)}</p>
                  <p className="mt-0.5 text-xs text-zinc-600">check-out</p>
                </div>
              )}
              {isTemp && property.cleaning_fee > 0 && (
                <div
                  className="rounded-xl border border-zinc-100 bg-white p-4 text-center shadow-sm"
                  style={{ borderTop: '2px solid var(--tenant-primary)' }}
                >
                  <p className="text-base font-bold text-zinc-900">
                    {property.currency} {fmt(property.cleaning_fee)}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-600">limpieza</p>
                </div>
              )}
            </div>
          )}

          {/* Description */}
          {property.description && (
            <div className="rounded-2xl border border-zinc-100 bg-white p-6 shadow-sm">
              <h2 className="mb-3 font-semibold text-zinc-900">Descripción</h2>
              <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-600">
                {property.description}
              </p>
            </div>
          )}

          {/* Custom fields as pills */}
          {property.custom_fields.length > 0 && (
            <div>
              <h2 className="mb-3 font-semibold text-zinc-900">Características</h2>
              <div className="flex flex-wrap gap-2">
                {property.custom_fields.map((f, i) => (
                  <span
                    key={i}
                    style={{ background: 'var(--tenant-secondary-soft)', color: 'var(--tenant-secondary)' }}
                    className="rounded-full px-3 py-1.5 text-xs font-medium"
                  >
                    {f.key}: {f.value}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Availability calendar (temporary rentals only) */}
          {isTemp && property.slug && (
            <div className="rounded-2xl border border-zinc-100 bg-white p-6 shadow-sm">
              <AvailabilityCalendar
                tenantSlug={tenantSlug}
                propertySlug={property.slug}
                propertyTitle={property.title}
                publicCode={property.public_code}
                minimumStay={property.minimum_stay_nights}
                capacityMax={property.capacity}
                checkInTime={property.check_in_time}
                checkOutTime={property.check_out_time}
                waPhone={waPhone}
              />
            </div>
          )}
        </div>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="mt-8 lg:mt-0 lg:sticky lg:top-20">
          <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm space-y-5">
            {/* Price */}
            <div className="space-y-1">
              {price ? (
                <p className="text-2xl font-bold text-zinc-900">{price}</p>
              ) : (
                <p className="text-base font-medium text-zinc-500">Precio a consultar</p>
              )}
              {isLongTerm && property.expenses_amount && (
                <p className="text-sm text-zinc-600">
                  + Expensas: {property.currency} {fmt(property.expenses_amount)}/mes
                </p>
              )}
              {isTemp && property.cleaning_fee > 0 && (
                <p className="text-sm text-zinc-600">
                  + Limpieza: {property.currency} {fmt(property.cleaning_fee)}
                </p>
              )}
              {isTemp && property.temporary_price_notes && (
                <p className="text-xs text-zinc-500 pt-1">{property.temporary_price_notes}</p>
              )}
              {isLongTerm && property.long_term_price_notes && (
                <p className="text-xs text-zinc-500 pt-1">{property.long_term_price_notes}</p>
              )}
            </div>

            {isTemp && (
              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden>
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 2v4M8 2v4M3 10h18" />
                </svg>
                Disponibilidad según fechas
              </div>
            )}

            {property.public_code && (
              <p className="font-mono text-xs text-zinc-400">Ref: {property.public_code}</p>
            )}

            <hr className="border-zinc-200" />

            {waHref ? (
              <>
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ background: WA_GREEN }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 font-semibold text-white hover:opacity-90 transition-opacity"
                >
                  <WaIcon className="h-5 w-5" />
                  {isAvailable ? 'Consultar por WhatsApp' : 'Consultar alternativas'}
                </a>
                <p className="text-center text-[11px] text-zinc-500">
                  {!isAvailable
                    ? 'Te asesoraremos con propiedades similares disponibles.'
                    : !price
                      ? 'Incluirá referencia, ubicación y consulta de precio.'
                      : isTemp
                        ? 'Incluirá referencia y consulta de disponibilidad.'
                        : 'La consulta incluirá referencia y ubicación.'}
                </p>
              </>
            ) : (
              <p className="text-center text-sm text-zinc-500">No hay WhatsApp configurado.</p>
            )}
          </div>
        </aside>
      </div>

      {/* ── Mobile sticky CTA ─────────────────────────────────────────── */}
      {waHref && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur-sm md:hidden"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold leading-tight text-zinc-900">
              {price ?? 'Precio a consultar'}
            </p>
            <p className="text-[11px] leading-tight text-zinc-500">
              {OP_LABELS[property.operation_type] ?? property.operation_type}
            </p>
          </div>
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{ background: WA_GREEN }}
            className="flex shrink-0 items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            <WaIcon className="h-5 w-5" />
            {isAvailable ? 'Consultar' : 'Alternativas'}
          </a>
        </div>
      )}

      <PublicSiteFooter tenant={tenant} />
    </div>
  )
}

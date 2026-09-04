import { notFound }       from 'next/navigation'
import type { Metadata }  from 'next'
import { getPublicTenant, listPublicProperties, getPublicTenantWhatsApp } from '@/lib/repositories/public-site.repository'
import { CatalogClient }  from '@/components/site/catalog-client'

interface Props {
  params: Promise<{ tenantSlug: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tenantSlug } = await params
  const tenant = await getPublicTenant(tenantSlug)
  if (!tenant || !tenant.public_site_enabled) return {}

  const displayName = tenant.public_name ?? tenant.name
  const title       = `${displayName} | Propiedades`
  const description = tenant.public_description ?? `Propiedades de ${displayName}`
  const ogImage     = tenant.public_cover_image_url ?? tenant.logo_url ?? null

  const siteUrl      = process.env.NEXT_PUBLIC_SITE_URL ?? ''
  const canonicalUrl = siteUrl ? `${siteUrl}/site/${tenantSlug}` : undefined

  return {
    title,
    description,
    ...(canonicalUrl && { alternates: { canonical: canonicalUrl } }),
    openGraph: {
      title,
      description,
      url:    canonicalUrl,
      type:   'website',
      images: ogImage ? [{ url: ogImage }] : [],
    },
    twitter: {
      card:        'summary_large_image',
      title,
      description,
      images:      ogImage ? [ogImage] : [],
    },
  }
}

export default async function PublicCatalogPage({ params }: Props) {
  const { tenantSlug } = await params
  const tenant = await getPublicTenant(tenantSlug)
  if (!tenant || !tenant.public_site_enabled) notFound()

  const [properties, waPhone] = await Promise.all([
    listPublicProperties(tenant.id),
    getPublicTenantWhatsApp(tenant.id),
  ])

  return (
    <CatalogClient
      tenant={tenant}
      properties={properties}
      waPhone={waPhone}
      tenantSlug={tenantSlug}
    />
  )
}

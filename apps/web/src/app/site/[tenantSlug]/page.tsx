import { notFound }       from 'next/navigation'
import { randomUUID }     from 'node:crypto'
import type { Metadata }  from 'next'
import { tenantVerticalSchema } from '@orderflow/validators'
import {
  getPublicTenant,
  getPublicTenantCurrency,
  listPublicMenu,
  listPublicProperties,
  getPublicTenantWhatsApp,
  getTenantAutoResponderWhatsApp,
} from '@/lib/repositories/public-site.repository'
import { publicSiteTitle, publicSiteDescription } from '@/lib/site/public-menu'
import { CatalogClient }     from '@/components/site/catalog-client'
import { PublicMenuClient }  from '@/components/site/public-menu-client'

interface Props {
  params: Promise<{ tenantSlug: string }>
}

// Fase 3E-C3A2 — el sitio público ramifica por RUBRO.
//
// Hasta acá esta página renderizaba SIEMPRE el catálogo inmobiliario, para
// cualquier tenant. Un restaurante obtenía un título "<Nombre> | Propiedades",
// filtros de Venta/Alquiler/Temporal y cero tarjetas.
//
// El rubro se resuelve SERVER-SIDE desde tenants.vertical. No se usa
// requireRouteVertical: ese guard es del dashboard y trabaja sobre el tenant del
// usuario AUTENTICADO. Acá no hay sesión — el tenant sale del slug público.
//
// Un valor inesperado cae en 'real_estate', el mismo default conservador que ya
// usaban getPublicTenant() y /api/public/forms. La columna es NOT NULL con CHECK
// de dos valores, así que en la práctica no ocurre.
function verticalDe(raw: unknown): 'real_estate' | 'food_service' {
  const parsed = tenantVerticalSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'real_estate'
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tenantSlug } = await params
  const tenant = await getPublicTenant(tenantSlug)
  // getPublicTenant ya exige public_site_enabled, tenant no borrado y status
  // trial/active. Se mantiene el chequeo explícito por si alguna vez deja de
  // hacerlo: un sitio deshabilitado no publica metadata.
  if (!tenant || !tenant.public_site_enabled) return {}

  const displayName = tenant.public_name ?? tenant.name
  const vertical    = verticalDe(tenant.vertical)

  // Un restaurante no tiene "Propiedades". El copy sale del MISMO módulo que
  // usa el render, así el título de la metadata y el de la página no pueden
  // divergir.
  const title       = publicSiteTitle(displayName, vertical)
  const description = tenant.public_description ?? publicSiteDescription(displayName, vertical)

  const ogImage = tenant.public_cover_image_url ?? tenant.logo_url ?? null

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

export default async function PublicSitePage({ params }: Props) {
  const { tenantSlug } = await params
  const tenant = await getPublicTenant(tenantSlug)

  // Sin cambios respecto de antes: public_site_enabled sigue siendo la misma
  // puerta para los dos rubros, y no hay bypass por vertical.
  if (!tenant || !tenant.public_site_enabled) notFound()

  const waPhone = await getPublicTenantWhatsApp(tenant.id)

  if (verticalDe(tenant.vertical) === 'food_service') {
    const [categories, currency, autoResponderPhone] = await Promise.all([
      listPublicMenu(tenant.id),
      getPublicTenantCurrency(tenant.id),
      // Fase 3E-C3B1 — a dónde sigue la conversación después de enviar el
      // pedido. Es la cuenta AutoResponder, que puede no existir: entonces el
      // formulario muestra la referencia y nada más, nunca un link inventado.
      getTenantAutoResponderWhatsApp(tenant.id),
    ])

    return (
      <PublicMenuClient
        tenant={tenant}
        categories={categories}
        currency={currency}
        waPhone={waPhone}
        tenantSlug={tenantSlug}
        // Una clave por carga de página. El carrito la renueva recién después
        // de un pedido exitoso, para que los reintentos compartan clave (§9).
        idempotencyKey={randomUUID()}
        whatsappNumber={autoResponderPhone}
      />
    )
  }

  // real_estate — EXACTAMENTE el comportamiento anterior.
  const properties = await listPublicProperties(tenant.id)

  return (
    <CatalogClient
      tenant={tenant}
      properties={properties}
      waPhone={waPhone}
      tenantSlug={tenantSlug}
    />
  )
}

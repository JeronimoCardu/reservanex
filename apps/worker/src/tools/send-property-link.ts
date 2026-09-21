import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'
import { customerSiteUrl, PUBLIC_PATHS } from '../lib/customer-site-url'

export const sendPropertyLinkTool: LLMTool = {
  type: 'function',
  function: {
    name: 'send_property_link',
    description:
      'Envía al cliente el link público de una propiedad específica o del catálogo general. ' +
      'Pasá property_id cuando el bot recomiende o mencione una propiedad concreta con ID conocido. ' +
      'Si la propiedad está publicada, envía el link directo; si no, envía el catálogo. ' +
      'Sin property_id: envía el catálogo general. ' +
      'NUNCA inventes URLs — siempre usá esta herramienta.',
    parameters: {
      type:       'object',
      properties: {
        property_id: {
          type:        'string',
          description: 'ID de la propiedad (obtenelo de search_properties_for_reservation). Omitir para enviar el catálogo general.',
        },
      },
      required:             [],
      additionalProperties: false,
    },
  },
}

export async function executeSendPropertyLink(
  tenantId: string,
  rawArgs:  Record<string, unknown>,
): Promise<string> {
  const supabase    = createClient()
  const propertyId  = typeof rawArgs['property_id'] === 'string' ? rawArgs['property_id'] : null

  const { data: tenant } = await supabase
    .from('tenants')
    .select('slug, public_slug, public_site_enabled')
    .eq('id', tenantId)
    .maybeSingle()

  if (!tenant?.public_site_enabled) {
    return JSON.stringify({ error: 'El sitio público no está habilitado para este tenant.' })
  }

  const tenantSlug = tenant.public_slug ?? tenant.slug
  if (!tenantSlug) {
    return JSON.stringify({ error: 'No se pudo construir el link: tenant sin slug configurado.' })
  }

  // Nunca localhost hacia un cliente: sin base alcanzable, no hay link.
  const catalogUrl = customerSiteUrl(PUBLIC_PATHS.site(tenantSlug))
  if (!catalogUrl) {
    return JSON.stringify({ error: 'No hay una URL pública alcanzable configurada. No mandes ningún link; derivá a una persona con escalate_to_human.' })
  }

  if (propertyId) {
    const { data: property } = await supabase
      .from('properties')
      .select('slug, published')
      .eq('id', propertyId)
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .maybeSingle()

    if (property?.published && property?.slug) {
      const url = customerSiteUrl(PUBLIC_PATHS.property(tenantSlug, property.slug))!
      console.log('[send_property_link] property link', { tenantId, propertyId, url })
      return `Podés ver fotos, videos y detalles completos acá:\n${url}`
    }

    // Property not published or no slug → fallback to catalog
    console.log('[send_property_link] property not published/no slug — using catalog', { tenantId, propertyId })
  }

  console.log('[send_property_link] catalog link', { tenantId, tenantSlug, catalogUrl })
  return `Podés ver más propiedades acá:\n${catalogUrl}`
}

import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'

export const sendPublicCatalogLinkTool: LLMTool = {
  type: 'function',
  function: {
    name: 'send_public_catalog_link',
    description:
      'Envía al cliente el link al catálogo público del tenant donde puede ver todas las propiedades disponibles. ' +
      'Usá esta herramienta cuando el cliente pide ver las propiedades, el catálogo, las fotos, disponibles, o más información. ' +
      'No requiere parámetros.',
    parameters: {
      type:                 'object',
      properties:           {},
      required:             [],
      additionalProperties: false,
    },
  },
}

export async function executeSendPublicCatalogLink(
  tenantId: string,
  _rawArgs: Record<string, unknown>,
): Promise<string> {
  const supabase = createClient()

  const { data: tenant } = await supabase
    .from('tenants')
    .select('slug, public_slug')
    .eq('id', tenantId)
    .single()

  if (!tenant?.slug) {
    return JSON.stringify({ error: 'No se pudo construir el link: tenant sin slug configurado.' })
  }

  const siteBase = (
    process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'https://reservanex.com'
  ).replace(/\/$/, '')

  const tenantSlug = tenant.public_slug ?? tenant.slug
  const url        = `${siteBase}/site/${tenantSlug}`

  console.log('[send_public_catalog_link]', { tenantId, tenantSlug, url })

  return `Podés ver todas nuestras propiedades acá: ${url}`
}

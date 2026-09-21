import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'
import { customerSiteUrl, PUBLIC_PATHS } from '../lib/customer-site-url'

// El link al sitio público del tenant. Para una inmobiliaria es el catálogo de
// propiedades; para un restaurante es la carta. La descripción que ve el
// modelo y el texto que devuelve hablan del rubro correcto — hasta acá ambos
// decían "propiedades" para todos.
//
// Y para gastronomía hay una autoridad más: si la carta no tiene productos
// publicados, el tool NO manda el link. Ofrecer "todos los platos y precios"
// a un cliente cuando hay cero es inventar, aunque la URL exista.

export const sendPublicCatalogLinkTool: LLMTool = {
  type: 'function',
  function: {
    name: 'send_public_catalog_link',
    description:
      'Envía al cliente el link al sitio público del negocio: el catálogo de propiedades (inmobiliaria) o la carta con productos y precios (gastronomía). ' +
      'Usá esta herramienta cuando el cliente pide ver las propiedades / la carta, precios, fotos, disponibles, o más información. ' +
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
    .select('slug, public_slug, vertical, public_site_enabled')
    .eq('id', tenantId)
    .single()

  if (!tenant?.slug) {
    return JSON.stringify({ error: 'No se pudo construir el link: tenant sin slug configurado.' })
  }
  if (tenant.public_site_enabled === false) {
    return JSON.stringify({ error: 'El sitio público no está habilitado. Derivá a una persona con escalate_to_human.' })
  }

  const food = tenant.vertical === 'food_service'

  if (food) {
    // La consulta mínima autoritativa: ¿hay algo publicado? Mismo criterio
    // que el catálogo público (published AND deleted_at IS NULL).
    const { count } = await supabase
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('published', true)
      .is('deleted_at', null)
    if ((count ?? 0) === 0) {
      return JSON.stringify({
        error: 'La carta todavía no tiene productos publicados. NO mandes el link ni digas que hay platos o precios: decile al cliente que la carta aún no está disponible y ofrecé derivarlo a una persona.',
      })
    }
  }

  const url = customerSiteUrl(PUBLIC_PATHS.site(tenant.public_slug ?? tenant.slug))
  if (!url) {
    return JSON.stringify({ error: 'No hay una URL pública alcanzable configurada. No mandes ningún link; derivá a una persona con escalate_to_human.' })
  }

  console.log('[send_public_catalog_link]', { tenantId, food, url })

  return food
    ? `Acá tenés nuestra carta con los productos y precios: ${url}`
    : `Podés ver todas nuestras propiedades acá: ${url}`
}

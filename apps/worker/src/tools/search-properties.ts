import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'

export const searchPropertiesTool: LLMTool = {
  type: 'function',
  function: {
    name: 'search_properties',
    description:
      'Busca propiedades disponibles para el cliente según ciudad, capacidad y precio máximo. ' +
      'Úsala cuando el cliente pregunte por propiedades, disponibilidad o precios.',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type:        'string',
          description: 'Ciudad donde buscar (ej: "Buenos Aires", "Córdoba")',
        },
        guests: {
          type:        'integer',
          description: 'Número mínimo de personas que debe alojar la unidad',
          minimum:     1,
        },
        max_price: {
          type:        'number',
          description: 'Precio máximo por noche en la moneda de la propiedad',
        },
      },
      required:             [],
      additionalProperties: false,
    },
  },
}

interface SearchArgs {
  city?:      string
  guests?:    number
  max_price?: number
}

interface UnitResult {
  name:     string
  capacity: number
  price:    number | null
  currency: string
  active:   boolean
}

interface PropertyResult {
  title:             string
  slug:              string | null
  public_code:       string | null
  city:              string | null
  neighborhood:      string | null
  location_label:    string | null
  description:       string | null
  operation_type:    string
  show_price_public: boolean
  units:             UnitResult[]
}

export async function executeSearchProperties(
  tenantId: string,
  rawArgs:  Record<string, unknown>,
): Promise<string> {
  const args: SearchArgs = {
    city:      typeof rawArgs['city']      === 'string' ? rawArgs['city']      : undefined,
    guests:    typeof rawArgs['guests']    === 'number' ? rawArgs['guests']    : undefined,
    max_price: typeof rawArgs['max_price'] === 'number' ? rawArgs['max_price'] : undefined,
  }

  const supabase = createClient()

  let query = supabase
    .from('properties')
    .select('title, slug, public_code, description, city, neighborhood, location_label, operation_type, show_price_public, units(name, capacity, price, currency, active)')
    .eq('tenant_id', tenantId)
    .eq('published', true)
    .eq('commercial_status', 'available')
    .is('deleted_at', null)
    .limit(10)

  if (args.city) {
    query = query.ilike('city', `%${args.city}%`)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`[search_properties] DB error: ${error.message}`)
  }

  const rows = (data ?? []) as unknown as PropertyResult[]

  const results = rows
    .map((p) => ({
      ...p,
      units: (p.units ?? []).filter((u) => {
        if (!u.active)                                                                      return false
        if (args.guests    !== undefined && u.capacity < args.guests)                       return false
        if (args.max_price !== undefined && u.price !== null && u.price > args.max_price)   return false
        return true
      }),
    }))
    .filter((p) => p.units.length > 0)
    .slice(0, 5)

  if (results.length === 0) {
    return 'No se encontraron propiedades que coincidan con los criterios. No hay alternativas disponibles. No menciones zonas, barrios ni propiedades que no estén en estos resultados.'
  }

  const lines = results.map((p, i) => {
    const location = [p.location_label ?? p.city, p.neighborhood].filter(Boolean).join(', ')
    const unitLines = p.units
      .map((u) => {
        const showPrice = p.show_price_public && u.price !== null
        const price = showPrice ? `${u.price} ${u.currency}/noche` : 'precio a consultar'
        return `  • ${u.name}: hasta ${u.capacity} persona(s), ${price}`
      })
      .join('\n')
    const desc    = p.description ? `\n  "${p.description.slice(0, 100)}"` : ''
    const refLine = p.public_code ? `\n  Ref: ${p.public_code}` : ''
    const slugLine = p.slug       ? `\n  slug: ${p.slug}` : ''
    return `${i + 1}. ${p.title}${location ? ` (${location})` : ''}\n${unitLines}${desc}${refLine}${slugLine}`
  })

  return `Encontré ${results.length} propiedad(es):\n\n${lines.join('\n\n')}`
}

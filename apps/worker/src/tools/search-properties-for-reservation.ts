import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'

// ── Tool schema ────────────────────────────────────────────────────────────────

export const searchPropertiesForReservationTool: LLMTool = {
  type: 'function',
  function: {
    name: 'search_properties_for_reservation',
    description:
      'Busca propiedades del tenant por zona, dirección, tipo o título. ' +
      'Soporta tres tipos de operación: venta (sale), alquiler mensual (long_term_rental) y alquiler temporal (temporary_rental). ' +
      'SIEMPRE llamá esta herramienta cuando el cliente mencione comprar, alquilar, reservar, una propiedad o una zona. ' +
      'NUNCA digas que no hay propiedades sin haber llamado primero. ' +
      'Devuelve property_id y operation_type para usar en check_property_availability y create_pending_reservation.',
    parameters: {
      type:       'object',
      properties: {
        query: {
          type:        'string',
          description:
            'Texto con zona, ciudad, dirección, tipo o nombre de propiedad que mencionó el cliente. ' +
            'Ej: "san andres de giles", "mendez 1512", "casa en palermo", "depto centro".',
        },
        operation_type: {
          type:        'string',
          enum:        ['sale', 'long_term_rental', 'temporary_rental'],
          description:
            'Tipo de operación que busca el cliente. ' +
            '"sale": el cliente quiere COMPRAR. ' +
            '"long_term_rental": quiere ALQUILAR PARA VIVIR (por mes). ' +
            '"temporary_rental": quiere ALOJAMIENTO POR NOCHES/DÍAS. ' +
            'Omitir si no está claro.',
        },
        guests: {
          type:        'integer',
          description: 'Cantidad de personas declarada por el cliente. Omitir si no la mencionó.',
          minimum:     1,
        },
        include_alternatives: {
          type:        'boolean',
          description:
            'Pasar true SOLO si el cliente explícitamente pidió ver propiedades en otras zonas o ciudades. ' +
            'Por defecto false — sin esto solo se devuelven propiedades que coinciden con la zona pedida.',
        },
      },
      required:             ['query'],
      additionalProperties: false,
    },
  },
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PropertyRow {
  id:                   string
  title:                string
  description:          string | null
  city:                 string | null
  neighborhood:         string | null
  location_label:       string | null
  internal_address:     string | null
  capacity:             number | null
  area_m2:              number | null
  custom_fields:        unknown
  commercial_status:    string
  pricing_mode:         string
  currency:             string
  base_price_per_night: number | null
  minimum_stay_nights:  number
  public_code:          string | null
  slug:                 string | null
  show_price_public:    boolean
  operation_type:       string
  sale_price:           number | null
  monthly_rent_price:   number | null
  expenses_amount:      number | null
}

export interface PropertyCandidate {
  property_id:          string
  title:                string
  slug:                 string | null
  location_label:       string | null
  city:                 string | null
  neighborhood:         string | null
  description_short:    string | null
  capacity_max:         number | null
  area_m2:              number | null
  custom_fields:        Array<{ key: string; value: string }> | null
  commercial_status:    string
  pricing_mode:         string
  currency:             string
  base_price_per_night: number | null
  minimum_stay_nights:  number
  public_code:          string | null
  operation_type:       string
  sale_price:           number | null
  monthly_rent_price:   number | null
  expenses_amount:      number | null
  match_reasons:        string[]
}

interface SearchArgs {
  query:                 string
  operation_type?:       'sale' | 'long_term_rental' | 'temporary_rental'
  guests?:               number
  include_alternatives?: boolean
}

// ── Normalization ──────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/ç/g, 'c')
}

// ── Intent extraction ──────────────────────────────────────────────────────────

// Words that describe what the client wants to DO — never a location or property type.
const OPERATION_WORDS = new Set([
  'alquilar', 'alquilo', 'alquiler', 'alquila',
  'vender', 'venta', 'vendo', 'vende',
  'comprar', 'compro', 'compra',
  'reservar', 'reserva', 'reservo', 'reservaria',
  'busco', 'buscar', 'busca', 'buscando',
  'necesito', 'necesita', 'necesitar',
  'quiero', 'quiere', 'quisiera', 'queremos',
  'consulto', 'consultar', 'consulta',
  'tengo', 'tiene', 'tener',
  'hay', 'haya', 'seria',
])

// Generic Spanish stop words — not location, not type.
const STOP_WORDS = new Set([
  'a', 'al', 'de', 'del', 'el', 'en', 'es', 'la', 'las', 'le', 'lo', 'los',
  'me', 'mi', 'no', 'o', 'se', 'si', 'su', 'te', 'tu', 'un', 'una', 'y',
  'ya', 'yo', 'que', 'son', 'por', 'con', 'para', 'les',
  'este', 'esta', 'ese', 'esa', 'mas', 'muy', 'bien', 'pero', 'cuando', 'como',
  // Real-estate context modifiers (not location, not type)
  'propiedad', 'propiedades', 'inmueble', 'inmuebles',
  'temporal', 'temporario', 'vacacional', 'temporada',
  'disponible', 'disponibles', 'cerca', 'zona',
])

// Maps normalized token → canonical property type label.
const PROPERTY_TYPE_MAP: Record<string, string> = {
  casa: 'casa', casas: 'casa', casita: 'casa',
  departamento: 'departamento', departamentos: 'departamento',
  depto: 'departamento', deptos: 'departamento',
  apartamento: 'departamento', apartamentos: 'departamento',
  apart: 'departamento',
  cabana: 'cabaña', cabanas: 'cabaña',
  chalet: 'chalet', chaletes: 'chalet',
  suite: 'suite', hotel: 'hotel',
  ph: 'ph', penthouse: 'ph',
  local: 'local', oficina: 'oficina',
  duplex: 'duplex', loft: 'loft',
  monoambiente: 'monoambiente', studio: 'studio',
  villa: 'villa',
}

interface SearchIntent {
  /** Tokens that identify the requested zone/address (used for hard filter). */
  locationTokens: string[]
  /** Canonical property type if detected — used only for sort priority, not filtering. */
  typeHint: string | null
  /** Normalized full query for logging. */
  rawQuery: string
}

/**
 * Extracts location tokens and an optional property-type hint from the query.
 *
 * After removing operation words, stop words, and type words, what remains is
 * assumed to be zone/address tokens. These are used for the location hard filter.
 */
function extractIntent(query: string): SearchIntent {
  const rawQuery = normalize(query)
  const tokens   = rawQuery.split(/[\s,.\-;:!?/()\[\]]+/)

  const locationTokens: string[] = []
  let   typeHint: string | null  = null

  for (const tok of tokens) {
    if (tok.length < 2) continue
    if (OPERATION_WORDS.has(tok)) continue
    if (STOP_WORDS.has(tok)) continue

    const propType = PROPERTY_TYPE_MAP[tok]
    if (propType) {
      if (!typeHint) typeHint = propType
      continue
    }

    if (tok.length >= 3) locationTokens.push(tok)
  }

  return { locationTokens, typeHint, rawQuery }
}

// ── Scoring helpers ────────────────────────────────────────────────────────────

/**
 * Counts how many tokens appear in the property's location fields ONLY.
 * Excludes description — it's unreliable for zone classification.
 */
function scoreLocation(tokens: string[], p: PropertyRow): number {
  if (tokens.length === 0) return 0
  const text = normalize([
    p.title,
    p.city,
    p.neighborhood,
    p.location_label,
    p.internal_address,
  ].filter(Boolean).join(' '))
  return tokens.filter(tok => text.includes(tok)).length
}

/**
 * Returns 1 if the property's title or description contains the requested type,
 * 0 otherwise.  Only affects sort order — not filtering.
 */
function scoreType(typeHint: string | null, p: PropertyRow): number {
  if (!typeHint) return 0
  const text = normalize([p.title, p.description].filter(Boolean).join(' '))
  for (const [key, type] of Object.entries(PROPERTY_TYPE_MAP)) {
    if (type === typeHint && text.includes(key)) return 1
  }
  return 0
}

function buildCandidate(p: PropertyRow, matchReasons: string[]): PropertyCandidate {
  return {
    property_id:          p.id,
    title:                p.title,
    slug:                 p.slug ?? null,
    location_label:       p.location_label,
    city:                 p.city,
    neighborhood:         p.neighborhood,
    description_short:    p.description ? p.description.slice(0, 120) : null,
    capacity_max:         p.capacity,
    area_m2:              p.area_m2,
    custom_fields:        Array.isArray(p.custom_fields)
      ? (p.custom_fields as Array<{ key: string; value: string }>)
      : null,
    commercial_status:    p.commercial_status,
    pricing_mode:         p.pricing_mode,
    currency:             p.currency,
    // Null-out prices when tenant has disabled public price display
    base_price_per_night: p.show_price_public ? p.base_price_per_night : null,
    sale_price:           p.show_price_public ? p.sale_price           : null,
    monthly_rent_price:   p.show_price_public ? p.monthly_rent_price   : null,
    expenses_amount:      p.show_price_public ? p.expenses_amount      : null,
    minimum_stay_nights:  p.minimum_stay_nights,
    public_code:          p.public_code,
    operation_type:       p.operation_type,
    match_reasons:        matchReasons,
  }
}

// Extracts OF-XXXXXX code from a free-text message (case-insensitive).
function extractPublicCode(text: string): string | null {
  const m = text.match(/\bOF-([A-Z0-9]{6})\b/i)
  return m ? `OF-${m[1]!.toUpperCase()}` : null
}

// Builds a human-readable message for a single search match, aware of operation_type.
function buildSingleMatchMessage(p: PropertyCandidate): string {
  const loc    = p.location_label ?? p.city ?? ''
  const locStr = loc ? ` en ${loc}` : ''
  const fmt    = (n: number) => Math.round(n).toLocaleString('es-AR')

  if (p.operation_type === 'sale') {
    const priceStr = p.sale_price && p.pricing_mode === 'fixed'
      ? ` Precio de venta: ${p.currency} ${fmt(p.sale_price)}.`
      : ''
    return (
      `Encontré 1 propiedad en venta: "${p.title}"${locStr}.` +
      `${p.area_m2 ? ` Superficie: ${p.area_m2}m².` : ''}` +
      `${priceStr}` +
      ` Presentá las características al cliente. NO pidas fechas de estadía.` +
      ` Si el cliente quiere avanzar, usá escalate_to_human.`
    )
  }

  if (p.operation_type === 'long_term_rental') {
    const priceStr = p.monthly_rent_price && p.pricing_mode === 'fixed'
      ? ` Alquiler mensual: ${p.currency} ${fmt(p.monthly_rent_price)}.`
      : ''
    const expStr = p.expenses_amount
      ? ` Expensas: ${p.currency} ${fmt(p.expenses_amount)}.`
      : ''
    return (
      `Encontré 1 propiedad para alquiler mensual: "${p.title}"${locStr}.` +
      `${priceStr}${expStr}` +
      ` Presentá las características al cliente. NO pidas check-in/check-out ni fechas de estadía.` +
      ` Si el cliente quiere avanzar (visitar, consultar requisitos, avanzar), usá escalate_to_human.`
    )
  }

  // temporary_rental (default)
  return (
    `Encontré 1 propiedad de alquiler temporal: "${p.title}"${locStr}. ` +
    `Capacidad: hasta ${p.capacity_max ?? '?'} personas.` +
    (p.base_price_per_night && p.pricing_mode === 'fixed'
      ? ` Precio: ${p.currency} ${fmt(p.base_price_per_night)}/noche.`
      : '') +
    ' Si el cliente no mencionó fechas o cantidad de personas, preguntalo. NUNCA digas que está disponible sin llamar check_property_availability.'
  )
}

// ── Main executor ──────────────────────────────────────────────────────────────

export async function executeSearchPropertiesForReservation(
  tenantId: string,
  rawArgs:  Record<string, unknown>,
): Promise<string> {
  const VALID_OP_TYPES = new Set<string>(['sale', 'long_term_rental', 'temporary_rental'])

  const args: SearchArgs = {
    query:               typeof rawArgs['query']         === 'string'  ? rawArgs['query'].trim()        : '',
    operation_type:      typeof rawArgs['operation_type'] === 'string' && VALID_OP_TYPES.has(rawArgs['operation_type'] as string)
                           ? rawArgs['operation_type'] as 'sale' | 'long_term_rental' | 'temporary_rental'
                           : undefined,
    guests:              typeof rawArgs['guests']         === 'number'  ? Math.floor(rawArgs['guests']) : undefined,
    include_alternatives: typeof rawArgs['include_alternatives'] === 'boolean' ? rawArgs['include_alternatives'] : false,
  }

  if (!args.query) {
    return JSON.stringify({ error: 'query es requerido.' })
  }

  const intent = extractIntent(args.query)
  const supabase = createClient()

  const SELECT_FIELDS =
    'id, title, description, city, neighborhood, location_label, internal_address, ' +
    'capacity, area_m2, custom_fields, commercial_status, pricing_mode, currency, base_price_per_night, ' +
    'minimum_stay_nights, public_code, slug, show_price_public, operation_type, ' +
    'sale_price, monthly_rent_price, expenses_amount'

  // ── Fast path: exact public_code match (Ref: OF-XXXXXX in message) ──────────
  const publicCode = extractPublicCode(args.query)
  if (publicCode) {
    const { data: exact } = await supabase
      .from('properties')
      .select(SELECT_FIELDS)
      .eq('tenant_id', tenantId)
      .eq('public_code', publicCode)
      .eq('published', true)
      .is('deleted_at', null)
      .maybeSingle()

    if (exact) {
      const exactRow   = exact as unknown as PropertyRow
      const isAvail    = exactRow.commercial_status === 'available'
      const STATUS_ES: Record<string, string> = { rented: 'alquilada', paused: 'pausada temporalmente', sold: 'vendida' }
      console.log('[worker:property-reference]', {
        detectedPublicCode:   publicCode,
        detectedSlug:         null,
        matchedPropertyId:    exactRow.id,
        matchedPropertyTitle: exactRow.title,
        operationType:        exactRow.operation_type,
        commercialStatus:     exactRow.commercial_status,
      })
      if (!isAvail) {
        return JSON.stringify({
          matches:             [],
          unavailable_property: {
            title:             exactRow.title,
            public_code:       publicCode,
            commercial_status: exactRow.commercial_status,
            operation_type:    exactRow.operation_type,
          },
          has_more_results:    false,
          query_understood_as: { public_code: publicCode },
          message: `ATENCIÓN: La propiedad de código ${publicCode} ("${exactRow.title}") está ${STATUS_ES[exactRow.commercial_status] ?? exactRow.commercial_status}. NO está disponible para reservas ni consultas de disponibilidad. Informá al cliente el estado en lenguaje natural y ofrecé propiedades alternativas disponibles llamando search_properties_for_reservation con la zona del cliente.`,
        })
      }
      const candidate = buildCandidate(exactRow, [`Código: ${publicCode}`])
      return JSON.stringify({
        matches:             [candidate],
        has_more_results:    false,
        query_understood_as: { public_code: publicCode },
        message: `Propiedad identificada por código ${publicCode}: "${exactRow.title}". Si el cliente no mencionó fechas o personas, preguntalo.`,
      })
    }
  }

  // ── Fast path 2: slug exact match (e.g. user copied URL slug like "casa-en-palermo") ──
  if (!publicCode) {
    const slugCandidate = normalize(args.query.trim())
      .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    if (/^[a-z0-9][a-z0-9-]{1,}[a-z0-9]$/.test(slugCandidate)) {
      const { data: bySlug } = await supabase
        .from('properties')
        .select(SELECT_FIELDS)
        .eq('tenant_id', tenantId)
        .eq('slug', slugCandidate)
        .eq('published', true)
        .is('deleted_at', null)
        .maybeSingle()

      if (bySlug) {
        const slugRow  = bySlug as unknown as PropertyRow
        const isAvailS = slugRow.commercial_status === 'available'
        const STATUS_ES2: Record<string, string> = { rented: 'alquilada', paused: 'pausada temporalmente', sold: 'vendida' }
        console.log('[worker:property-reference]', {
          detectedPublicCode:   null,
          detectedSlug:         slugCandidate,
          matchedPropertyId:    slugRow.id,
          matchedPropertyTitle: slugRow.title,
          commercialStatus:     slugRow.commercial_status,
          operationType:        slugRow.operation_type,
        })
        if (!isAvailS) {
          return JSON.stringify({
            matches:             [],
            unavailable_property: {
              title:             slugRow.title,
              slug:              slugCandidate,
              commercial_status: slugRow.commercial_status,
              operation_type:    slugRow.operation_type,
            },
            has_more_results:    false,
            query_understood_as: { slug: slugCandidate },
            message: `ATENCIÓN: La propiedad "${slugRow.title}" está ${STATUS_ES2[slugRow.commercial_status] ?? slugRow.commercial_status}. NO está disponible para reservas ni consultas de disponibilidad. Informá al cliente el estado en lenguaje natural y ofrecé propiedades alternativas disponibles llamando search_properties_for_reservation con la zona del cliente.`,
          })
        }
        const candidate = buildCandidate(slugRow, [`Slug: ${slugCandidate}`])
        return JSON.stringify({
          matches:             [candidate],
          has_more_results:    false,
          query_understood_as: { slug: slugCandidate },
          message: `Propiedad identificada por slug "${slugCandidate}": "${slugRow.title}". Si el cliente no mencionó fechas o personas, preguntalo.`,
        })
      }
    }
  }

  if (intent.locationTokens.length === 0 && !intent.typeHint) {
    return JSON.stringify({
      error: 'La búsqueda es muy genérica. Pedile al cliente la zona, dirección o tipo de propiedad que busca.',
    })
  }

  // ── DB query — filter by operation_type only when the LLM explicitly passed it ──
  // commercial_status='available' ensures we never suggest rented/paused/sold properties
  let baseQuery = supabase
    .from('properties')
    .select(SELECT_FIELDS)
    .eq('tenant_id', tenantId)
    .eq('published', true)
    .eq('commercial_status', 'available')
    .is('deleted_at', null)
    .limit(100)

  if (args.operation_type) {
    baseQuery = baseQuery.eq('operation_type', args.operation_type)
  }

  const { data, error } = await baseQuery

  if (error) {
    throw new Error(`[search_properties_for_reservation] DB error: ${error.message}`)
  }

  const rows = (data ?? []) as unknown as PropertyRow[]

  // ── Location hard-filter threshold ─────────────────────────────────────────
  // A property MUST match at least this many location tokens to appear in results.
  //
  // With 2+ tokens ("san andres de giles"): require ≥2 matches.
  //   Reason: single common tokens like "san" also appear in "San Telmo", "San Martín",
  //   "San Isidro" — a threshold of 1 would allow off-zone properties through.
  //
  // With exactly 1 token ("giles", "palermo"): require 1 match.
  //   Reason: single specific names are unambiguous — "giles" only matches Giles.
  const locThreshold = intent.locationTokens.length === 1 ? 1 : 2

  // Score all rows
  interface Scored {
    candidate: PropertyCandidate
    locScore:  number
    typeScore: number
  }

  const allScored: Scored[] = rows.map(p => {
    const locScore  = scoreLocation(intent.locationTokens, p)
    const typeScore = scoreType(intent.typeHint, p)

    const matchReasons: string[] = []
    if (locScore >= locThreshold && intent.locationTokens.length > 0) {
      matchReasons.push(`Zona: ${intent.locationTokens.join(' ')}`)
    }
    if (typeScore > 0 && intent.typeHint) {
      matchReasons.push(`Tipo: ${intent.typeHint}`)
    }

    return { candidate: buildCandidate(p, matchReasons), locScore, typeScore }
  })

  // Capacity filter — exclude properties that are structurally too small
  const eligible = args.guests !== undefined
    ? allScored.filter(s => s.candidate.capacity_max === null || s.candidate.capacity_max >= args.guests!)
    : allScored

  // Build the query_understood_as object for the LLM
  const queryUnderstoodAs: Record<string, string> = {}
  if (intent.locationTokens.length > 0) queryUnderstoodAs['location']       = intent.locationTokens.join(' ')
  if (intent.typeHint)                  queryUnderstoodAs['property_type']   = intent.typeHint
  if (args.operation_type)              queryUnderstoodAs['operation_type']  = args.operation_type

  // ── Default path: hard location filter ─────────────────────────────────────
  if (!args.include_alternatives) {
    // Only properties that pass the location threshold.
    // If there's no location intent (e.g. pure type search), fall back to any
    // property with a type match.
    const zoneMatches = intent.locationTokens.length > 0
      ? eligible.filter(s => s.locScore >= locThreshold)
      : eligible.filter(s => s.typeScore > 0)

    // Sort: type match first within zone (casa before depto), then by locScore
    zoneMatches.sort((a, b) => {
      if (b.typeScore !== a.typeScore) return b.typeScore - a.typeScore
      return b.locScore - a.locScore
    })

    const finalMatches = zoneMatches.slice(0, 3)

    // Detailed audit log — includes what was filtered OUT so we can track false positives
    console.log('[search_properties_for_reservation:v4]', {
      tenantId,
      rawQuery:        args.query,
      operationType:   args.operation_type ?? 'all',
      locationTokens:  intent.locationTokens,
      typeHint:        intent.typeHint,
      locThreshold,
      totalProperties: rows.length,
      eligible:        eligible.length,
      zoneMatches:     zoneMatches.length,
      returned:        finalMatches.length,
      returnedTitles:  finalMatches.map(s => s.candidate.title),
      filteredOut:     eligible
        .filter(s => !finalMatches.includes(s))
        .map(s => `${s.candidate.title} (loc=${s.locScore},type=${s.typeScore})`),
    })

    if (finalMatches.length === 0) {
      // No properties match the requested zone — inform the LLM so it can ask the client
      // whether to search alternatives.  DO NOT expose any property names or zones here.
      return JSON.stringify({
        matches:                 [],
        no_direct_match:         true,
        can_search_alternatives: true,
        query_understood_as:     queryUnderstoodAs,
        instruction:             'No hay propiedades en esa zona. NO inventes ni menciones barrios, zonas ni ciudades alternativas. Si el cliente quiere ver otras opciones, llamá de nuevo con include_alternatives=true. Solo podés nombrar zonas o propiedades que aparezcan en resultados reales de esta herramienta.',
      })
    }

    const matches = finalMatches.map(s => s.candidate)

    const message = matches.length === 1
      ? buildSingleMatchMessage(matches[0]!)
      : `Encontré ${matches.length} propiedades en esa zona. Mostráselas brevemente (indicando si son para venta, alquiler mensual o alquiler temporal) y pedí que el cliente elija una.`

    return JSON.stringify({
      matches,
      has_more_results:        false,
      can_search_alternatives: true,
      query_understood_as:     queryUnderstoodAs,
      message,
    })
  }

  // ── Alternatives path: client explicitly asked for other zones ──────────────
  const zoneMatches = intent.locationTokens.length > 0
    ? eligible.filter(s => s.locScore >= locThreshold)
    : eligible

  const alternatives = intent.locationTokens.length > 0
    ? eligible.filter(s => s.locScore < locThreshold)
    : []

  zoneMatches.sort((a, b) => b.typeScore - a.typeScore || b.locScore - a.locScore)
  alternatives.sort((a, b) => b.typeScore - a.typeScore || b.locScore - a.locScore)

  const topZone = zoneMatches.slice(0, 3)
  const topAlt  = alternatives.slice(0, 3)

  console.log('[search_properties_for_reservation:v4:alternatives]', {
    tenantId,
    rawQuery:       args.query,
    operationType:  args.operation_type ?? 'all',
    locationTokens: intent.locationTokens,
    typeHint:       intent.typeHint,
    zoneMatches:    topZone.map(s => s.candidate.title),
    alternatives:   topAlt.map(s => s.candidate.title),
  })

  const total = topZone.length + topAlt.length
  if (total === 0) {
    return JSON.stringify({
      matches:             [],
      no_direct_match:     true,
      query_understood_as: queryUnderstoodAs,
      instruction:         'No hay propiedades disponibles en ninguna zona. NO inventes alternativas ni menciones zonas o barrios. Decile al cliente que no hay propiedades cargadas con esos criterios.',
    })
  }

  const message = topZone.length > 0
    ? `Encontré ${topZone.length} propiedad${topZone.length !== 1 ? 'es' : ''} en la zona pedida y ${topAlt.length} en otras zonas. ` +
      `Mostrá primero las de la zona y luego las alternativas, indicando claramente que son de otra zona.`
    : `No hay propiedades en esa zona. Encontré ${topAlt.length} en otras zonas.`

  return JSON.stringify({
    matches:                   topZone.map(s => s.candidate),
    alternatives_outside_area: topAlt.map(s => s.candidate),
    has_more_results:          false,
    can_search_alternatives:   false,
    query_understood_as:       queryUnderstoodAs,
    message,
  })
}

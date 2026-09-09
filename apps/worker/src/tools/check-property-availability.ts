import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'
import { validateWeekday } from './validate-weekday'
import { checkPropertyAvailability } from './availability-check.shared'
import { quoteTemporaryRental } from './pricing.shared'
import { checkTemporaryRentalEligibility } from './eligibility.shared'

export const checkPropertyAvailabilityTool: LLMTool = {
  type: 'function',
  function: {
    name: 'check_property_availability',
    description:
      'Verifica si una propiedad está disponible para un rango de fechas y calcula el precio estimado. ' +
      'SIEMPRE llamá esta herramienta ANTES de preguntar al cliente "¿querés reservar?". ' +
      'Si available=true → mostrá el precio al cliente usando price_summary y pedí confirmación explícita. ' +
      'Si available=false → ofrecé otras fechas o llamá find_next_available_dates.',
    parameters: {
      type:       'object',
      properties: {
        property_id: {
          type:        'string',
          description: 'ID de la propiedad (obtenelo de search_properties_for_reservation).',
        },
        start_date: {
          type:        'string',
          description: 'Fecha de entrada en formato YYYY-MM-DD.',
        },
        end_date: {
          type:        'string',
          description: 'Fecha de salida en formato YYYY-MM-DD.',
        },
        guests: {
          type:        'integer',
          description: 'Cantidad de personas (para verificar capacidad máxima).',
          minimum:     1,
        },
        start_day_name: {
          type:        'string',
          description: 'Nombre del día en español que mencionó el cliente para la entrada (ej: "lunes", "martes"). Pasalo SOLO si el cliente lo mencionó explícitamente — permite validación determinista del día de semana.',
        },
        end_day_name: {
          type:        'string',
          description: 'Nombre del día en español que mencionó el cliente para la salida.',
        },
      },
      required:             ['property_id', 'start_date', 'end_date'],
      additionalProperties: false,
    },
  },
}

// Fase 3E-A.1 y 3E-A.2: este archivo ya no lee ninguna columna de precio
// (base_price_per_night, cleaning_fee, temporary_deposit_*) ni de reglas
// (commercial_status, operation_type, capacity, minimum_stay_nights, pricing_mode).
// Las leen las funciones canónicas: quote_temporary_rental y
// check_temporary_rental_eligibility. No tenerlas a mano es deliberado — hace
// estructuralmente imposible que este archivo vuelva a calcular un precio o a
// reimplementar una regla.
//
// Lo único que queda es lo que este archivo sí necesita para hablarle al
// cliente: cómo se llama la propiedad y los horarios de check-in/out.
interface PropertyRow {
  id:             string
  title:          string
  check_in_time:  string | null
  check_out_time: string | null
}

/**
 * @param conversationId  Required to upsert the availability draft so create_pending_reservation
 *                        can use exact dates/prices without re-parsing conversation history.
 */
export async function executeCheckPropertyAvailability(
  tenantId:       string,
  conversationId: string,
  rawArgs:        Record<string, unknown>,
): Promise<string> {
  const propertyId    = typeof rawArgs['property_id']    === 'string' ? rawArgs['property_id'].trim()    : ''
  const startStr      = typeof rawArgs['start_date']     === 'string' ? rawArgs['start_date'].trim()     : ''
  const endStr        = typeof rawArgs['end_date']       === 'string' ? rawArgs['end_date'].trim()       : ''
  const guests        = typeof rawArgs['guests']         === 'number' ? Math.floor(rawArgs['guests'])    : undefined
  const startDayName  = typeof rawArgs['start_day_name'] === 'string' ? rawArgs['start_day_name'].trim() : undefined
  const endDayName    = typeof rawArgs['end_day_name']   === 'string' ? rawArgs['end_day_name'].trim()   : undefined

  if (!propertyId || !startStr || !endStr) {
    return JSON.stringify({ error: 'Parámetros requeridos: property_id, start_date, end_date.' })
  }

  // Deterministic weekday validation — catches contradictions like "martes 22" when 22 is Wednesday
  const startDayCheck = validateWeekday(startDayName, startStr)
  if (!startDayCheck.ok) {
    return JSON.stringify({
      error:      'WEEKDAY_DATE_MISMATCH',
      message:    `El día de semana no coincide con la fecha de entrada. El cliente dijo "${startDayCheck.stated_day}" pero ${startStr} cae en ${startDayCheck.actual_day}. Pedile al cliente que aclare la fecha antes de continuar.`,
      stated_day: startDayCheck.stated_day,
      actual_day: startDayCheck.actual_day,
      date:       startDayCheck.date,
    })
  }
  const endDayCheck = validateWeekday(endDayName, endStr)
  if (!endDayCheck.ok) {
    return JSON.stringify({
      error:      'WEEKDAY_DATE_MISMATCH',
      message:    `El día de semana no coincide con la fecha de salida. El cliente dijo "${endDayCheck.stated_day}" pero ${endStr} cae en ${endDayCheck.actual_day}. Pedile al cliente que aclare la fecha antes de continuar.`,
      stated_day: endDayCheck.stated_day,
      actual_day: endDayCheck.actual_day,
      date:       endDayCheck.date,
    })
  }

  const startDate = new Date(`${startStr}T00:00:00Z`)
  const endDate   = new Date(`${endStr}T00:00:00Z`)

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return JSON.stringify({ error: 'Fechas inválidas. Usá el formato YYYY-MM-DD.' })
  }
  if (endDate <= startDate) {
    return JSON.stringify({ error: 'La fecha de salida debe ser posterior a la de entrada.' })
  }

  const todayStr = new Date().toISOString().split('T')[0]!
  if (startStr < todayStr) {
    return JSON.stringify({
      available: false,
      reason:    `La fecha de entrada ${startStr} ya pasó. Hoy es ${todayStr}.`,
    })
  }

  const supabase = createClient()

  const { data: property } = await supabase
    .from('properties')
    .select('id, title, check_in_time, check_out_time')
    .eq('tenant_id', tenantId)
    .eq('id', propertyId)
    .eq('published', true)
    .is('deleted_at', null)
    .maybeSingle() as { data: PropertyRow | null }

  if (!property) {
    return JSON.stringify({ error: 'Propiedad no disponible para consulta.' })
  }

  // ─── Elegibilidad con las reglas canónicas ──────────────────────────────────
  // Estado comercial, tipo de operación, capacidad y estadía mínima ya no se
  // evalúan acá: los evalúa public.check_temporary_rental_eligibility, la misma
  // función que usan el tool de creación, la creación manual, la reprogramación
  // y la aprobación de solicitudes.
  //
  // El orden de evaluación lo fija la función SQL y replica exactamente el que
  // tenía este archivo, así que para una misma entrada el primer motivo
  // reportado al cliente sigue siendo el mismo. Los mensajes son los de antes,
  // palabra por palabra.
  const elig = await checkTemporaryRentalEligibility(
    supabase, tenantId, propertyId, startStr, endStr, guests,
  )

  if (!elig.eligible) {
    switch (elig.reason) {
      case 'property_not_available': {
        const statusLabels: Record<string, string> = {
          rented: 'alquilada', paused: 'pausada temporalmente', sold: 'vendida',
        }
        const raw   = elig.commercial_status ?? ''
        const label = statusLabels[raw] ?? raw
        return JSON.stringify({
          available: false,
          reason:    `Esta propiedad no está disponible comercialmente — actualmente está ${label}. Ofrecé propiedades alternativas disponibles.`,
          commercial_status: raw,
        })
      }
      case 'not_temporary_rental': {
        const label = elig.operation_type === 'sale' ? 'venta' : 'alquiler tradicional'
        return JSON.stringify({
          available: false,
          reason:    `Esta propiedad es de ${label} — no acepta reservas de alquiler temporal.`,
        })
      }
      case 'capacity_exceeded':
        return JSON.stringify({
          available: false,
          reason:    `Capacidad máxima: ${elig.capacity} personas. Solicitaron ${elig.requested_guests}.`,
        })
      case 'minimum_stay_not_met': {
        const min = elig.minimum_stay_nights ?? 1
        return JSON.stringify({
          available: false,
          reason:    `Estadía mínima: ${min} noche${min !== 1 ? 's' : ''}. Solicitaron ${elig.requested_nights}.`,
        })
      }
      default:
        // property_not_found / invalid_dates son inalcanzables acá (la propiedad
        // se acaba de leer y las fechas se validaron arriba); rpc_error sí es
        // posible y es una falla de infraestructura, no un "no disponible".
        console.error('[reservation:availability:eligibility-failed]', {
          conversationId, propertyId, tenantId, reason: elig.reason,
        })
        return JSON.stringify({
          error: 'No se pudo verificar la propiedad. Decile al cliente que aguarde un momento y volvé a intentar.',
        })
    }
  }

  // Las mismas noches que usa el motor de pricing: no hay dos cálculos.
  const nightsCount = elig.nights

  // Shared availability check (same logic as create_pending_reservation)
  const avail = await checkPropertyAvailability(supabase, tenantId, propertyId, startStr, endStr)

  console.log('[reservation:availability:check]', {
    conversationId,
    propertyId,
    tenantId,
    startDate:       startStr,
    endDate:         endStr,
    guests:          guests ?? null,
    available:       avail.available,
    conflictSource:  avail.conflict_source ?? null,
    conflictId:      avail.conflict_id ?? null,
  })

  if (!avail.available) {
    // Invalidate any existing draft for this conversation since dates changed or became blocked
    await supabase
      .from('conversation_reservation_drafts')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
      .eq('conversation_id', conversationId)
      .eq('status', 'quoted')

    const reasonMap: Record<string, string> = {
      confirmed:   `"${property.title}" ya está reservada para esas fechas.`,
      pre_reserved: `"${property.title}" tiene una reserva pendiente (no expirada) para esas fechas.`,
      block:        `Esas fechas están bloqueadas en "${property.title}".`,
    }
    return JSON.stringify({
      available: false,
      reason:    reasonMap[avail.conflict_source ?? ''] ?? 'No disponible para esas fechas.',
    })
  }

  // ─── Available — build price estimate and upsert draft ───────────────────────
  // El precio sale del motor canónico (public.quote_temporary_rental). Acá solo
  // se arma el texto que lee el cliente: presentación, no aritmética.
  const quote = await quoteTemporaryRental(supabase, tenantId, propertyId, startStr, endStr)

  if (!quote.ok) {
    // No es el caso "sin precio" —ese vuelve ok:true con importes null— sino una
    // falla real del motor. Cotizar mal es peor que no cotizar: se corta acá y
    // no se escribe draft, así create_pending_reservation no puede reutilizar
    // una cotización que nunca existió.
    console.error('[reservation:availability:quote-failed]', {
      conversationId, propertyId, tenantId, reason: quote.reason,
    })
    return JSON.stringify({
      error: 'No se pudo calcular el precio para esas fechas. Decile al cliente que aguarde un momento y volvé a intentar.',
    })
  }

  const currency    = quote.currency
  const fmt         = (n: number) => Math.round(n).toLocaleString('es-AR')
  const result: Record<string, unknown> = {
    available:    true,
    property_id:  property.id,
    title:        property.title,
    nights_count: quote.nights,
    start_date:   startStr,
    end_date:     endStr,
    currency,
  }

  // Include check times in the result so the AI can mention them to the client
  if (property.check_in_time)  result['check_in_time']  = String(property.check_in_time).slice(0, 5)
  if (property.check_out_time) result['check_out_time'] = String(property.check_out_time).slice(0, 5)

  // "fixed sin precio cargado" se le comunica al cliente como consult, igual que
  // antes: el motor devuelve pricing_mode 'fixed' pero nightly_price null.
  if (quote.pricing_mode === 'fixed' && quote.nightly_price !== null) {
    const lines: string[] = [
      `${currency} ${fmt(quote.nightly_price)}/noche × ${quote.nights} noche${quote.nights !== 1 ? 's' : ''} = ${currency} ${fmt(quote.subtotal ?? 0)}`,
    ]
    if (quote.fees > 0) lines.push(`Limpieza: ${currency} ${fmt(quote.fees)}`)
    lines.push(`Total: ${currency} ${fmt(quote.total ?? 0)}`)
    if (quote.deposit) lines.push(`Seña requerida: ${currency} ${fmt(quote.deposit)}`)

    result['pricing_mode']     = 'fixed'
    result['nightly_price']    = quote.nightly_price
    result['subtotal']         = quote.subtotal
    result['cleaning_fee']     = quote.fees
    result['total']            = quote.total
    result['deposit_required'] = quote.deposit
    result['price_summary']    = lines.join('\n')
  } else {
    result['pricing_mode']  = 'consult'
    result['price_summary'] = 'Precio a consultar con el asesor al confirmar.'
  }

  // Upsert draft — overwrites any previous draft for this conversation with exact dates/prices.
  // create_pending_reservation reads this draft to avoid re-parsing stale history.
  const draftExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  await supabase
    .from('conversation_reservation_drafts')
    .upsert({
      tenant_id:               tenantId,
      conversation_id:         conversationId,
      property_id:             property.id,
      property_title:          property.title,
      start_date:              startStr,
      end_date:                endStr,
      guests:                  guests ?? 1,
      price_currency:          currency,
      pricing_mode:            quote.pricing_mode,
      nightly_price:           quote.nightly_price,
      nights_count:            quote.nights,
      subtotal_amount:         quote.subtotal,
      fees_amount:             quote.fees,
      total_amount:            quote.total,
      deposit_required_amount: quote.deposit,
      pricing_breakdown:       quote.breakdown,
      status:                  'quoted',
      expires_at:              draftExpiresAt,
      updated_at:              new Date().toISOString(),
    }, { onConflict: 'tenant_id,conversation_id' })

  return JSON.stringify(result)
}

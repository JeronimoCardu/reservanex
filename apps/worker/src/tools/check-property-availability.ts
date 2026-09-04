import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'
import { validateWeekday } from './validate-weekday'
import { checkPropertyAvailability } from './availability-check.shared'

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

interface PropertyPricingRow {
  id:                        string
  title:                     string
  commercial_status:         string
  operation_type:            string
  pricing_mode:              string
  currency:                  string
  capacity:                  number | null
  base_price_per_night:      number | null
  minimum_stay_nights:       number
  cleaning_fee:              number
  temporary_deposit_amount:  number | null
  temporary_deposit_percent: number | null
  check_in_time:             string | null
  check_out_time:            string | null
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
    .select('id, title, commercial_status, operation_type, pricing_mode, currency, capacity, base_price_per_night, minimum_stay_nights, cleaning_fee, temporary_deposit_amount, temporary_deposit_percent, check_in_time, check_out_time')
    .eq('tenant_id', tenantId)
    .eq('id', propertyId)
    .eq('published', true)
    .is('deleted_at', null)
    .maybeSingle() as { data: PropertyPricingRow | null }

  if (!property) {
    return JSON.stringify({ error: 'Propiedad no disponible para consulta.' })
  }

  if (property.commercial_status !== 'available') {
    const statusLabels: Record<string, string> = {
      rented: 'alquilada', paused: 'pausada temporalmente', sold: 'vendida',
    }
    const label = statusLabels[property.commercial_status] ?? property.commercial_status
    return JSON.stringify({
      available: false,
      reason:    `Esta propiedad no está disponible comercialmente — actualmente está ${label}. Ofrecé propiedades alternativas disponibles.`,
      commercial_status: property.commercial_status,
    })
  }

  if (property.operation_type !== 'temporary_rental') {
    const label = property.operation_type === 'sale' ? 'venta' : 'alquiler tradicional'
    return JSON.stringify({
      available: false,
      reason:    `Esta propiedad es de ${label} — no acepta reservas de alquiler temporal.`,
    })
  }

  if (guests !== undefined && property.capacity !== null && guests > property.capacity) {
    return JSON.stringify({
      available: false,
      reason:    `Capacidad máxima: ${property.capacity} personas. Solicitaron ${guests}.`,
    })
  }

  const nightsCount = Math.round((endDate.getTime() - startDate.getTime()) / 86400000)
  const minStay     = property.minimum_stay_nights ?? 1
  if (nightsCount < minStay) {
    return JSON.stringify({
      available: false,
      reason:    `Estadía mínima: ${minStay} noche${minStay !== 1 ? 's' : ''}. Solicitaron ${nightsCount}.`,
    })
  }

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
  const currency    = property.currency ?? 'ARS'
  const fmt         = (n: number) => Math.round(n).toLocaleString('es-AR')
  const result: Record<string, unknown> = {
    available:    true,
    property_id:  property.id,
    title:        property.title,
    nights_count: nightsCount,
    start_date:   startStr,
    end_date:     endStr,
    currency,
  }

  // Include check times in the result so the AI can mention them to the client
  if (property.check_in_time)  result['check_in_time']  = String(property.check_in_time).slice(0, 5)
  if (property.check_out_time) result['check_out_time'] = String(property.check_out_time).slice(0, 5)

  let draftNightly:  number | null = null
  let draftSubtotal: number | null = null
  let draftFees                    = 0
  let draftTotal:    number | null = null
  let draftDeposit:  number | null = null
  const draftBreakdown: { [key: string]: number | string | null | boolean } = {}

  if (property.pricing_mode === 'fixed' && property.base_price_per_night) {
    const nightly     = property.base_price_per_night
    const subtotal    = nightly * nightsCount
    const cleaningFee = property.cleaning_fee ?? 0
    const total       = subtotal + cleaningFee

    let depositAmount: number | null = null
    if (property.temporary_deposit_amount) {
      depositAmount = property.temporary_deposit_amount
    } else if (property.temporary_deposit_percent) {
      depositAmount = Math.round(total * property.temporary_deposit_percent / 100)
    }

    const lines: string[] = [
      `${currency} ${fmt(nightly)}/noche × ${nightsCount} noche${nightsCount !== 1 ? 's' : ''} = ${currency} ${fmt(subtotal)}`,
    ]
    if (cleaningFee > 0) lines.push(`Limpieza: ${currency} ${fmt(cleaningFee)}`)
    lines.push(`Total: ${currency} ${fmt(total)}`)
    if (depositAmount) lines.push(`Seña requerida: ${currency} ${fmt(depositAmount)}`)

    result['pricing_mode']     = 'fixed'
    result['nightly_price']    = nightly
    result['subtotal']         = subtotal
    result['cleaning_fee']     = cleaningFee
    result['total']            = total
    result['deposit_required'] = depositAmount
    result['price_summary']    = lines.join('\n')

    draftNightly  = nightly
    draftSubtotal = subtotal
    draftFees     = cleaningFee
    draftTotal    = total
    draftDeposit  = depositAmount
    draftBreakdown['nightly_price'] = nightly
    draftBreakdown['nights']        = nightsCount
    draftBreakdown['subtotal']      = subtotal
    draftBreakdown['cleaning_fee']  = cleaningFee
    draftBreakdown['total']         = total
    draftBreakdown['deposit']       = depositAmount
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
      pricing_mode:            property.pricing_mode ?? 'consult',
      nightly_price:           draftNightly,
      nights_count:            nightsCount,
      subtotal_amount:         draftSubtotal,
      fees_amount:             draftFees,
      total_amount:            draftTotal,
      deposit_required_amount: draftDeposit,
      pricing_breakdown:       draftBreakdown,
      status:                  'quoted',
      expires_at:              draftExpiresAt,
      updated_at:              new Date().toISOString(),
    }, { onConflict: 'tenant_id,conversation_id' })

  return JSON.stringify(result)
}

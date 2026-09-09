import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'
import { validateWeekday } from './validate-weekday'
import { checkPropertyAvailability } from './availability-check.shared'
import { quoteTemporaryRental } from './pricing.shared'
import { checkTemporaryRentalEligibility } from './eligibility.shared'

export const createPendingReservationTool: LLMTool = {
  type: 'function',
  function: {
    name: 'create_pending_reservation',
    description:
      'Crea una reserva pendiente de confirmación cuando el cliente acepta reservar una propiedad. ' +
      'La reserva queda en estado "pendiente" — un asesor debe confirmarla. ' +
      'Usá esta tool SOLO cuando el cliente confirme explícitamente ("sí", "dale", "confirmado", etc.). ' +
      'La tool usa automáticamente los datos exactos de la última cotización disponible — no re-parses fechas del historial. ' +
      'NUNCA uses la palabra "confirmada" — siempre está "pendiente de confirmación por un asesor". ' +
      'NUNCA crees una reserva con fechas pasadas. ' +
      'Después de crear la reserva, decí ÚNICAMENTE: "Tu reserva pendiente quedó registrada. Un asesor la va a confirmar a la brevedad." Sin incluir IDs ni códigos.',
    parameters: {
      type: 'object',
      properties: {
        property_id: {
          type:        'string',
          description: 'ID de la propiedad. Obtenelo de search_properties_for_reservation.',
        },
        start_date: {
          type:        'string',
          description: 'Fecha de entrada en formato YYYY-MM-DD (de la última cotización válida).',
        },
        end_date: {
          type:        'string',
          description: 'Fecha de salida en formato YYYY-MM-DD (de la última cotización válida).',
        },
        guests: {
          type:        'integer',
          description: 'Cantidad de personas que declaró el cliente.',
          minimum:     1,
        },
        customer_notes: {
          type:        'string',
          description: 'Pedidos especiales o notas del cliente para el asesor (opcional).',
        },
        start_day_name: {
          type:        'string',
          description: 'Nombre del día en español mencionado por el cliente para la entrada. Pasalo SOLO si el cliente lo mencionó en este mensaje.',
        },
        end_day_name: {
          type:        'string',
          description: 'Nombre del día en español mencionado por el cliente para la salida.',
        },
      },
      required:             ['property_id', 'start_date', 'end_date', 'guests'],
      additionalProperties: false,
    },
  },
}

interface CreateReservationArgs {
  property_id:     string
  start_date:      string
  end_date:        string
  guests:          number
  customer_notes?: string
  start_day_name?: string
  end_day_name?:   string
}

export async function executeCreatePendingReservation(
  tenantId:       string,
  conversationId: string,
  contactId:      string,
  rawArgs:        Record<string, unknown>,
): Promise<string> {
  const args: CreateReservationArgs = {
    property_id:    typeof rawArgs['property_id']    === 'string' ? rawArgs['property_id'].trim()    : '',
    start_date:     typeof rawArgs['start_date']     === 'string' ? rawArgs['start_date'].trim()     : '',
    end_date:       typeof rawArgs['end_date']       === 'string' ? rawArgs['end_date'].trim()       : '',
    guests:         typeof rawArgs['guests']         === 'number' ? Math.floor(rawArgs['guests'])    : 1,
    customer_notes: typeof rawArgs['customer_notes'] === 'string' ? rawArgs['customer_notes'].trim() : undefined,
    start_day_name: typeof rawArgs['start_day_name'] === 'string' ? rawArgs['start_day_name'].trim() : undefined,
    end_day_name:   typeof rawArgs['end_day_name']   === 'string' ? rawArgs['end_day_name'].trim()   : undefined,
  }

  if (!args.property_id || !args.start_date || !args.end_date) {
    return JSON.stringify({ error: 'Parámetros requeridos: property_id, start_date, end_date.' })
  }

  const supabase = createClient()

  // ── Step 0: Guard — contact must have a name before creating a reservation ───
  // Query DB directly (not ctx) so the guard works even when save_contact_name
  // was called earlier in the same tool loop turn.
  const { data: contactRow } = await supabase
    .from('contacts')
    .select('name')
    .eq('id', contactId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!contactRow?.name?.trim()) {
    return JSON.stringify({
      error:   'CONTACT_NAME_REQUIRED',
      message: 'El cliente no tiene nombre registrado. Antes de crear la reserva, preguntale: "Para dejar registrada la reserva, ¿me decís tu nombre y apellido?" Cuando el cliente responda, guardalo con save_contact_name y luego llamá create_pending_reservation de nuevo. El draft de reserva sigue vigente.',
    })
  }

  // ── Step 1: Look up the latest valid draft for this conversation ──────────────
  // The draft was written by check_property_availability with exact validated dates.
  // If a valid draft exists, use it — this prevents the LLM from re-parsing stale
  // date references from conversation history when the client says "Dale".
  const now = new Date().toISOString()
  const { data: draft } = await supabase
    .from('conversation_reservation_drafts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .eq('status', 'quoted')
    .maybeSingle()

  const draftValid = draft && draft.expires_at > now && draft.property_id === args.property_id

  let useStart:  string
  let useEnd:    string
  let useGuests: number

  if (draftValid) {
    // Use draft dates — canonical, already validated by check_property_availability
    useStart  = draft.start_date
    useEnd    = draft.end_date
    useGuests = draft.guests
  } else {
    // No valid draft — use LLM-provided args (fallback path)
    useStart  = args.start_date
    useEnd    = args.end_date
    useGuests = args.guests

    // Only run weekday validation when NOT using draft (draft was already validated)
    const startDayCheck = validateWeekday(args.start_day_name, useStart)
    if (!startDayCheck.ok) {
      return JSON.stringify({
        error:      'WEEKDAY_DATE_MISMATCH',
        message:    `El día de semana no coincide con la fecha de entrada. El cliente dijo "${startDayCheck.stated_day}" pero ${useStart} cae en ${startDayCheck.actual_day}. Pedile al cliente que aclare la fecha antes de crear la reserva.`,
        stated_day: startDayCheck.stated_day,
        actual_day: startDayCheck.actual_day,
        date:       startDayCheck.date,
      })
    }
    const endDayCheck = validateWeekday(args.end_day_name, useEnd)
    if (!endDayCheck.ok) {
      return JSON.stringify({
        error:      'WEEKDAY_DATE_MISMATCH',
        message:    `El día de semana no coincide con la fecha de salida. El cliente dijo "${endDayCheck.stated_day}" pero ${useEnd} cae en ${endDayCheck.actual_day}. Pedile al cliente que aclare la fecha antes de crear la reserva.`,
        stated_day: endDayCheck.stated_day,
        actual_day: endDayCheck.actual_day,
        date:       endDayCheck.date,
      })
    }

    if (draft && draft.status === 'quoted' && draft.expires_at <= now) {
      // Draft exists but expired — re-check mandatory
      return JSON.stringify({
        error:   'QUOTE_EXPIRED',
        message: `La cotización para esas fechas venció. Llamá check_property_availability con las mismas fechas para obtener una nueva cotización antes de crear la reserva.`,
      })
    }
  }

  const startDate = new Date(`${useStart}T00:00:00Z`)
  const endDate   = new Date(`${useEnd}T00:00:00Z`)

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return JSON.stringify({ error: 'Fechas inválidas. Usá el formato YYYY-MM-DD.' })
  }
  if (endDate <= startDate) {
    return JSON.stringify({ error: 'La fecha de salida debe ser posterior a la de entrada.' })
  }

  // Anti past-date
  const todayStr = new Date().toISOString().split('T')[0]!
  if (useStart < todayStr) {
    return JSON.stringify({
      error:
        `PAST_DATE_NOT_ALLOWED: La fecha de entrada ${useStart} ya pasó. Hoy es ${todayStr}. ` +
        `Pedile al cliente que confirme el año correcto.`,
    })
  }

  // ── Step 2: Fetch property ────────────────────────────────────────────────────
  const { data: property } = await supabase
    .from('properties')
    .select('id, title, pricing_mode, currency')
    .eq('tenant_id', tenantId)
    .eq('id', args.property_id)
    .is('deleted_at', null)
    // Fase 3E-A.1 y 3E-A.2: sin las columnas de precio ni las de reglas
    // (commercial_status, operation_type, capacity, minimum_stay_nights). Las
    // leen quote_temporary_rental y check_temporary_rental_eligibility; no
    // tenerlas acá hace estructuralmente imposible reimplementarlas.
    //
    // pricing_mode y currency siguen leyéndose solo como valores por defecto de
    // la rama que reutiliza un draft, donde no se cotiza de nuevo.
    .maybeSingle() as {
      data: {
        id:           string
        title:        string
        pricing_mode: string
        currency:     string
      } | null
    }

  if (!property) {
    return JSON.stringify({ error: 'Propiedad no encontrada. Verificá el property_id.' })
  }

  // ─── Elegibilidad con las reglas canónicas ──────────────────────────────────
  // Antes, este archivo verificaba estado comercial, tipo de operación y estadía
  // mínima, pero leía `capacity` de properties y NUNCA la comparaba: la
  // capacidad solo se verificaba al cotizar. Si el LLM cotizaba para 4 y creaba
  // para 9, la reserva entraba igual. Ahora las cuatro reglas las evalúa
  // public.check_temporary_rental_eligibility, la misma función que usa el resto
  // de los writers.
  const elig = await checkTemporaryRentalEligibility(
    supabase, tenantId, args.property_id, useStart, useEnd, useGuests,
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
          error: `"${property.title}" no está disponible comercialmente — actualmente está ${label}. No se puede crear una reserva. Ofrecé propiedades alternativas disponibles.`,
        })
      }
      case 'not_temporary_rental': {
        const label = elig.operation_type === 'sale' ? 'venta' : 'alquiler tradicional'
        return JSON.stringify({
          error: `"${property.title}" es de ${label}. No acepta reservas de alquiler temporal.`,
        })
      }
      case 'capacity_exceeded':
        return JSON.stringify({
          error:
            `La capacidad máxima de "${property.title}" es de ${elig.capacity} persona${elig.capacity !== 1 ? 's' : ''} ` +
            `y la reserva es para ${elig.requested_guests}. ` +
            `Pedile al cliente que ajuste la cantidad de personas u ofrecé una propiedad más grande.`,
        })
      case 'minimum_stay_not_met': {
        const min = elig.minimum_stay_nights ?? 1
        return JSON.stringify({
          error:
            `La estadía mínima en "${property.title}" es de ${min} noche${min !== 1 ? 's' : ''}. ` +
            `La solicitud es de ${elig.requested_nights} noche${elig.requested_nights !== 1 ? 's' : ''}. ` +
            `Pedile al cliente que elija fechas con al menos ${min} noches.`,
        })
      }
      default:
        console.error('[reservation:create:eligibility-failed]', {
          conversationId, propertyId: args.property_id, tenantId, reason: elig.reason,
        })
        return JSON.stringify({
          error: 'No se pudo verificar la propiedad. Decile al cliente que aguarde un momento y volvé a intentar.',
        })
    }
  }

  // Las mismas noches que usa el motor de pricing: no hay dos cálculos.
  const nightsCount = elig.nights

  // ── Step 3: Availability re-check (shared helper = same logic as check_property_availability) ──
  const avail = await checkPropertyAvailability(supabase, tenantId, args.property_id, useStart, useEnd)

  console.log('[reservation:create:availability-result]', {
    conversationId,
    propertyId:     args.property_id,
    tenantId,
    startDate:      useStart,
    endDate:        useEnd,
    guests:         useGuests,
    usedDraft:      draftValid,
    available:      avail.available,
    conflictSource: avail.conflict_source ?? null,
    conflictId:     avail.conflict_id ?? null,
  })

  if (!avail.available) {
    const reasonMap: Record<string, string> = {
      confirmed:    `"${property.title}" ya tiene una reserva confirmada en ese período. Ofrecé otras fechas.`,
      pre_reserved: `"${property.title}" tiene una reserva pendiente (no expirada) en ese período. Ofrecé otras fechas.`,
      block:        `Esas fechas están bloqueadas en "${property.title}". Ofrecé otras fechas al cliente.`,
    }
    return JSON.stringify({
      error: reasonMap[avail.conflict_source ?? ''] ?? 'No disponible para esas fechas.',
    })
  }

  // ── Step 4: Get hold time ─────────────────────────────────────────────────────
  const { data: settings } = await supabase
    .from('ai_settings')
    .select('pending_reservation_hold_minutes')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  const holdMinutes = settings?.pending_reservation_hold_minutes ?? 1440
  const expiresAt   = new Date(Date.now() + holdMinutes * 60 * 1000).toISOString()

  // ── Step 5: Build price snapshot ─────────────────────────────────────────────
  // If draft is valid, reuse the pre-computed snapshot to avoid re-calculating
  const currency = property.currency ?? 'ARS'
  let nightly_price_snapshot:  number | null = null
  let subtotal_amount:         number | null = null
  let fees_amount                            = 0
  let total_amount:            number | null = null
  let deposit_required_amount: number | null = null
  let pricing_mode_snapshot                  = property.pricing_mode ?? 'consult'
  let pricing_breakdown: { [key: string]: number | string | null | boolean } = {}

  if (draftValid && draft.pricing_mode === 'fixed') {
    // Use draft snapshot — el precio que ya se le mostró al cliente y que
    // aceptó. Esta rama NO cotiza de nuevo a propósito: si el tenant cambió la
    // tarifa en los últimos 30 minutos, se honra lo cotizado, no lo nuevo.
    nightly_price_snapshot  = draft.nightly_price
    subtotal_amount         = draft.subtotal_amount
    fees_amount             = draft.fees_amount ?? 0
    total_amount            = draft.total_amount
    deposit_required_amount = draft.deposit_required_amount
    pricing_mode_snapshot   = draft.pricing_mode
    pricing_breakdown       = (draft.pricing_breakdown as { [key: string]: number | string | null | boolean }) ?? {}
  } else {
    // Sin cotización previa vigente: se cotiza ahora con el motor canónico.
    const quote = await quoteTemporaryRental(supabase, tenantId, args.property_id, useStart, useEnd)

    if (!quote.ok) {
      console.error('[reservation:create:quote-failed]', {
        conversationId, propertyId: args.property_id, tenantId, reason: quote.reason,
      })
      return JSON.stringify({
        error: 'No se pudo calcular el precio de la reserva. Decile al cliente que aguarde un momento y volvé a intentar.',
      })
    }

    nightly_price_snapshot  = quote.nightly_price
    subtotal_amount         = quote.subtotal
    fees_amount             = quote.fees
    total_amount            = quote.total
    deposit_required_amount = quote.deposit
    pricing_mode_snapshot   = quote.pricing_mode
    pricing_breakdown       = quote.breakdown
  }

  // ── Step 6: Insert reservation ────────────────────────────────────────────────
  console.log('[reservation:create:attempt]', {
    conversationId,
    propertyId:  args.property_id,
    tenantId,
    startDate:   useStart,
    endDate:     useEnd,
    guests:      useGuests,
    usedDraft:   draftValid,
  })

  const { data: reservation, error } = await supabase
    .from('reservations')
    .insert({
      tenant_id:               tenantId,
      contact_id:              contactId,
      conversation_id:         conversationId,
      property_id:             args.property_id,
      start_date:              useStart,
      end_date:                useEnd,
      guests:                  useGuests,
      status:                  'pre_reserved',
      expires_at:              expiresAt,
      source:                  'ai',
      customer_notes:          args.customer_notes ?? null,
      currency,
      price_currency:          currency,
      nightly_price_snapshot,
      nights_count:            nightsCount,
      subtotal_amount,
      fees_amount,
      total_amount,
      deposit_required_amount,
      pricing_mode_snapshot,
      pricing_breakdown,
    })
    .select('id')
    .single()

  if (error || !reservation) {
    console.error('[create_pending_reservation] insert failed', {
      tenantId,
      conversationId,
      errorMessage: error?.message,
      errorCode:    error?.code,
    })
    throw new Error(`Error al crear la reserva: ${error?.message ?? 'sin datos'}`)
  }

  // Best-effort: record ai_created event (service role — bypasses RLS)
  const { error: evtError } = await supabase
    .from('reservation_events')
    .insert({
      tenant_id:      tenantId,
      reservation_id: reservation.id,
      actor_id:       null,
      event_type:     'ai_created',
      metadata: {
        source:         'ai',
        start_date:     useStart,
        end_date:       useEnd,
        guests:         useGuests,
        total_amount:   total_amount,
        price_currency: currency,
      },
    })

  if (evtError) {
    console.error('[reservation-event] ai_created failed', {
      tenantId,
      reservationId: reservation.id,
      errorCode:     evtError.code,
      errorMessage:  evtError.message,
    })
  }

  // Mark draft as used so it can't be reused
  await supabase
    .from('conversation_reservation_drafts')
    .update({ status: 'used', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)

  // Flag conversation for human attention
  await supabase
    .from('conversations')
    .update({
      needs_human_attention:        true,
      human_attention_requested_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .eq('tenant_id', tenantId)

  const holdHours = Math.round(holdMinutes / 60)

  console.log('[reservation:create:success]', {
    tenantId,
    conversationId,
    reservationId: reservation.id,
    property:      property.title,
    startDate:     useStart,
    endDate:       useEnd,
    holdMinutes,
    usedDraft:     draftValid,
  })

  return JSON.stringify({
    success:        true,
    property_title: property.title,
    start_date:     useStart,
    end_date:       useEnd,
    guests:         useGuests,
    hold_hours:     holdHours,
  })
}

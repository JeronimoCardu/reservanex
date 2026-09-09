/**
 * Reglas de elegibilidad de alquiler temporal — acceso a la fuente canónica.
 *
 * Igual que pricing.shared.ts: acá NO hay reglas. Los umbrales y las
 * comparaciones viven una sola vez, en la función SQL
 * public.check_temporary_rental_eligibility (migración 20260912000001), y este
 * archivo es solo el typed wrapper.
 *
 * Antes de Fase 3E-A.2 cada writer aplicaba su propio subconjunto: la
 * creación manual y la reprogramación no verificaban estadía mínima ni
 * capacidad ni estado comercial, decide_operation_request tampoco verificaba
 * nada de eso, y create_pending_reservation —el writer real de la IA— leía
 * `capacity` de properties sin compararla nunca.
 *
 * Lo que sigue viviendo en TypeScript son los MENSAJES: cada camino le habla a
 * un interlocutor distinto (el cliente por WhatsApp, el asesor en el
 * dashboard). La regla es una; la redacción, de cada quien.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'

export type AppSupabase = SupabaseClient<Database>

export type IneligibleReason =
  | 'invalid_dates'
  | 'property_not_found'
  | 'property_not_available'
  | 'not_temporary_rental'
  | 'capacity_exceeded'
  | 'minimum_stay_not_met'
  | 'rpc_error'

export interface EligibleResult {
  eligible: true
  /** Las mismas noches que calcula quote_temporary_rental: end - start. */
  nights:              number
  minimum_stay_nights: number
  /** null = la propiedad no declara capacidad, así que no hay límite. */
  capacity:            number | null
}

export interface IneligibleResult {
  eligible: false
  reason:   IneligibleReason
  /** Presentes según el motivo. */
  commercial_status?:   string
  operation_type?:      string
  capacity?:            number
  requested_guests?:    number
  minimum_stay_nights?: number
  requested_nights?:    number
}

export type EligibilityResult = EligibleResult | IneligibleResult

/**
 * Verifica si una reserva de alquiler temporal puede existir para esa
 * propiedad, esas fechas y esa cantidad de huéspedes.
 *
 * `guests` opcional: si no se pasa, la regla de capacidad se saltea (es el
 * comportamiento que ya tenía check_property_availability, donde el LLM puede
 * no haber declarado la cantidad de personas todavía).
 *
 * No escribe nada — la función SQL es STABLE.
 */
export async function checkTemporaryRentalEligibility(
  supabase:   AppSupabase,
  tenantId:   string,
  propertyId: string,
  startStr:   string,        // YYYY-MM-DD
  endStr:     string,        // YYYY-MM-DD
  guests?:    number | null,
): Promise<EligibilityResult> {
  const { data, error } = await supabase.rpc('check_temporary_rental_eligibility', {
    p_tenant_id:   tenantId,
    p_property_id: propertyId,
    p_start:       startStr,
    p_end:         endStr,
    ...(guests === undefined || guests === null ? {} : { p_guests: guests }),
  })

  if (error || !data) {
    console.error('[eligibility] check_temporary_rental_eligibility failed', {
      tenantId,
      propertyId,
      errorCode:    error?.code,
      errorMessage: error?.message,
    })
    return { eligible: false, reason: 'rpc_error' }
  }

  return data as unknown as EligibilityResult
}

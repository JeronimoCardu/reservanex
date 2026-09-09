/**
 * Reglas de elegibilidad de alquiler temporal — acceso a la fuente canónica
 * desde apps/web.
 *
 * Igual que lib/pricing/quote-temporary-rental.ts: acá NO hay reglas. Viven una
 * sola vez en public.check_temporary_rental_eligibility (migración
 * 20260912000001). Este archivo llama a la RPC y tipa el resultado.
 *
 * El wrapper está duplicado entre worker y web porque apps/worker no tiene
 * dependencias de workspace en runtime (precedente lib/phone.ts). Es una
 * llamada RPC, no una regla: la lógica de negocio no se duplicó.
 *
 * Corre como el usuario autenticado (SECURITY INVOKER), así que las RLS de
 * properties acotan la verificación al tenant de la sesión.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'

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
  nights:              number
  minimum_stay_nights: number
  capacity:            number | null
}

export interface IneligibleResult {
  eligible: false
  reason:   IneligibleReason
  commercial_status?:   string
  operation_type?:      string
  capacity?:            number
  requested_guests?:    number
  minimum_stay_nights?: number
  requested_nights?:    number
}

export type EligibilityResult = EligibleResult | IneligibleResult

export async function checkTemporaryRentalEligibility(
  supabase:   SupabaseClient<Database>,
  tenantId:   string,
  propertyId: string,
  startStr:   string,
  endStr:     string,
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

/**
 * Mensaje para el asesor. Las reglas son las mismas que ve la IA; el texto es
 * distinto porque el interlocutor es distinto.
 */
export function eligibilityMessage(r: IneligibleResult): string {
  switch (r.reason) {
    case 'minimum_stay_not_met':
      return `Esta propiedad requiere una estadía mínima de ${r.minimum_stay_nights} ` +
             `noche${r.minimum_stay_nights === 1 ? '' : 's'} y la solicitud es de ` +
             `${r.requested_nights}.`
    case 'capacity_exceeded':
      return `La cantidad de huéspedes (${r.requested_guests}) supera la capacidad de la ` +
             `propiedad (${r.capacity}).`
    case 'property_not_available': {
      const labels: Record<string, string> = {
        rented: 'alquilada', paused: 'pausada', sold: 'vendida',
      }
      const label = labels[r.commercial_status ?? ''] ?? r.commercial_status ?? 'no disponible'
      return `La propiedad está ${label}, así que no acepta reservas.`
    }
    case 'not_temporary_rental':
      return r.operation_type === 'sale'
        ? 'La propiedad es de venta, no de alquiler temporal.'
        : 'La propiedad es de alquiler tradicional, no de alquiler temporal.'
    case 'property_not_found':
      return 'La propiedad ya no existe.'
    case 'invalid_dates':
      return 'Las fechas no son válidas.'
    case 'rpc_error':
      return 'No pudimos verificar las reglas de la propiedad. Probá de nuevo.'
  }
}

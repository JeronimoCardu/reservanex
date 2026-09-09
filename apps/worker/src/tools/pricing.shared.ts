/**
 * Pricing de alquiler temporal — acceso al motor canónico.
 *
 * IMPORTANTE: acá NO hay ninguna fórmula. La aritmética vive en un solo lugar,
 * la función SQL public.quote_temporary_rental (migración 20260911000001), y
 * este archivo es únicamente el typed wrapper que la llama.
 *
 * Antes de Fase 3E-A.1 la misma fórmula estaba copiada cuatro veces en
 * TypeScript (los dos tools de este directorio y dos server actions de
 * apps/web) y no existía en el camino de formulario, que dejaba todos los
 * importes en NULL. Se movió a SQL porque es el único lugar que alcanzan los
 * dos apps Y la transacción de decide_operation_request: apps/worker no tiene
 * dependencias de workspace en runtime, así que un módulo TS compartido con
 * apps/web habría vuelto a ser una copia.
 *
 * Si hay que cambiar cómo se calcula un precio, se cambia la función SQL. Este
 * archivo no debería necesitar tocarse.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'

export type AppSupabase = SupabaseClient<Database>

export type PricingMode = 'fixed' | 'consult'

/** Valores tal como los devuelve el motor. NULL significa "precio desconocido". */
export interface TemporaryRentalQuote {
  ok:            true
  pricing_mode:  PricingMode
  currency:      string
  nights:        number
  nightly_price: number | null
  subtotal:      number | null
  /** Nunca null: reservations.fees_amount es NOT NULL DEFAULT 0. */
  fees:          number
  total:         number | null
  deposit:       number | null
  breakdown:     { [key: string]: number | string | null | boolean }
}

export interface TemporaryRentalQuoteFailure {
  ok:     false
  reason: 'invalid_dates' | 'property_not_found' | 'rpc_error'
}

export type TemporaryRentalQuoteResult = TemporaryRentalQuote | TemporaryRentalQuoteFailure

/**
 * Cotiza un rango para una propiedad. No escribe nada (la función SQL es
 * STABLE), así que cotizar es seguro de repetir.
 *
 * `ok: false` es una falla real, no un "sin precio": una propiedad en modo
 * consult devuelve ok:true con los importes en null.
 */
export async function quoteTemporaryRental(
  supabase:   AppSupabase,
  tenantId:   string,
  propertyId: string,
  startStr:   string,   // YYYY-MM-DD
  endStr:     string,   // YYYY-MM-DD
): Promise<TemporaryRentalQuoteResult> {
  const { data, error } = await supabase.rpc('quote_temporary_rental', {
    p_tenant_id:   tenantId,
    p_property_id: propertyId,
    p_start:       startStr,
    p_end:         endStr,
  })

  if (error || !data) {
    console.error('[pricing] quote_temporary_rental failed', {
      tenantId,
      propertyId,
      errorCode:    error?.code,
      errorMessage: error?.message,
    })
    return { ok: false, reason: 'rpc_error' }
  }

  return data as unknown as TemporaryRentalQuoteResult
}

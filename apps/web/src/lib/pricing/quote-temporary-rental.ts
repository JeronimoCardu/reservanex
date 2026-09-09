/**
 * Pricing de alquiler temporal — acceso al motor canónico desde apps/web.
 *
 * Igual que apps/worker/src/tools/pricing.shared.ts: acá NO hay fórmula. La
 * aritmética existe una sola vez, en public.quote_temporary_rental
 * (migración 20260911000001). Este archivo solo llama a la RPC y tipa el
 * resultado.
 *
 * Las dos copias del wrapper (worker y web) son inevitables —apps/worker no
 * tiene dependencias de workspace en runtime, precedente lib/phone.ts— pero
 * son wrappers, no reglas de negocio: duplicar una llamada RPC no crea una
 * segunda fuente de verdad. La regla que antes estaba duplicada (noches ×
 * tarifa + limpieza, seña por monto o porcentaje) ya no está en TypeScript.
 *
 * La RPC corre como el usuario autenticado (SECURITY INVOKER), así que las RLS
 * de properties acotan la cotización al tenant de la sesión.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'

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

export async function quoteTemporaryRental(
  supabase:   SupabaseClient<Database>,
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

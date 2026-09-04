'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/require-owner'
import { createClient } from '@orderflow/supabase/server'
import type { ActionResult } from '@/lib/action-result'

// UI works in hours; DB stores minutes.
const reservationSettingsSchema = z.object({
  hold_hours: z.coerce
    .number()
    .int('Debe ser un número entero de horas.')
    .min(1,   'Mínimo 1 hora.')
    .max(168, 'Máximo 7 días (168 horas).'),
})

export type ReservationSettingsData = {
  hold_hours: number
}

export async function getReservationSettingsAction(): Promise<ActionResult<ReservationSettingsData>> {
  const { tenantId } = await requireOwner()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('ai_settings')
    .select('pending_reservation_hold_minutes')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error) return { success: false, error: error.message }

  const minutes = data?.pending_reservation_hold_minutes ?? 1440
  return {
    success: true,
    data: { hold_hours: Math.round(minutes / 60) },
  }
}

export async function updateReservationSettingsAction(
  input: unknown,
): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  const parsed = reservationSettingsSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const minutes = parsed.data.hold_hours * 60
  const supabase = await createClient()

  // upsert: creates row if missing, updates if exists.
  // onConflict on the unique tenant_id column handles both cases.
  const { error } = await supabase
    .from('ai_settings')
    .upsert(
      { tenant_id: tenantId, pending_reservation_hold_minutes: minutes },
      { onConflict: 'tenant_id' },
    )

  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/settings/reservations')
  return { success: true }
}

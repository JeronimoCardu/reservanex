'use server'

import { createClient } from '@orderflow/supabase/server'
import type { ActionResult } from '@/lib/action-result'

export async function resendConfirmationEmailAction(): Promise<ActionResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.email) {
    return { success: false, error: 'No hay sesión activa.' }
  }

  if (user.email_confirmed_at) {
    return { success: false, error: 'Tu email ya está confirmado.' }
  }

  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: user.email,
  })

  if (error) {
    return { success: false, error: 'No se pudo reenviar el email. Intentá de nuevo.' }
  }

  return { success: true }
}

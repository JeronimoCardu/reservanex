// ════════════════════════════════════════════════════════════════════════════
// Envío de email transaccional propio (no los de Supabase Auth).
//
// Resend ya es dependencia de apps/web (formulario de contacto de marketing).
// Acá se envuelve detrás de una interfaz mínima para que quien lo use pueda
// recibir OTRO sender —en tests y validators físicos, uno que registra en vez
// de mandar— sin que ningún test automático pueda disparar un email real.
// ════════════════════════════════════════════════════════════════════════════

export interface OutgoingEmail {
  to:      string[]
  subject: string
  html:    string
  text:    string
}

export type SendEmailResult =
  | { ok: true;  id: string | null }
  | { ok: false; reason: 'not_configured' | 'provider_error' | 'threw'; detail?: string }

export interface EmailSender {
  send(email: OutgoingEmail): Promise<SendEmailResult>
}

const DEFAULT_FROM = 'ReservaNex <notificaciones@reservanex.com>'

export function isTransactionalEmailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim())
}

/**
 * El sender real. Import dinámico de `resend` (igual que marketing/contact.ts)
 * para no cargarlo en rutas que nunca envían.
 */
export function createResendEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  return {
    async send(email) {
      const apiKey = env.RESEND_API_KEY?.trim()
      if (!apiKey) return { ok: false, reason: 'not_configured' }

      try {
        const { Resend } = await import('resend')
        const resend = new Resend(apiKey)
        const { data, error } = await resend.emails.send({
          from:    env.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM,
          to:      email.to,
          subject: email.subject,
          html:    email.html,
          text:    email.text,
        })
        if (error) return { ok: false, reason: 'provider_error', detail: error.message }
        return { ok: true, id: data?.id ?? null }
      } catch (err) {
        return { ok: false, reason: 'threw', detail: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

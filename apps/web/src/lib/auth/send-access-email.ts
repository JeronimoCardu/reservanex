import { renderInvitationEmail, type InvitationRole } from '@/lib/email/invitation-email'
import {
  createResendEmailSender,
  isTransactionalEmailConfigured,
  type EmailSender,
  type SendEmailResult,
} from '@/lib/email/send-email'
import type { AccessLinkKind } from './issue-access-link'

// ════════════════════════════════════════════════════════════════════════════
// Entregar el email de acceso que ReservaNex arma (y ya no Supabase).
//
// Se llama DESPUÉS de persistir platform_users / tenant_users: si el email
// sale primero y la fila falla después, el destinatario recibe un link para
// una cuenta que ReservaNex no terminó de preparar.
//
// Nunca lanza: devuelve el resultado para que quien llama decida si avisa. Un
// email que no salió no debe deshacer un usuario que sí quedó creado — el
// reenvío existe justamente para eso.
//
// La URL es un secreto: no se loguea ni se devuelve en el resultado.
// ════════════════════════════════════════════════════════════════════════════

export interface SendAccessEmailParams {
  to:             string
  role:           InvitationRole
  kind:           AccessLinkKind
  accessUrl:      string
  businessName?:  string | null
  recipientName?: string | null
  /** Inyectable para tests y validators: por defecto, Resend. */
  sender?:        EmailSender
}

export async function sendAccessEmail(params: SendAccessEmailParams): Promise<SendEmailResult> {
  const { to, role, kind, accessUrl, businessName, recipientName } = params

  if (!params.sender && !isTransactionalEmailConfigured()) {
    console.error('[access-email] RESEND_API_KEY ausente — no se envió el acceso', { to, role, kind })
    return { ok: false, reason: 'not_configured' }
  }

  const sender = params.sender ?? createResendEmailSender()
  const email  = renderInvitationEmail({ role, kind, businessName, recipientName, accessUrl })

  const result = await sender.send({
    to:      [to],
    subject: email.subject,
    html:    email.html,
    text:    email.text,
  })

  if (result.ok) {
    console.log('[access-email] enviado', { to, role, kind, providerId: result.id })
  } else {
    console.error('[access-email] falló el envío', { to, role, kind, reason: result.reason, detail: result.detail })
  }

  return result
}
